import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { action, type CreateBody, create, eventually, type Harness, list, railwayStops, startHarness } from "./harness.ts";

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.close();
});

type Entry = { kind: string; operationId: string | null; [field: string]: unknown };

async function timeline(containerId: string): Promise<Entry[]> {
  const res = await h.request(`/api/containers/${containerId}/timeline`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { entries: Entry[] }).entries;
}

/** Each entry in one line, so a test reads like the timeline does. */
function lines(entries: Entry[]): string[] {
  return entries.map((e) => {
    switch (e.kind) {
      case "requested":
        return `requested ${String(e.operation)} by ${String(e.by)}`;
      case "began":
        return `began ${String(e.operation)}${e.resumed ? " (resumed)" : ""}`;
      case "call":
        return `${String(e.call)} #${String(e.attempt)} ${String(e.outcome)}`;
      case "lookup":
        return `looked before repeating ${String(e.call)}: ${String(e.result)}`;
      case "observed":
        return `observed ${String(e.status)}${e.stopped ? " stopped" : ""}`;
      case "succeeded":
      case "failed":
      case "unanswered":
        return `${e.kind} ${String(e.operation)}`;
      default:
        return e.kind;
    }
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

describe("a container's timeline", () => {
  it("shows a lost serviceCreate response, the look that found the service, and no second create", async () => {
    h.railway.failNext({ kind: "ambiguous_after_acting" });
    const body = (await (await create(h)).json()) as CreateBody;
    await eventually(() => h.clock.sleepers > 0);
    h.clock.advance(1_000);
    await h.settled();
    const [serviceId] = h.railway.services.keys();
    h.railway.setDeployment(serviceId ?? "", "SUCCESS");
    await eventually(async () => (await list(h))[0]?.state === "running");

    const entries = await timeline(body.container.id);
    expect(lines(entries)).toEqual([
      "requested create by user",
      "began create",
      "serviceCreate #1 ambiguous",
      "looked before repeating serviceCreate: acted",
      "serviceDomainCreate #1 ok",
      "observed SUCCESS",
      "succeeded create",
    ]);
    expect(entries[2]).toMatchObject({ message: "fake: response lost", operationId: body.operation.id });
    // Every entry but the observation belongs to the create.
    expect(new Set(entries.filter((e) => e.kind !== "observed").map((e) => e.operationId))).toEqual(new Set([body.operation.id]));
  });

  it("shows a rejection with Railway's trace id", async () => {
    h.railway.failNext({ kind: "rejected", message: "Problem processing request", traceId: "trace-123" });
    const body = (await (await create(h)).json()) as CreateBody;
    await h.settled();

    expect(lines(await timeline(body.container.id))).toEqual(["requested create by user", "began create", "serviceCreate #1 rejected", "failed create"]);
    expect((await timeline(body.container.id))[2]).toMatchObject({ message: "Problem processing request", traceId: "trace-123" });
  });

  it("shows a process that died after Railway acted, and the next one resuming", async () => {
    h.dieOn("createContainer", "after_acting");
    const body = (await (await create(h)).json()) as CreateBody;
    await eventually(() => h.dead);
    await h.restart();
    await h.settled();

    // When the observer first reads the new deployment races the end of the create; leave it out.
    const steps = (await timeline(body.container.id)).filter((e) => e.kind !== "observed");
    expect(lines(steps)).toEqual([
      "requested create by user",
      "began create",
      "began create (resumed)",
      "services #1 ok",
      "domains #1 ok",
      "serviceDomainCreate #1 ok",
    ]);
  });

  it("shows a Stop, a Start's new deployment and a Destroy", async () => {
    const { id, serviceId } = await running();
    await action(h, id, "stop");
    await h.settled();
    await railwayStops(h, serviceId);
    await eventually(async () => (await list(h))[0]?.state === "stopped");
    await action(h, id, "start");
    await h.settled();
    h.railway.setDeployment(serviceId, "SUCCESS");
    await eventually(async () => (await list(h))[0]?.state === "running");
    await action(h, id, "destroy");
    await h.settled();

    const all = lines(await timeline(id));
    const tail = all.slice(all.indexOf("requested stop by user"));
    expect(tail).toEqual([
      "requested stop by user",
      "began stop",
      "deploymentStop #1 ok",
      "observed SUCCESS stopped",
      "succeeded stop",
      "requested start by user",
      "began start",
      "serviceInstanceRedeploy #1 ok",
      "deployment",
      "observed SUCCESS",
      "succeeded start",
      "requested destroy by user",
      "began destroy",
      "serviceDelete #1 ok",
      "succeeded destroy",
    ]);
  });

  it("shows a service deleted outside the app", async () => {
    const { id, serviceId } = await running();
    h.railway.deleteOutsideApp(serviceId);
    h.clock.advance(60_000);
    await eventually(async () => (await list(h))[0]?.state === "missing");
    // Railway's report of the deployment going away can be recorded before or after the sweep's verdict.
    expect(lines(await timeline(id)).filter((l) => !l.startsWith("observed")).at(-1)).toBe("missing");
  });

  it("is sent live to every open stream", async () => {
    const stream = await h.events();
    const body = (await (await create(h)).json()) as CreateBody;
    await h.settled();
    const live = () => lines(stream.events.flatMap((e) => (e.type === "timeline" ? [e.entry as Entry] : [])));
    // The observer may still add an entry; the stream catches up with the stored timeline.
    await eventually(async () => JSON.stringify(live()) === JSON.stringify(lines(await timeline(body.container.id))));
    expect(live().slice(0, 4)).toEqual(["requested create by user", "began create", "serviceCreate #1 ok", "serviceDomainCreate #1 ok"]);
  });

  it("is 404 for a container that never existed", async () => {
    expect((await h.request("/api/containers/00000000-0000-4000-8000-000000000000/timeline")).status).toBe(404);
    expect((await h.request("/api/containers/not-a-uuid/timeline")).status).toBe(404);
  });
});
