import { setTimeout as pause } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_ATTEMPTS } from "../src/server/retry.ts";
import { action, type CreateBody, create, eventually, type Harness, list, startHarness } from "./harness.ts";

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.close();
});

/** Wait until the code under test is backing off, then let `ms` pass. */
async function elapse(ms: number): Promise<void> {
  await eventually(() => h.clock.sleepers > 0);
  h.clock.advance(ms);
}

/** Give background work a moment to act on a clock that did not move far enough. */
async function quiet(): Promise<void> {
  await pause(30);
}

async function createAmbiguousFlag(operationId: string): Promise<boolean> {
  const { rows } = await h.db.query<{ flag: boolean }>("SELECT last_outcome_ambiguous AS flag FROM operations WHERE id = $1", [operationId]);
  return rows[0]?.flag === true;
}

async function running(): Promise<{ id: string; serviceId: string }> {
  const body = (await (await create(h)).json()) as CreateBody;
  await h.settled();
  const [serviceId] = h.railway.services.keys();
  if (!serviceId) throw new Error("no service");
  h.railway.setDeployment(serviceId, "SUCCESS");
  await eventually(async () => (await list(h))[0]?.state === "running");
  return { id: body.container.id, serviceId };
}

describe("a create whose outcome is ambiguous", () => {
  it("finds the service Railway did create by name and adopts it, ending with exactly one service", async () => {
    h.railway.failNext({ kind: "ambiguous_after_acting" });
    const body = (await (await create(h)).json()) as CreateBody;
    await elapse(1_000);
    await h.settled();

    expect(h.railway.callsTo("createContainer")).toHaveLength(1);
    expect(h.railway.callsTo("findService")).toEqual([{ method: "findService", name: body.container.name }]);
    expect(h.railway.services.size).toBe(1);
    const [serviceId] = h.railway.services.keys();
    const [container] = await list(h);
    expect(container).toMatchObject({ state: "creating", serviceId, url: `https://${body.container.name}.up.railway.app` });
    expect(await createAmbiguousFlag(body.operation.id)).toBe(false);
  });

  it("repeats the create when the lookup shows Railway never made the service", async () => {
    h.railway.failNext({ kind: "ambiguous_before_acting" });
    await create(h);
    await elapse(1_000);
    await h.settled();

    expect(h.railway.callsTo("createContainer")).toHaveLength(2);
    expect(h.railway.services.size).toBe(1);
  });

  it("does not repeat the create while the lookup itself gets no answer", async () => {
    h.railway.failNext({ kind: "ambiguous_after_acting" });
    h.railway.failNextOn("findService", { kind: "ambiguous_before_acting" });
    await create(h);
    await elapse(1_000);
    await elapse(2_000);
    await h.settled();

    expect(h.railway.callsTo("findService")).toHaveLength(2);
    expect(h.railway.callsTo("createContainer")).toHaveLength(1);
    expect(h.railway.services.size).toBe(1);
  });

  it("stays active and flagged for the reconciler after every attempt goes unanswered", async () => {
    h.railway.failNext(...Array.from({ length: MAX_ATTEMPTS }, () => ({ kind: "ambiguous_before_acting" as const })));
    const body = (await (await create(h)).json()) as CreateBody;
    for (const ms of [1_000, 2_000, 4_000, 8_000]) await elapse(ms);
    await h.settled();

    expect(h.railway.callsTo("createContainer")).toHaveLength(MAX_ATTEMPTS);
    const [container] = await list(h);
    expect(container?.state).toBe("creating");
    expect(await createAmbiguousFlag(body.operation.id)).toBe(true);
  });

  it("backs off exponentially between attempts", async () => {
    h.railway.failNext({ kind: "ambiguous_before_acting" }, { kind: "ambiguous_before_acting" });
    await create(h);
    await elapse(1_000);
    await eventually(() => h.railway.callsTo("createContainer").length === 2);
    await elapse(1_999);
    await quiet();
    expect(h.railway.callsTo("createContainer")).toHaveLength(2);
    h.clock.advance(1);
    await h.settled();
    expect(h.railway.callsTo("createContainer")).toHaveLength(3);
  });

  it("a Destroy of a create that never got an answer finds the service by name and deletes it", async () => {
    h.railway.failNext({ kind: "ambiguous_after_acting" });
    // Every name lookup goes unanswered too, so the create is never repeated and never resolved.
    h.railway.failNextOn("findService", ...Array.from({ length: MAX_ATTEMPTS - 1 }, () => ({ kind: "ambiguous_before_acting" as const })));
    const body = (await (await create(h)).json()) as CreateBody;
    for (const ms of [1_000, 2_000, 4_000, 8_000]) await elapse(ms);
    await h.settled();
    expect(h.railway.services.size).toBe(1);
    expect((await list(h))[0]?.serviceId).toBeNull();

    await action(h, body.container.id, "destroy");
    await h.settled();

    expect(h.railway.services.size).toBe(0);
    expect(await list(h)).toHaveLength(0);
  });
});

