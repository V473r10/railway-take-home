import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ContainerBody, type CreateBody, action, create, eventually, type Harness, type LiveEvent, list, startHarness, railwayStops } from "./harness.ts";

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.close();
});

type ActionBody = { operation: { id: string; kind: string; status: string }; container: ContainerBody };

const upsert =
  (id: string, state: string) =>
  (e: LiveEvent): boolean =>
    e.type === "upsert" && e.container.id === id && e.container.state === state;

async function stateOf(id: string): Promise<string | undefined> {
  return (await list(h)).find((c) => c.id === id)?.state;
}

/** Create a container and bring it to running, the way Railway would. */
async function running(): Promise<{ id: string; serviceId: string }> {
  const body = (await (await create(h)).json()) as CreateBody;
  await h.settled();
  await eventually(() => h.railway.openSubscriptions === 1 && h.railway.callsTo("readDeployment").length === 1);
  const serviceId = [...h.railway.services.keys()].at(-1) ?? "";
  h.railway.setDeployment(serviceId, "SUCCESS");
  await eventually(async () => (await stateOf(body.container.id)) === "running");
  return { id: body.container.id, serviceId };
}

async function stopped(): Promise<{ id: string; serviceId: string }> {
  const c = await running();
  await action(h, c.id, "stop");
  await h.settled();
  await railwayStops(h, c.serviceId);
  await eventually(async () => (await stateOf(c.id)) === "stopped");
  return c;
}

async function currentDeploymentId(containerId: string): Promise<string | null> {
  const { rows } = await h.db.query<{ current_deployment_id: string | null }>("SELECT current_deployment_id FROM containers WHERE id = $1", [
    containerId,
  ]);
  return rows[0]?.current_deployment_id ?? null;
}

describe("a container whose public domain was refused", () => {
  // Found by the simulation (seed 66): Railway refused the domain during the create, a
  // later Start brought the container up, and it showed running with no URL.
  it("gets its domain on the next Start instead of running without a URL", async () => {
    h.railway.failNextOn("createDomain", { kind: "rejected", message: "sim: no domain for you" });
    const body = (await (await create(h)).json()) as CreateBody;
    const id = body.container.id;
    await h.settled();
    await eventually(() => h.railway.callsTo("readDeployment").length === 1);
    const serviceId = [...h.railway.services.keys()].at(-1) ?? "";
    h.railway.setDeployment(serviceId, "SUCCESS");
    await eventually(async () => (await stateOf(id)) === "failed");
    expect((await list(h))[0]?.url).toBeNull();
    // The Create fails before the observer stores the deployment; a Stop sent in between
    // has nothing to stop (seen on loaded CI runners).
    await eventually(async () => {
      const { entries } = (await (await h.request(`/api/containers/${id}/timeline`)).json()) as { entries: { kind: string; status?: string }[] };
      return entries.some((e) => e.kind === "observed" && e.status === "SUCCESS");
    });

    expect((await action(h, id, "stop")).status).toBe(202);
    await h.settled();
    await railwayStops(h, serviceId);
    await eventually(async () => (await stateOf(id)) === "stopped");
    expect((await action(h, id, "start")).status).toBe(202);
    await h.settled();
    h.railway.setDeployment(serviceId, "SUCCESS");
    await eventually(async () => (await stateOf(id)) === "running");

    const [container] = await list(h);
    expect(container?.url).toBe(`https://${container?.name}.up.railway.app`);
    expect(h.railway.callsTo("createDomain")).toHaveLength(2);
  });
});

