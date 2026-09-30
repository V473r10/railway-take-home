import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONTAINER_LIFETIME_MS, MISSING_MESSAGE, MISSING_SWEEP_MS } from "../src/server/containers.ts";
import { SERVICE_NAME_PREFIX } from "../src/server/railway/adapter.ts";
import { action, type ContainerBody, type CreateBody, create, eventually, type Harness, list, startHarness } from "./harness.ts";

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.close();
});

async function find(id: string): Promise<ContainerBody | undefined> {
  return (await list(h)).find((c) => c.id === id);
}

/** Create a container and bring it to running, the way Railway would report it. */
async function running(): Promise<{ id: string; serviceId: string }> {
  const body = (await (await create(h)).json()) as CreateBody;
  await h.settled();
  const serviceId = (await find(body.container.id))?.serviceId ?? "";
  const deploymentId = h.railway.services.get(serviceId)?.deploymentId;
  // Observed once, so the state set below reaches the observer as a change.
  await eventually(() => h.railway.callsTo("readDeployment").some((c) => c.deploymentId === deploymentId));
  h.railway.setDeployment(serviceId, "SUCCESS");
  await eventually(async () => (await find(body.container.id))?.state === "running");
  return { id: body.container.id, serviceId };
}

describe("crashed", () => {
  it("shows crashed, not failed, when Railway reports CRASHED after running", async () => {
    const { id, serviceId } = await running();
    h.railway.setDeployment(serviceId, "CRASHED");
    await eventually(async () => (await find(id))?.state === "crashed");

    const c = await find(id);
    expect(c?.lastError).toBeNull();
    // Start redeploys it; Destroy removes it.
    expect(c?.actions.start).toEqual({ allowed: true });
    expect(c?.actions.stop.allowed).toBe(false);
    expect(c?.actions.destroy).toEqual({ allowed: true });
  });

  it("shows failed when the deployment crashes before the Create completes", async () => {
    const body = (await (await create(h)).json()) as CreateBody;
    await h.settled();
    const serviceId = (await find(body.container.id))?.serviceId ?? "";
    const deploymentId = h.railway.services.get(serviceId)?.deploymentId;
    await eventually(() => h.railway.callsTo("readDeployment").some((c) => c.deploymentId === deploymentId));
    h.railway.setDeployment(serviceId, "CRASHED");
    await eventually(async () => (await find(body.container.id))?.state === "failed");

    // Reading the same crash again later is not news: the Create's failure still explains it.
    h.clock.advance(60_000);
    h.railway.dropSubscriptions();
    await eventually(() => h.clock.sleepers === 1);
    h.clock.advance(60_000);
    await eventually(() => h.railway.callsTo("readDeployment").filter((c) => c.deploymentId === deploymentId).length >= 2);
    await h.settled();
    expect((await find(body.container.id))?.state).toBe("failed");
  });

  it("shows crashed when the crash comes after a failed operation", async () => {
    const { id, serviceId } = await running();
    h.railway.failNextOn("stopDeployment", { kind: "rejected", message: "no" });
    await action(h, id, "stop");
    await h.settled();
    expect((await find(id))?.state).toBe("failed");

    h.clock.advance(1_000);
    h.railway.setDeployment(serviceId, "CRASHED");
    await eventually(async () => (await find(id))?.state === "crashed");
  });
});

