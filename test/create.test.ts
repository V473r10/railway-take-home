import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CreateBody, create, type Harness, list, startHarness } from "./harness.ts";

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.close();
});

describe("creating a container", () => {
  it("records the operation and lists the container as creating", async () => {
    const res = await create(h);
    expect(res.status).toBe(202);
    const body = (await res.json()) as CreateBody;
    expect(body.operation).toMatchObject({ kind: "create" });
    expect(body.container.state).toBe("creating");

    await h.settled();
    const containers = await list(h);
    expect(containers).toHaveLength(1);
    // Railway created the service; the container stays creating until its deployment is observed.
    const [serviceId] = h.railway.services.keys();
    expect(containers[0]).toMatchObject({ id: body.container.id, state: "creating", serviceId });
  });

  it("names the service after the create operation and uses the fixed image", async () => {
    const body = (await (await create(h)).json()) as CreateBody;
    await h.settled();

    expect(h.railway.calls).toEqual([
      { method: "createContainer", input: { name: `rcc-${body.operation.id}`, image: "nginx:alpine" } },
    ]);
    expect(body.container.name).toBe(`rcc-${body.operation.id}`);
  });

  it("turns the same idempotency key sent twice into one operation", async () => {
    const first = await create(h, "click-0001");
    await h.settled();
    const second = await create(h, "click-0001");
    await h.settled();

    expect(first.status).toBe(202);
    expect(second.status).toBe(200);
    expect(second.headers.get("Idempotent-Replayed")).toBe("true");
    const [a, b] = (await Promise.all([first.json(), second.json()])) as CreateBody[];
    expect(b!.operation.id).toBe(a!.operation.id);
    expect(await list(h)).toHaveLength(1);
    expect(h.railway.calls).toHaveLength(1);
  });

  it("turns concurrent requests with the same key into one operation", async () => {
    const release = h.railway.hold();
    const responses = await Promise.all(Array.from({ length: 5 }, () => create(h, "double-click")));
    release();
    await h.settled();

    const ids = new Set(await Promise.all(responses.map(async (r) => ((await r.json()) as CreateBody).operation.id)));
    expect(ids.size).toBe(1);
    expect(responses.filter((r) => r.status === 202)).toHaveLength(1);
    expect(await list(h)).toHaveLength(1);
    expect(h.railway.calls).toHaveLength(1);
  });

  it("gives different keys different containers", async () => {
    await create(h, "click-aaaa");
    await create(h, "click-bbbb");
    await h.settled();

    expect(await list(h)).toHaveLength(2);
    expect(h.railway.calls).toHaveLength(2);
  });

  it.each([
    ["missing", undefined],
    ["too short", "abc"],
    ["containing spaces", "has a space in it"],
  ])("rejects a create whose idempotency key is %s", async (_label, key) => {
    const headers: Record<string, string> = key === undefined ? {} : { "Idempotency-Key": key };
    const res = await h.request("/api/containers", { method: "POST", headers });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/Idempotency-Key/);
    await h.settled();
    expect(await list(h)).toHaveLength(0);
    expect(h.railway.calls).toHaveLength(0);
  });

  it("shows a container Railway refused as failed, with the message and trace id", async () => {
    h.railway.failNext({ kind: "rejected", message: "Not Authorized", code: "UNAUTHORIZED", traceId: "trace-123" });
    await create(h);
    await h.settled();

    const [container] = await list(h);
    expect(container).toMatchObject({ state: "failed", lastError: { message: "Not Authorized", traceId: "trace-123" } });
  });
});
