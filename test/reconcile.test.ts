import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CreateBody, action, create, type DeathPoint, eventually, type Harness, list, startHarness } from "./harness.ts";

// The backend is killed in the middle of an operation and a second instance boots
// on the same database and Railway. It must finish the operation from where Railway
// actually got: nothing duplicated, nothing orphaned.

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.close();
});

async function stateOf(id: string): Promise<string | undefined> {
  return (await list(h)).find((c) => c.id === id)?.state;
}

async function operationStatus(id: string): Promise<string | undefined> {
  const { rows } = await h.db.query<{ status: string }>("SELECT status FROM operations WHERE id = $1", [id]);
  return rows[0]?.status;
}

async function running(): Promise<{ id: string; serviceId: string }> {
  const body = (await (await create(h)).json()) as CreateBody;
  await h.settled();
  const serviceId = [...h.railway.services.keys()].at(-1) ?? "";
  h.railway.setDeployment(serviceId, "SUCCESS");
  await eventually(async () => (await stateOf(body.container.id)) === "running");
  return { id: body.container.id, serviceId };
}

async function stopped(): Promise<{ id: string; serviceId: string }> {
  const c = await running();
  await action(h, c.id, "stop");
  await h.settled();
  h.railway.setDeployment(c.serviceId, "SUCCESS", true);
  await eventually(async () => (await stateOf(c.id)) === "stopped");
  return c;
}

/** Kill the backend on its next call to `method`, after sending the request that makes it. */
async function killDuring(method: Parameters<Harness["dieOn"]>[0], when: DeathPoint, request: () => Promise<Response>): Promise<string> {
  h.dieOn(method, when);
  const res = await request();
  expect(res.status).toBe(202);
  await eventually(() => h.dead);
  return ((await res.json()) as { operation: { id: string } }).operation.id;
}

describe("a create interrupted by a restart", () => {
  it.each<DeathPoint>(["after_acting", "before_acting"])("killed %s serviceCreate: the next instance ends with exactly one service", async (when) => {
    const operationId = await killDuring("createContainer", when, () => create(h));
    const { rows } = await h.db.query<{ id: string; name: string }>("SELECT id, name FROM containers");
    const container = rows[0];
    if (!container) throw new Error("no container");

    await h.restart();
    await h.settled();

    // Railway saw one serviceCreate either way: the dead instance's, or the next one's after its lookup found nothing.
    expect(h.railway.callsTo("createContainer")).toHaveLength(1);
    expect(h.railway.callsTo("findService")).toEqual([{ method: "findService", name: container.name }]);
    expect(h.railway.services.size).toBe(1);
    const [serviceId] = h.railway.services.keys();
    expect(await list(h)).toMatchObject([{ id: container.id, state: "creating", serviceId, url: `https://${container.name}.up.railway.app` }]);

    h.railway.setDeployment(serviceId ?? "", "SUCCESS");
    await eventually(async () => (await stateOf(container.id)) === "running");
    expect(await operationStatus(operationId)).toBe("succeeded");
  });

  it("killed after the domain was created: reuses it instead of making a second", async () => {
    await killDuring("createDomain", "after_acting", () => create(h));

    await h.restart();
    await h.settled();

    expect(h.railway.callsTo("createContainer")).toHaveLength(1);
    expect(h.railway.callsTo("createDomain")).toHaveLength(1);
    expect(h.railway.callsTo("findService")).toHaveLength(0);
    const [container] = await list(h);
    expect(container?.url).toBe(`https://${container?.name}.up.railway.app`);
  });

  it("refuses a Stop while the resumed create is still running", async () => {
    await killDuring("createContainer", "after_acting", () => create(h));
    await h.restart();
    await h.settled();
    const [container] = await list(h);

    const res = await action(h, container?.id ?? "", "stop");
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("Wait for Create to finish.");
  });
});

describe("a Stop interrupted by a restart", () => {
  it("killed after Railway stopped it: completes without stopping it again", async () => {
    const { id, serviceId } = await running();
    const operationId = await killDuring("stopDeployment", "after_acting", () => action(h, id, "stop"));
    // Railway finishes stopping it while no backend is up.
    h.railway.setDeployment(serviceId, "SUCCESS", true);

    await h.restart();
    await h.settled();

    await eventually(async () => (await stateOf(id)) === "stopped");
    expect(h.railway.callsTo("stopDeployment")).toHaveLength(1);
    expect(await operationStatus(operationId)).toBe("succeeded");
  });

  it("killed before the stop reached Railway: stops it", async () => {
    const { id, serviceId } = await running();
    const operationId = await killDuring("stopDeployment", "before_acting", () => action(h, id, "stop"));

    await h.restart();
    await h.settled();
    expect(h.railway.callsTo("stopDeployment")).toHaveLength(1);
    expect(await stateOf(id)).toBe("stopping");

    h.railway.setDeployment(serviceId, "SUCCESS", true);
    await eventually(async () => (await stateOf(id)) === "stopped");
    expect(await operationStatus(operationId)).toBe("succeeded");
  });
});

describe("a Start interrupted by a restart", () => {
  it.each<DeathPoint>(["after_acting", "before_acting"])("killed %s the redeploy: ends running on exactly one new deployment", async (when) => {
    const { id, serviceId } = await stopped();
    const replaced = h.railway.services.get(serviceId)?.deploymentId;
    const operationId = await killDuring("redeployService", when, () => action(h, id, "start"));

    await h.restart();
    await h.settled();

    expect(h.railway.callsTo("redeployService")).toHaveLength(1);
    const current = h.railway.services.get(serviceId)?.deploymentId;
    expect(current).not.toBe(replaced);
    const { rows } = await h.db.query<{ current_deployment_id: string | null }>("SELECT current_deployment_id FROM containers WHERE id = $1", [id]);
    expect(rows[0]?.current_deployment_id).toBe(current);

    h.railway.setDeployment(serviceId, "SUCCESS");
    await eventually(async () => (await stateOf(id)) === "running");
    expect(await operationStatus(operationId)).toBe("succeeded");
  });
});

describe("a Destroy interrupted by a restart", () => {
  it("killed after Railway deleted the service: finishes without an error", async () => {
    const { id } = await running();
    const operationId = await killDuring("deleteService", "after_acting", () => action(h, id, "destroy"));

    await h.restart();
    await h.settled();

    expect(await list(h)).toEqual([]);
    expect(h.railway.callsTo("deleteService")).toHaveLength(1);
    expect(await operationStatus(operationId)).toBe("succeeded");
  });

  it("killed before the delete reached Railway: deletes the service", async () => {
    const { id } = await running();
    await killDuring("deleteService", "before_acting", () => action(h, id, "destroy"));

    await h.restart();
    await h.settled();

    expect(await list(h)).toEqual([]);
    expect(h.railway.services.size).toBe(0);
  });
});
