import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FakeMutation, InjectedFailure } from "../src/server/railway/fake.ts";
import { type ContainerBody, type CreateBody, action, create, eventually, type Harness, list, startHarness, railwayStops } from "./harness.ts";

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.close();
});

type ListBody = { containers: ContainerBody[]; readOnly: { reason: string } | null };

const WRITES: FakeMutation[] = ["createContainer", "createDomain", "stopDeployment", "redeployService", "deleteService"];

async function listBody(): Promise<ListBody> {
  return (await (await h.request("/api/containers")).json()) as ListBody;
}

async function stateOf(id: string): Promise<string | undefined> {
  return (await list(h)).find((c) => c.id === id)?.state;
}

/** Create a container and bring it to running, the way Railway would. */
async function running(): Promise<{ id: string; serviceId: string }> {
  const reads = h.railway.callsTo("readDeployment").length;
  const body = (await (await create(h)).json()) as CreateBody;
  await h.settled();
  const serviceId = [...h.railway.services.keys()].at(-1) ?? "";
  await eventually(() => h.railway.callsTo("readDeployment").length > reads);
  h.railway.setDeployment(serviceId, "SUCCESS");
  await eventually(async () => (await stateOf(body.container.id)) === "running");
  return { id: body.container.id, serviceId };
}

async function operationCount(): Promise<number> {
  const { rows } = await h.db.query<{ n: number }>("SELECT count(*)::int AS n FROM operations");
  return rows[0]?.n ?? 0;
}

function writesToRailway(): number {
  return WRITES.reduce((n, method) => n + h.railway.callsTo(method).length, 0);
}

describe("identity check at startup", () => {
  it("with a confirmed identity, allows every operation", async () => {
    expect((await listBody()).readOnly).toBeNull();

    const { id, serviceId } = await running();
    expect((await action(h, id, "stop")).status).toBe(202);
    await h.settled();
    await railwayStops(h, serviceId);
    await eventually(async () => (await stateOf(id)) === "stopped");
    expect((await action(h, id, "start")).status).toBe(202);
    await h.settled();
    expect((await action(h, id, "destroy")).status).toBe(202);
    await h.settled();
    expect(await list(h)).toEqual([]);
  });

  it.each<[string, InjectedFailure]>([
    ["refuses", { kind: "rejected", message: "Not Authorized" }],
    ["does not answer", { kind: "ambiguous_before_acting" }],
    ["rate-limits the check", { kind: "rate_limited", retryAfterMs: 1000 }],
  ])("keeps serving in read-only mode when Railway %s", async (_, failure) => {
    await h.restart((railway) => railway.failNextOn("verifyIdentity", failure));

    const body = await listBody();
    expect(body.containers).toEqual([]);
    expect(body.readOnly?.reason).toMatch(/could not confirm who its Railway token belongs to/);
    const res = await create(h);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe(body.readOnly?.reason);
  });
});

describe("read-only mode", () => {
  it("refuses create, stop, start and destroy before recording anything, and still lists", async () => {
    const up = await running();
    const down = await running();
    await action(h, down.id, "stop");
    await h.settled();
    await railwayStops(h, down.serviceId);
    await eventually(async () => (await stateOf(down.id)) === "stopped");

    await h.restart((railway) => railway.failNextOn("verifyIdentity", { kind: "rejected", message: "Not Authorized" }));
    const operations = await operationCount();
    const writes = writesToRailway();

    const refusals = [
      await create(h),
      await action(h, up.id, "stop"),
      await action(h, down.id, "start"),
      await action(h, up.id, "destroy"),
      await action(h, down.id, "destroy"),
    ];
    for (const res of refusals) {
      expect(res.status).toBe(503);
      expect(((await res.json()) as { error: string }).error).toMatch(/^Read-only mode: .*Not Authorized/);
    }
    await h.settled();
    expect(await operationCount()).toBe(operations);
    expect(writesToRailway()).toBe(writes);

    const body = await listBody();
    expect(body.readOnly?.reason).toMatch(/Not Authorized/);
    // Same creation time on the manual clock, so the list order between the two is by id.
    expect(Object.fromEntries(body.containers.map((c) => [c.id, c.state]))).toEqual({ [up.id]: "running", [down.id]: "stopped" });
    for (const c of body.containers) {
      for (const availability of Object.values(c.actions)) expect(availability).toEqual({ allowed: false, reason: body.readOnly?.reason });
    }
  });

  it("leaves an operation a previous process left active untouched until a restart with a good token", async () => {
    h.dieOn("createContainer", "after_acting");
    expect((await create(h)).status).toBe(202);
    await eventually(() => h.dead);

    await h.restart((railway) => railway.failNextOn("verifyIdentity", { kind: "rejected", message: "Not Authorized" }));
    await h.settled();
    // Resuming would mean writing to Railway, so the Create waits; not even its name lookup runs.
    expect(h.railway.callsTo("findService")).toEqual([]);
    expect(writesToRailway()).toBe(1);
    const { rows } = await h.db.query<{ status: string }>("SELECT status FROM operations");
    expect(rows.map((r) => r.status)).not.toContain("failed");

    await h.restart();
    await h.settled();
    expect(h.railway.callsTo("createContainer")).toHaveLength(1);
    expect(h.railway.services.size).toBe(1);
  });

  it("tells a browser tab in the snapshot, and the stream keeps working", async () => {
    const { id, serviceId } = await running();
    await h.restart((railway) => railway.failNextOn("verifyIdentity", { kind: "ambiguous_before_acting" }));

    const tab = await h.events();
    const snapshot = await tab.next((e) => e.type === "snapshot");
    expect(snapshot.type === "snapshot" && snapshot.readOnly?.reason).toMatch(/Railway did not answer/);

    // Railway still moves the container on its own; the tab still hears about it.
    await eventually(() => h.railway.openSubscriptions === 1);
    h.railway.setDeployment(serviceId, "CRASHED");
    const change = await tab.next((e) => e.type === "upsert" && e.container.id === id && e.container.state === "crashed");
    expect(change.type === "upsert" && change.container.actions.destroy.allowed).toBe(false);
  });
});
