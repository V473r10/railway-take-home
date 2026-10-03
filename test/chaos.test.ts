import { afterEach, describe, expect, it } from "vitest";
import { CRASH_DELAY_MS } from "../src/server/app.ts";
import { MIN_BACKOFF_MS } from "../src/server/observer.ts";
import { type CreateBody, create, eventually, type Harness, list, startHarness } from "./harness.ts";

let h: Harness;
afterEach(async () => {
  await h.close();
});

type Entry = { kind: string; [field: string]: unknown };

async function timeline(containerId: string): Promise<Entry[]> {
  return ((await (await h.request(`/api/containers/${containerId}/timeline`)).json()) as { entries: Entry[] }).entries;
}

function post(path: string, body?: unknown): Promise<Response> {
  return h.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
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

describe("chaos mode", () => {
  it("is off unless enabled: the panel reads disabled and every switch is 404", async () => {
    h = await startHarness();
    expect(await (await h.request("/api/chaos")).json()).toEqual({ enabled: false, armed: null });
    expect((await post("/api/chaos/arm", { fault: "drop_next_response" })).status).toBe(404);
    expect((await post("/api/chaos/crash")).status).toBe(404);
    expect((await post("/api/chaos/cut-subscriptions")).status).toBe(404);
  });

  it("is behind the password gate", async () => {
    h = await startHarness({ chaos: true });
    const res = await h.anonymous("/api/chaos/crash", { method: "POST" });
    expect(res.status).toBe(401);
    expect(h.dead).toBe(false);
  });

  it("drops the next response after Railway acted: the create looks before repeating, one service", async () => {
    h = await startHarness({ chaos: true });
    expect(await (await post("/api/chaos/arm", { fault: "drop_next_response" })).json()).toEqual({ enabled: true, armed: "drop_next_response" });
    const body = (await (await create(h)).json()) as CreateBody;
    await eventually(() => h.clock.sleepers > 0);
    h.clock.advance(1_000);
    await h.settled();

    expect(h.railway.callsTo("createContainer")).toHaveLength(1);
    expect(h.railway.services.size).toBe(1);
    expect(await (await h.request("/api/chaos")).json()).toEqual({ enabled: true, armed: null });
    const kinds = (await timeline(body.container.id)).map((e) => (e.kind === "call" ? `${String(e.call)} ${String(e.outcome)}` : e.kind));
    expect(kinds).toEqual(["requested", "began", "chaos", "serviceCreate ambiguous", "lookup", "serviceDomainCreate ok"]);
  });

  it("kills the process after Railway acted: the next process resumes and ends with one service", async () => {
    h = await startHarness({ chaos: true });
    await post("/api/chaos/arm", { fault: "crash_after_next_write" });
    const body = (await (await create(h)).json()) as CreateBody;
    await eventually(() => h.dead);
    await h.restart();
    await h.settled();

    expect(h.railway.callsTo("createContainer")).toHaveLength(1);
    expect(h.railway.services.size).toBe(1);
    const entries = await timeline(body.container.id);
    expect(entries.map((e) => e.kind).slice(0, 4)).toEqual(["requested", "began", "chaos", "began"]);
    expect(entries[2]).toMatchObject({ fault: "crash_after_next_write", call: "serviceCreate" });
    expect(entries[3]).toMatchObject({ resumed: true });
  });

  it("kills the process on request, after answering", async () => {
    h = await startHarness({ chaos: true });
    const res = await post("/api/chaos/crash");
    expect(res.status).toBe(202);
    expect(h.dead).toBe(false);
    await eventually(() => h.dead, CRASH_DELAY_MS + 2_000);
  });

  it("cuts every subscription: the observer reads again and resubscribes", async () => {
    h = await startHarness({ chaos: true });
    const { id, serviceId } = await running();
    expect(h.railway.openSubscriptions).toBe(1);
    expect(await (await post("/api/chaos/cut-subscriptions")).json()).toEqual({ cut: 1 });
    expect(h.railway.openSubscriptions).toBe(0);

    await eventually(() => h.clock.sleepers > 0);
    h.clock.advance(MIN_BACKOFF_MS);
    await eventually(() => h.railway.openSubscriptions === 1);
    // A change while the socket was down is still seen.
    h.railway.setDeployment(serviceId, "CRASHED");
    await eventually(async () => (await list(h))[0]?.state === "crashed");
    expect((await timeline(id)).some((e) => e.kind === "chaos" && e.fault === "cut_subscriptions")).toBe(true);
  });

  it("deletes a service outside the app: the container shows missing", async () => {
    h = await startHarness({ chaos: true });
    const { id } = await running();
    expect((await post(`/api/containers/${id}/chaos/delete-outside`)).status).toBe(202);
    expect(h.railway.services.size).toBe(0);
    h.clock.advance(60_000);
    await eventually(async () => (await list(h))[0]?.state === "missing");
    const kinds = (await timeline(id)).map((e) => e.kind);
    // Between the two, Railway may report the deployment going away.
    expect(kinds.indexOf("chaos")).toBeGreaterThan(-1);
    expect(kinds.at(-1)).toBe("missing");
    expect((await post(`/api/containers/${id}/chaos/delete-outside`)).status).toBe(409);
  });

  it("refuses an unknown fault", async () => {
    h = await startHarness({ chaos: true });
    expect((await post("/api/chaos/arm", { fault: "rm -rf" })).status).toBe(400);
    expect((await post("/api/chaos/arm", { fault: null })).status).toBe(200);
  });
});
