import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONTAINER_LIFETIME_MS, CONTAINER_LIMIT, CONTAINER_LIMIT_MESSAGE, LIFETIME_SWEEP_MS } from "../src/server/containers.ts";
import { action, type CreateBody, create, eventually, type Harness, list, startHarness } from "./harness.ts";

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.close();
});

/** Create a container and bring it to running (or stopped), the way Railway would report it. */
async function container(stopped = false): Promise<string> {
  const body = (await (await create(h)).json()) as CreateBody;
  await h.settled();
  const serviceId = (await list(h)).find((c) => c.id === body.container.id)?.serviceId ?? "";
  const deploymentId = h.railway.services.get(serviceId)?.deploymentId;
  // Observed once, so the state set below reaches the observer as a change.
  await eventually(() => h.railway.callsTo("readDeployment").some((c) => c.deploymentId === deploymentId));
  h.railway.setDeployment(serviceId, "SUCCESS");
  await eventually(async () => (await list(h)).find((c) => c.id === body.container.id)?.state === "running");
  if (stopped) {
    await action(h, body.container.id, "stop");
    await h.settled();
    h.railway.setDeployment(serviceId, "SUCCESS", true);
    await eventually(async () => (await list(h)).find((c) => c.id === body.container.id)?.state === "stopped");
  }
  return body.container.id;
}

describe("container limit", () => {
  it("refuses a sixth create with five containers, stopped ones included", async () => {
    for (let i = 0; i < CONTAINER_LIMIT; i++) await container(i < 2);
    expect((await list(h)).map((c) => c.state).sort()).toEqual(["running", "running", "running", "stopped", "stopped"]);

    const res = await create(h);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(CONTAINER_LIMIT_MESSAGE);
    await h.settled();
    expect(h.railway.callsTo("createContainer")).toHaveLength(CONTAINER_LIMIT);
    expect(await list(h)).toHaveLength(CONTAINER_LIMIT);
  });

  it("still answers a replayed create at the limit with its own operation", async () => {
    for (let i = 0; i < CONTAINER_LIMIT - 1; i++) await container();
    const key = randomUUID();
    const first = (await (await create(h, key)).json()) as CreateBody;

    const replay = await create(h, key);
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as CreateBody).operation.id).toBe(first.operation.id);
  });

  it("does not let concurrent creates at four containers exceed five", async () => {
    for (let i = 0; i < CONTAINER_LIMIT - 1; i++) await container();
    const statuses = await Promise.all(Array.from({ length: 4 }, () => create(h).then((r) => r.status)));
    await h.settled();

    expect(statuses.sort()).toEqual([202, 409, 409, 409]);
    expect(await list(h)).toHaveLength(CONTAINER_LIMIT);
    expect(h.railway.callsTo("createContainer")).toHaveLength(CONTAINER_LIMIT);
  });

  it("frees a slot once a container is destroyed", async () => {
    const ids: string[] = [];
    for (let i = 0; i < CONTAINER_LIMIT; i++) ids.push(await container());
    await action(h, ids[0] ?? "", "destroy");
    await h.settled();

    expect((await create(h)).status).toBe(202);
  });
});

describe("container lifetime", () => {
  it("shows when each container expires", async () => {
    await container();
    const [c] = await list(h);
    expect(c?.expiresAt).toBe(new Date(new Date(c?.createdAt ?? 0).getTime() + CONTAINER_LIFETIME_MS).toISOString());
  });

  it("destroys a running and a stopped container 30 minutes after creation", async () => {
    await container(false);
    await container(true);

    h.clock.advance(CONTAINER_LIFETIME_MS - LIFETIME_SWEEP_MS);
    await h.settled();
    expect(await list(h)).toHaveLength(2);
    expect(h.railway.callsTo("deleteService")).toHaveLength(0);

    h.clock.advance(LIFETIME_SWEEP_MS);
    await h.settled();
    expect(await list(h)).toEqual([]);
    expect(h.railway.callsTo("deleteService")).toHaveLength(2);
    expect(h.railway.services.size).toBe(0);
  });

  it("destroys containers that expired while the app was down, at startup", async () => {
    await container();
    await container(true);

    // The app is down for 45 minutes: nothing sweeps while it is gone.
    await h.restart(() => h.clock.advance(45 * 60 * 1000));
    await h.settled();

    expect(await list(h)).toEqual([]);
    expect(h.railway.callsTo("deleteService")).toHaveLength(2);
    expect(h.railway.services.size).toBe(0);
  });

  it("tries again on the next sweep when Railway rejects the Destroy", async () => {
    await container();
    h.railway.failNextOn("deleteService", { kind: "rejected", message: "boom" });
    h.clock.advance(CONTAINER_LIFETIME_MS);
    await h.settled();
    expect((await list(h))[0]?.state).toBe("failed");

    h.clock.advance(LIFETIME_SWEEP_MS);
    await h.settled();
    expect(await list(h)).toEqual([]);
  });
});