describe("rate limits", () => {
  it("retries a 429 only once Retry-After has passed", async () => {
    h.railway.failNext({ kind: "rate_limited", retryAfterMs: 7_000 });
    await create(h);
    await elapse(6_999);
    await quiet();
    expect(h.railway.callsTo("createContainer")).toHaveLength(1);

    h.clock.advance(1);
    await h.settled();
    expect(h.railway.callsTo("createContainer")).toHaveLength(2);
    expect(h.railway.callsTo("findService")).toHaveLength(0);
    expect(h.railway.services.size).toBe(1);
  });

  it("fails the operation once every attempt was rate limited", async () => {
    h.railway.failNext(...Array.from({ length: MAX_ATTEMPTS }, () => ({ kind: "rate_limited" as const, retryAfterMs: 5_000 })));
    await create(h);
    for (let i = 1; i < MAX_ATTEMPTS; i++) await elapse(5_000);
    await h.settled();

    expect(h.railway.callsTo("createContainer")).toHaveLength(MAX_ATTEMPTS);
    const [container] = await list(h);
    expect(container).toMatchObject({ state: "failed", lastError: { message: "Railway rate limit reached; try again shortly." } });
  });
});

describe("rejections", () => {
  it("fails at once with the message and trace id, after a single call", async () => {
    h.railway.failNext({ kind: "rejected", message: "Problem processing request", traceId: "trace-42" });
    await create(h);
    await h.settled();

    expect(h.railway.callsTo("createContainer")).toHaveLength(1);
    expect(h.railway.callsTo("findService")).toHaveLength(0);
    expect(h.clock.sleepers).toBe(0);
    const [container] = await list(h);
    expect(container).toMatchObject({ state: "failed", lastError: { message: "Problem processing request", traceId: "trace-42" } });
  });

  it("leaves a create whose service exists but whose deployment failed as failed, with Destroy available", async () => {
    const body = (await (await create(h)).json()) as CreateBody;
    await h.settled();
    const [serviceId] = h.railway.services.keys();
    h.railway.setDeployment(serviceId as string, "FAILED");
    await eventually(async () => (await list(h))[0]?.state === "failed");

    const [container] = await list(h);
    expect(container?.serviceId).toBe(serviceId);
    expect(container?.lastError?.message).toMatch(/FAILED/);
    expect(container?.actions.destroy).toEqual({ allowed: true });

    expect((await action(h, body.container.id, "destroy")).status).toBe(202);
    await h.settled();
    expect(h.railway.services.size).toBe(0);
  });
});

describe("retries of the other calls", () => {
  it("does not create a second domain when the first one's response was lost", async () => {
    h.railway.failNextOn("createDomain", { kind: "ambiguous_after_acting" });
    await create(h);
    await elapse(1_000);
    await h.settled();

    expect(h.railway.callsTo("createDomain")).toHaveLength(1);
    expect((await list(h))[0]?.url).toMatch(/^https:\/\/rcc-/);
  });

  it("repeats a Stop that never reached Railway", async () => {
    const { id, serviceId } = await running();
    h.railway.failNextOn("stopDeployment", { kind: "ambiguous_before_acting" });
    await action(h, id, "stop");
    await elapse(1_000);
    await h.settled();
    expect(h.railway.callsTo("stopDeployment")).toHaveLength(2);

    h.railway.setDeployment(serviceId, "SUCCESS", true);
    await eventually(async () => (await list(h))[0]?.state === "stopped");
  });

  it("does not repeat a Start whose redeploy did happen", async () => {
    const { id, serviceId } = await running();
    await action(h, id, "stop");
    await h.settled();
    h.railway.setDeployment(serviceId, "SUCCESS", true);
    await eventually(async () => (await list(h))[0]?.state === "stopped");

    h.railway.failNextOn("redeployService", { kind: "ambiguous_after_acting" });
    await action(h, id, "start");
    await elapse(1_000);
    await h.settled();
    expect(h.railway.callsTo("redeployService")).toHaveLength(1);

    h.railway.setDeployment(serviceId, "SUCCESS");
    await eventually(async () => (await list(h))[0]?.state === "running");
  });

  it("does not repeat a delete that did happen", async () => {
    const { id } = await running();
    h.railway.failNextOn("deleteService", { kind: "ambiguous_after_acting" });
    await action(h, id, "destroy");
    await elapse(1_000);
    await h.settled();

    expect(h.railway.callsTo("deleteService")).toHaveLength(1);
    expect(await list(h)).toHaveLength(0);
  });

  it("repeats a delete that never reached Railway", async () => {
    const { id } = await running();
    h.railway.failNextOn("deleteService", { kind: "rate_limited", retryAfterMs: 3_000 });
    await action(h, id, "destroy");
    await elapse(3_000);
    await h.settled();

    expect(h.railway.callsTo("deleteService")).toHaveLength(2);
    expect(h.railway.services.size).toBe(0);
    expect(await list(h)).toHaveLength(0);
  });
});