describe("missing", () => {
  it("shows missing once the service is deleted outside the app, and only reads Railway", async () => {
    const { id, serviceId } = await running();
    h.railway.deleteOutsideApp(serviceId);
    await eventually(async () => (await find(id))?.state === "missing");
    await h.settled();

    const c = await find(id);
    expect(c?.url).toBeNull();
    expect(c?.actions.stop).toEqual({ allowed: false, reason: MISSING_MESSAGE });
    expect(c?.actions.start).toEqual({ allowed: false, reason: MISSING_MESSAGE });
    expect(c?.actions.destroy).toEqual({ allowed: true });
    // Railway is the truth: nothing is recreated.
    expect(h.railway.callsTo("createContainer")).toHaveLength(1);
    expect(h.railway.callsTo("redeployService")).toHaveLength(0);
  });

  it("finds a deletion the observer was never told about, on the periodic sweep", async () => {
    const { id, serviceId } = await running();
    // No subscription is open to hear the deployment go away.
    h.railway.refuseSubscriptions();
    h.railway.dropSubscriptions();
    h.railway.services.delete(serviceId);

    h.clock.advance(MISSING_SWEEP_MS);
    await eventually(async () => (await find(id))?.state === "missing");
  });

  it("finds a service deleted while the app was down, at startup", async () => {
    const { id, serviceId } = await running();
    await h.restart((railway) => railway.deleteOutsideApp(serviceId));
    await h.settled();
    expect((await find(id))?.state).toBe("missing");
  });

  it("concludes nothing when the service list cannot be read", async () => {
    const { id, serviceId } = await running();
    h.railway.failNextOn("listServices", { kind: "ambiguous_before_acting" });
    h.railway.deleteOutsideApp(serviceId);
    await h.settled();
    expect((await find(id))?.state).not.toBe("missing");

    h.clock.advance(MISSING_SWEEP_MS);
    await eventually(async () => (await find(id))?.state === "missing");
  });

  it("fails an operation in flight when its service goes missing", async () => {
    const { id, serviceId } = await running();
    await action(h, id, "stop");
    await h.settled();
    expect((await find(id))?.state).toBe("stopping");

    h.railway.deleteOutsideApp(serviceId);
    await eventually(async () => (await find(id))?.state === "missing");
    await h.settled();
    const c = await find(id);
    expect(c?.lastError).toBeNull();
    expect(c?.actions.start).toEqual({ allowed: false, reason: MISSING_MESSAGE });
    const { rows } = await h.db.query<{ status: string }>("SELECT status FROM operations WHERE container_id = $1 AND kind = 'stop'", [id]);
    expect(rows.map((r) => r.status)).toEqual(["failed"]);
  });

  it("destroys a missing container without asking Railway to delete anything", async () => {
    const { id, serviceId } = await running();
    h.railway.deleteOutsideApp(serviceId);
    await eventually(async () => (await find(id))?.state === "missing");

    expect((await action(h, id, "destroy")).status).toBe(202);
    await h.settled();
    expect(await list(h)).toEqual([]);
    expect(h.railway.callsTo("deleteService")).toHaveLength(0);
  });

  it("does not mark a service missing while it still exists", async () => {
    const { id } = await running();
    h.clock.advance(MISSING_SWEEP_MS * 3);
    await h.settled();
    expect(h.railway.callsTo("listServices").length).toBeGreaterThan(0);
    expect((await find(id))?.state).toBe("running");
  });
});

describe("services the app did not create", () => {
  it("never lists nor destroys a prefixed service with no row, even past the lifetime", async () => {
    const foreign = h.railway.addServiceOutsideApp(`${SERVICE_NAME_PREFIX}00000000-0000-4000-8000-000000000000`);
    const { id } = await running();
    expect((await list(h)).map((c) => c.id)).toEqual([id]);

    h.clock.advance(CONTAINER_LIFETIME_MS);
    await h.settled();
    expect(await list(h)).toEqual([]);
    expect(h.railway.callsTo("deleteService").map((c) => c.serviceId)).not.toContain(foreign);
    expect(h.railway.services.has(foreign)).toBe(true);
  });

  it("does not adopt a prefixed service with no row after a restart", async () => {
    const foreign = h.railway.addServiceOutsideApp(`${SERVICE_NAME_PREFIX}someone-else`);
    await h.restart();
    await h.settled();
    expect(await list(h)).toEqual([]);
    expect(h.railway.services.has(foreign)).toBe(true);
    expect(h.railway.calls.filter((c) => c.method !== "listServices" && c.method !== "findService")).toEqual([]);
  });
});
