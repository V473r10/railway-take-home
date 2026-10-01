import { afterEach, describe, expect, it } from "vitest";
import { MIN_BACKOFF_MS } from "../src/server/observer.ts";
import { action, type ContainerBody, type CreateBody, create, eventually, type Harness, type LiveEvent, list, railwayStops, startHarness } from "./harness.ts";

const harnesses: Harness[] = [];
async function harness(): Promise<Harness> {
  const h = await startHarness();
  harnesses.push(h);
  return h;
}
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.close()));
});

const upsert =
  (id: string, state: string) =>
  (e: LiveEvent): boolean =>
    e.type === "upsert" && e.container.id === id && e.container.state === state;

/** Create a container and wait until the observer is subscribed to its deployment. */
async function createObserved(h: Harness): Promise<{ id: string; serviceId: string }> {
  const body = (await (await create(h)).json()) as CreateBody;
  await h.settled();
  await eventually(() => h.railway.openSubscriptions === 1 && h.railway.callsTo("readDeployment").length === 1);
  const [serviceId] = [...h.railway.services.keys()];
  return { id: body.container.id, serviceId: serviceId! };
}

describe("live container state", () => {
  it("shows a created container going from creating to running with its public URL", async () => {
    const h = await harness();
    const tab = await h.events();
    await tab.next((e) => e.type === "snapshot" && e.containers.length === 0);

    const { id, serviceId } = await createObserved(h);
    await tab.next(upsert(id, "creating"));

    h.railway.setDeployment(serviceId, "SUCCESS");
    const running = (await tab.next(upsert(id, "running"))) as Extract<LiveEvent, { type: "upsert" }>;
    expect(running.container.url).toBe(`https://${h.railway.services.get(serviceId)!.domain}`);
    expect((await list(h))[0]).toMatchObject({ state: "running", url: running.container.url });
  });

  it("subscribes before reading the deployment, so no change can fall between the two", async () => {
    const h = await harness();
    await createObserved(h);

    const methods = h.railway.calls.map((c) => c.method);
    expect(methods.indexOf("watchDeployment")).toBeLessThan(methods.indexOf("readDeployment"));
  });

  it("makes no extra Railway calls for a second tab", async () => {
    const railwayCallsWith = async (tabs: number) => {
      const h = await harness();
      const streams = await Promise.all(Array.from({ length: tabs }, () => h.events()));
      const { id, serviceId } = await createObserved(h);
      h.railway.setDeployment(serviceId, "SUCCESS");
      for (const tab of streams) await tab.next(upsert(id, "running"));
      return h.railway.calls.map((c) => c.method);
    };

    const one = await railwayCallsWith(1);
    const two = await railwayCallsWith(2);
    expect(two).toEqual(one);
    expect(one).toEqual(["createContainer", "createDomain", "latestDeployment", "watchDeployment", "readDeployment"]);
  });

  it("sends the current state to a tab that connects later", async () => {
    const h = await harness();
    const { id, serviceId } = await createObserved(h);
    h.railway.setDeployment(serviceId, "SUCCESS");
    await eventually(async () => (await list(h))[0]?.state === "running");

    const reopened = await h.events();
    const snapshot = await reopened.next((e) => e.type === "snapshot");
    expect(snapshot).toMatchObject({ containers: [{ id, state: "running" }] });
  });

  it("falls back to reading with backoff when the subscription is refused", async () => {
    const h = await harness();
    h.railway.refuseSubscriptions();
    const tab = await h.events();
    await create(h);
    await h.settled();
    await eventually(() => h.railway.callsTo("readDeployment").length === 1 && h.clock.sleepers === 1);
    const [serviceId] = [...h.railway.services.keys()];
    const reads = () => h.railway.callsTo("readDeployment").length;

    // Railway moves on; nothing is pushed, so only the next read can see it.
    h.railway.setDeployment(serviceId!, "SUCCESS");
    h.clock.advance(MIN_BACKOFF_MS);
    const running = await tab.next((e) => e.type === "upsert" && e.container.state === "running");
    expect(running).toBeTruthy();
    expect(reads()).toBe(2);

    // The wait doubles: another MIN_BACKOFF_MS is not enough for a third read.
    await eventually(() => h.clock.sleepers === 1);
    h.clock.advance(MIN_BACKOFF_MS);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(reads()).toBe(2);
    h.clock.advance(MIN_BACKOFF_MS);
    await eventually(() => reads() === 3);
  });

  it("recovers the state after the subscription drops", async () => {
    const h = await harness();
    const tab = await h.events();
    const { id, serviceId } = await createObserved(h);

    h.railway.dropSubscriptions();
    h.railway.setDeployment(serviceId, "SUCCESS"); // happens while nobody is subscribed
    await eventually(() => h.clock.sleepers === 1);
    h.clock.advance(MIN_BACKOFF_MS);

    await tab.next(upsert(id, "running"));
    expect(h.railway.openSubscriptions).toBe(1);
  });

  it("completes a Stop by reading, since Railway pushes status changes only", async () => {
    const h = await harness();
    const tab = await h.events();
    const { id, serviceId } = await createObserved(h);
    h.railway.setDeployment(serviceId, "SUCCESS");
    await tab.next(upsert(id, "running"));

    await action(h, id, "stop");
    await tab.next(upsert(id, "stopping"));
    await h.settled();
    // Railway stops it and tells no open subscription (the status stays SUCCESS).
    await railwayStops(h, serviceId);
    await tab.next(upsert(id, "stopped"));
  });

  it("fails the create when Railway reports the deployment failed", async () => {
    const h = await harness();
    const tab = await h.events();
    const { id, serviceId } = await createObserved(h);

    h.railway.setDeployment(serviceId, "FAILED");
    const failed = (await tab.next(upsert(id, "failed"))) as { container: ContainerBody };
    expect(failed.container.lastError?.message).toMatch(/FAILED/);
  });
});
