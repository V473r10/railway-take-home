import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ContainerBody, type CreateBody, action, create, eventually, type Harness, list, startHarness } from "./harness.ts";

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.close();
});

type ActionBody = { operation: { id: string; kind: string; status: string }; container: ContainerBody | null };

/** Create a container and bring it to running, the way Railway would. */
async function running(): Promise<{ id: string; serviceId: string }> {
  const body = (await (await create(h)).json()) as CreateBody;
  await h.settled();
  await eventually(() => h.railway.openSubscriptions === 1 && h.railway.callsTo("readDeployment").length === 1);
  const serviceId = [...h.railway.services.keys()].at(-1) ?? "";
  h.railway.setDeployment(serviceId, "SUCCESS");
  await eventually(async () => (await list(h))[0]?.state === "running");
  return { id: body.container.id, serviceId };
}

describe("destroying a container", () => {
  it("deletes the service once and removes the container from the list over SSE", async () => {
    const tab = await h.events();
    const { id, serviceId } = await running();

    const res = await action(h, id, "destroy");
    expect(res.status).toBe(202);
    expect(((await res.json()) as ActionBody).container?.state).toBe("destroying");
    await h.settled();

    await tab.next((e) => e.type === "remove" && e.id === id);
    expect(await list(h)).toEqual([]);
    expect(h.railway.callsTo("deleteService")).toEqual([{ method: "deleteService", serviceId }]);
    expect(h.railway.services.has(serviceId)).toBe(false);
    expect(h.railway.openSubscriptions).toBe(0);
  });

  it("is accepted during an active Create, and the container ends destroyed", async () => {
    const release = h.railway.hold();
    const body = (await (await create(h)).json()) as CreateBody;
    expect(body.container.actions.destroy).toEqual({ allowed: true });

    // Railway has not answered serviceCreate yet.
    const res = await action(h, body.container.id, "destroy");
    expect(res.status).toBe(202);
    release();
    await h.settled();

    // The service Railway created is the one deleted; nothing is left behind or watched.
    const [created] = h.railway.callsTo("createContainer");
    expect(created).toBeDefined();
    expect(h.railway.callsTo("deleteService")).toHaveLength(1);
    expect(h.railway.services.size).toBe(0);
    expect(h.railway.callsTo("createDomain")).toHaveLength(0);
    expect(h.railway.openSubscriptions).toBe(0);
    expect(await list(h)).toEqual([]);

    const { rows } = await h.db.query<{ kind: string; status: string; last_error: string | null }>(
      "SELECT kind, status, last_error FROM operations WHERE container_id = $1 ORDER BY seq",
      [body.container.id],
    );
    expect(rows).toEqual([
      { kind: "create", status: "failed", last_error: "Superseded by Destroy." },
      { kind: "destroy", status: "succeeded", last_error: null },
    ]);
  });

  it("is accepted during an active Stop", async () => {
    const { id } = await running();
    await action(h, id, "stop");

    expect((await action(h, id, "destroy")).status).toBe(202);
    await h.settled();
    expect(await list(h)).toEqual([]);
  });

  it("turns the same Destroy sent twice into one operation, even after the container is gone", async () => {
    const { id } = await running();

    const first = await action(h, id, "destroy", "destroy-click");
    await h.settled();
    const second = await action(h, id, "destroy", "destroy-click");

    expect(first.status).toBe(202);
    expect(second.status).toBe(200);
    const [a, b] = (await Promise.all([first.json(), second.json()])) as ActionBody[];
    expect(b?.operation.id).toBe(a?.operation.id);
    expect(b?.container).toBeNull();
    expect(h.railway.callsTo("deleteService")).toHaveLength(1);
  });

  it("refuses a second Destroy while one is active", async () => {
    const { id } = await running();
    h.railway.failNextOn("deleteService", { kind: "ambiguous_before_acting" });
    await action(h, id, "destroy");
    await h.settled();

    const res = await action(h, id, "destroy");
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("The container is already being destroyed.");
  });

  it("refuses Stop and Start while Destroy is active", async () => {
    const { id } = await running();
    h.railway.failNextOn("deleteService", { kind: "ambiguous_before_acting" });
    await action(h, id, "destroy");
    await h.settled();

    const [container] = await list(h);
    expect(container?.state).toBe("destroying");
    expect(container?.actions.stop).toEqual({ allowed: false, reason: "Wait for Destroy to finish." });
    expect((await action(h, id, "stop")).status).toBe(409);
  });

  it("answers 404 for a container that is already destroyed", async () => {
    const { id } = await running();
    await action(h, id, "destroy");
    await h.settled();

    expect((await action(h, id, "destroy")).status).toBe(404);
    expect((await action(h, id, "stop")).status).toBe(404);
  });

  it("keeps a container Railway refused to delete, shows the error and lets the user try again", async () => {
    const { id } = await running();
    h.railway.failNextOn("deleteService", { kind: "rejected", message: "Service is locked", traceId: "trace-7" });

    await action(h, id, "destroy");
    await h.settled();

    const [container] = await list(h);
    expect(container).toMatchObject({ id, state: "failed", lastError: { message: "Service is locked", traceId: "trace-7" } });
    expect(container?.actions.destroy).toEqual({ allowed: true });
    // Still observed: Railway's state keeps reaching the container.
    await eventually(() => h.railway.openSubscriptions === 1);

    expect((await action(h, id, "destroy")).status).toBe(202);
    await h.settled();
    expect(await list(h)).toEqual([]);
  });
});