describe("stopping and starting a container", () => {
  it("goes running, stopping, stopped, starting, running", async () => {
    const tab = await h.events();
    const { id, serviceId } = await running();

    const stop = await action(h, id, "stop");
    expect(stop.status).toBe(202);
    expect(((await stop.json()) as ActionBody).container.state).toBe("stopping");
    await tab.next(upsert(id, "stopping"));
    await h.settled();
    const [first] = h.railway.callsTo("stopDeployment");
    expect(first?.deploymentId).toBe(h.railway.services.get(serviceId)?.deploymentId);

    await railwayStops(h, serviceId);
    await tab.next(upsert(id, "stopped"));

    expect((await action(h, id, "start")).status).toBe(202);
    await tab.next(upsert(id, "starting"));
    await h.settled();
    h.railway.setDeployment(serviceId, "SUCCESS");
    // Only the events after Start count: each change is read from the database when it is
    // sent, so a busy machine can send the first running state more than once.
    const startedAt = tab.events.findIndex(upsert(id, "starting"));
    const runningAgain = () =>
      tab.events.slice(startedAt).filter(upsert(id, "running")) as Extract<LiveEvent, { type: "upsert" }>[];
    await eventually(() => runningAgain().length > 0);
    expect(runningAgain()[0]?.container.url).toMatch(/^https:\/\//);
  });

  it("tracks the new deployment after Start", async () => {
    const { id, serviceId } = await stopped();
    const before = await currentDeploymentId(id);

    await action(h, id, "start");
    await h.settled();

    const after = h.railway.services.get(serviceId)?.deploymentId;
    expect(after).not.toBe(before);
    expect(await currentDeploymentId(id)).toBe(after);
    // The observer now watches the new deployment, so its success completes the Start.
    await eventually(() => h.railway.callsTo("watchDeployment").at(-1)?.deploymentId === after);
    h.railway.setDeployment(serviceId, "SUCCESS");
    await eventually(async () => (await stateOf(id)) === "running");
  });

  it("waits for Railway to list the new deployment instead of tracking the replaced one", async () => {
    const { id, serviceId } = await stopped();
    const replaced = await currentDeploymentId(id);
    h.railway.lagNewDeployments(2);

    await action(h, id, "start");
    // Two lookups still see the replaced deployment; each is followed by a wait.
    await eventually(() => h.clock.sleepers === 1 && h.railway.callsTo("latestDeployment").length >= 2);
    h.clock.advance(1_000);
    await eventually(() => h.clock.sleepers === 1 && h.railway.callsTo("latestDeployment").length >= 3);
    expect(await currentDeploymentId(id)).toBeNull();
    h.clock.advance(2_000);
    await h.settled();

    const current = await currentDeploymentId(id);
    expect(current).not.toBe(replaced);
    expect(current).toBe(h.railway.services.get(serviceId)?.deploymentId);
    expect(await stateOf(id)).toBe("starting");
  });

  it("refuses Stop while Create is active, with a clear message", async () => {
    const release = h.railway.hold();
    const body = (await (await create(h)).json()) as CreateBody;
    expect(body.container.actions.stop).toEqual({ allowed: false, reason: "Wait for Create to finish." });

    const res = await action(h, body.container.id, "stop");
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("Wait for Create to finish.");
    release();
    await h.settled();
    expect(h.railway.callsTo("stopDeployment")).toHaveLength(0);
  });

  it("refuses Start while Stop is active", async () => {
    const { id } = await running();
    await action(h, id, "stop");

    const res = await action(h, id, "start");
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("Wait for Stop to finish.");
  });

  it("lets only one of two concurrent Stops through", async () => {
    const { id } = await running();

    const responses = await Promise.all([action(h, id, "stop"), action(h, id, "stop")]);
    await h.settled();

    expect(responses.map((r) => r.status).sort()).toEqual([202, 409]);
    expect(h.railway.callsTo("stopDeployment")).toHaveLength(1);
  });

  it("turns the same Stop sent twice into one operation", async () => {
    const { id } = await running();

    const first = await action(h, id, "stop", "stop-click-1");
    const second = await action(h, id, "stop", "stop-click-1");
    await h.settled();

    expect(first.status).toBe(202);
    expect(second.status).toBe(200);
    const [a, b] = (await Promise.all([first.json(), second.json()])) as ActionBody[];
    expect(b?.operation.id).toBe(a?.operation.id);
    expect(h.railway.callsTo("stopDeployment")).toHaveLength(1);
  });

  it("refuses a key already used for another action", async () => {
    const { id } = await running();
    await action(h, id, "stop", "reused-key-1");
    await h.settled();
    await railwayStops(h, [...h.railway.services.keys()][0] ?? "");
    await eventually(async () => (await stateOf(id)) === "stopped");

    expect((await action(h, id, "start", "reused-key-1")).status).toBe(422);
  });

  it("guarantees one active operation per container in the database itself", async () => {
    const { id } = await running();
    await action(h, id, "stop");

    const now = new Date();
    await expect(
      h.db.query(
        `INSERT INTO operations (id, container_id, kind, status, idempotency_key, created_at, updated_at)
         VALUES ($1, $2, 'start', 'pending', $3, $4, $4)`,
        [randomUUID(), id, randomUUID(), now],
      ),
    ).rejects.toMatchObject({ code: "23505", constraint: "operations_one_active_per_container" });
  });

  it("refuses Stop on a stopped container and Start on a running one", async () => {
    const up = await running();
    const start = await action(h, up.id, "start");
    expect(start.status).toBe(409);
    expect(((await start.json()) as { error: string }).error).toBe("The container is already running.");

    const down = await stopped();
    const stop = await action(h, down.id, "stop");
    expect(stop.status).toBe(409);
    expect(((await stop.json()) as { error: string }).error).toBe("Only a running container can be stopped.");
  });

  it("answers 404 for a container that does not exist", async () => {
    expect((await action(h, randomUUID(), "stop")).status).toBe(404);
    expect((await action(h, "not-a-uuid", "stop")).status).toBe(404);
  });

  it("shows a Stop Railway refused as failed, and lets the user try again", async () => {
    const { id } = await running();
    h.railway.failNextOn("stopDeployment", { kind: "rejected", message: "Deployment is locked", traceId: "trace-9" });

    await action(h, id, "stop");
    await h.settled();

    const [container] = await list(h);
    expect(container).toMatchObject({ state: "failed", lastError: { message: "Deployment is locked", traceId: "trace-9" } });
    expect(container?.actions.stop).toEqual({ allowed: true });
  });

  it("keeps tracking the old deployment when Railway refuses the redeploy", async () => {
    const { id } = await stopped();
    const before = await currentDeploymentId(id);
    h.railway.failNextOn("redeployService", { kind: "rejected", message: "Service is being deleted" });

    await action(h, id, "start");
    await h.settled();

    expect(await currentDeploymentId(id)).toBe(before);
    const [container] = await list(h);
    expect(container).toMatchObject({ state: "failed", lastError: { message: "Service is being deleted" } });
    expect(container?.actions.start).toEqual({ allowed: true });
  });
});
