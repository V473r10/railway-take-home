// The real adapter, checked at its own boundary with a stubbed fetch: the
// request it sends matches what the M0 spike verified against Railway, and
// every kind of response is classified the way the retry policy needs.
import { describe, expect, it } from "vitest";
import { GraphqlRailway } from "../src/server/railway/graphql.ts";

type Captured = { url: string; init: RequestInit };

function adapterReturning(respond: () => Response | Promise<Response>) {
  const captured: Captured[] = [];
  const fetchStub = (async (url: string | URL | Request, init?: RequestInit) => {
    captured.push({ url: String(url), init: init ?? {} });
    return respond();
  }) as typeof fetch;
  const adapter = new GraphqlRailway({ token: "tok-secret", projectId: "proj-1", environmentId: "env-1", fetch: fetchStub });
  return { adapter, captured };
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" }, ...init });

describe("GraphqlRailway.createContainer", () => {
  it("sends serviceCreate with an image source into the sandbox project", async () => {
    const { adapter, captured } = adapterReturning(() => json({ data: { serviceCreate: { id: "svc-9" } } }));

    const outcome = await adapter.createContainer({ name: "rcc-op-1", image: "nginx:alpine" });

    expect(outcome).toEqual({ kind: "ok", value: { serviceId: "svc-9" } });
    const [call] = captured;
    expect(call!.url).toBe("https://backboard.railway.com/graphql/v2");
    expect(new Headers(call!.init.headers).get("Authorization")).toBe("Bearer tok-secret");
    const body = JSON.parse(String(call!.init.body)) as { query: string; variables: unknown };
    expect(body.query).toContain("serviceCreate(input:$input)");
    expect(body.variables).toEqual({
      input: { projectId: "proj-1", environmentId: "env-1", name: "rcc-op-1", source: { image: "nginx:alpine" } },
    });
  });

  it("classifies HTTP 200 with errors[] as rejected, keeping code and trace id", async () => {
    const { adapter } = adapterReturning(() =>
      json({ data: null, errors: [{ message: "Not Authorized", extensions: { code: "UNAUTHORIZED", traceId: "t-1" } }] }),
    );

    expect(await adapter.createContainer({ name: "n", image: "i" })).toEqual({
      kind: "rejected",
      message: "Not Authorized",
      code: "UNAUTHORIZED",
      traceId: "t-1",
    });
  });

  it("classifies 429 as rate limited, honouring Retry-After", async () => {
    const { adapter } = adapterReturning(() => new Response("slow down", { status: 429, headers: { "Retry-After": "7" } }));

    expect(await adapter.createContainer({ name: "n", image: "i" })).toEqual({ kind: "rate_limited", retryAfterMs: 7000 });
  });

  it("classifies a request with no response as ambiguous", async () => {
    const { adapter } = adapterReturning(() => {
      throw new TypeError("fetch failed");
    });

    expect(await adapter.createContainer({ name: "n", image: "i" })).toEqual({ kind: "ambiguous", reason: "fetch failed" });
  });

  it("classifies a 5xx as ambiguous, since Railway may have acted", async () => {
    const { adapter } = adapterReturning(() => new Response("bad gateway", { status: 502 }));

    expect((await adapter.createContainer({ name: "n", image: "i" })).kind).toBe("ambiguous");
  });

  it("classifies a 400 validation error as rejected", async () => {
    const { adapter } = adapterReturning(() =>
      json({ errors: [{ message: "Variable $input is invalid", extensions: { code: "GRAPHQL_VALIDATION_FAILED" } }] }, { status: 400 }),
    );

    expect(await adapter.createContainer({ name: "n", image: "i" })).toMatchObject({
      kind: "rejected",
      code: "GRAPHQL_VALIDATION_FAILED",
      traceId: null,
    });
  });
});

describe("GraphqlRailway deployments and domains", () => {
  it("creates the public domain on the image's port", async () => {
    const { adapter, captured } = adapterReturning(() => json({ data: { serviceDomainCreate: { domain: "x.up.railway.app" } } }));

    expect(await adapter.createDomain("svc-9")).toEqual({ kind: "ok", value: { domain: "x.up.railway.app" } });
    const body = JSON.parse(String(captured[0]!.init.body)) as { query: string; variables: unknown };
    expect(body.query).toContain("serviceDomainCreate(input:$input)");
    expect(body.variables).toEqual({ input: { serviceId: "svc-9", environmentId: "env-1", targetPort: 80 } });
  });

  it("reads status together with deploymentStopped", async () => {
    const { adapter, captured } = adapterReturning(() =>
      json({ data: { deployment: { id: "dep-1", status: "SUCCESS", deploymentStopped: true } } }),
    );

    expect(await adapter.readDeployment("dep-1")).toEqual({
      kind: "ok",
      value: { deploymentId: "dep-1", status: "SUCCESS", stopped: true },
    });
    expect(String(captured[0]!.init.body)).toContain("deploymentStopped");
  });

  it("returns null while a service has no deployment yet", async () => {
    const { adapter, captured } = adapterReturning(() => json({ data: { deployments: { edges: [] } } }));

    expect(await adapter.latestDeployment("svc-9")).toEqual({ kind: "ok", value: null });
    const body = JSON.parse(String(captured[0]!.init.body)) as { variables: unknown };
    expect(body.variables).toEqual({ input: { projectId: "proj-1", environmentId: "env-1", serviceId: "svc-9" } });
  });
});

/** A socket the test drives by hand: it records what the adapter sends and replays server frames. */
class ScriptedSocket {
  static last: ScriptedSocket | null = null;
  readonly sent: { type: string; id?: string; payload?: Record<string, unknown> }[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;

  readonly url: string;
  readonly protocol: string;

  constructor(url: string, protocol: string) {
    this.url = url;
    this.protocol = protocol;
    ScriptedSocket.last = this;
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {
    this.closed = true;
  }
  serverSends(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

describe("GraphqlRailway.watchDeployment", () => {
  const watch = () => {
    const adapter = new GraphqlRailway({ token: "tok-secret", projectId: "p", environmentId: "e", WebSocket: ScriptedSocket });
    const states: unknown[] = [];
    const ends: string[] = [];
    const stop = adapter.watchDeployment("dep-1", { onState: (s) => states.push(s), onEnd: (r) => ends.push(r) });
    const socket = ScriptedSocket.last!;
    socket.onopen?.();
    return { socket, states, ends, stop };
  };

  it("authenticates in connection_init and subscribes only after the ack", () => {
    const { socket } = watch();

    expect(socket.url).toBe("wss://backboard.railway.com/graphql/v2");
    expect(socket.protocol).toBe("graphql-transport-ws");
    expect(socket.sent).toEqual([{ type: "connection_init", payload: { Authorization: "Bearer tok-secret" } }]);

    socket.serverSends({ type: "connection_ack" });
    expect(socket.sent[1]).toMatchObject({ id: "1", type: "subscribe", payload: { variables: { id: "dep-1" } } });
    expect(String(socket.sent[1]!.payload!.query)).toContain("deploymentStopped");
  });

  it("delivers pushed states, answers pings and ends on an error frame", () => {
    const { socket, states, ends } = watch();
    socket.serverSends({ type: "connection_ack" });
    socket.serverSends({ id: "1", type: "next", payload: { data: { deployment: { id: "dep-1", status: "SUCCESS", deploymentStopped: false } } } });
    socket.serverSends({ type: "ping" });
    socket.serverSends({ id: "1", type: "error", payload: [{ message: "Not Authorized" }] });

    expect(states).toEqual([{ deploymentId: "dep-1", status: "SUCCESS", stopped: false }]);
    expect(socket.sent.at(-1)).toEqual({ type: "pong" });
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatch(/Not Authorized/);
    expect(socket.closed).toBe(true);
  });

  it("does not report an end the caller asked for", () => {
    const { socket, ends, stop } = watch();
    socket.serverSends({ type: "connection_ack" });
    stop();
    socket.onclose?.({ code: 1000 });

    expect(socket.sent.at(-1)).toEqual({ id: "1", type: "complete" });
    expect(ends).toEqual([]);
  });
});

describe("GraphqlRailway stop and start", () => {
  const sent = (captured: Captured[]) => JSON.parse(String(captured[0]?.init.body)) as { query: string; variables: unknown };

  it("stops with deploymentStop on the deployment id", async () => {
    const { adapter, captured } = adapterReturning(() => json({ data: { deploymentStop: true } }));

    expect(await adapter.stopDeployment("dep-7")).toEqual({ kind: "ok", value: undefined });
    expect(sent(captured).query).toContain("deploymentStop(id:$id)");
    expect(sent(captured).variables).toEqual({ id: "dep-7" });
  });

  it("starts with serviceInstanceRedeploy on the service in the sandbox environment", async () => {
    const { adapter, captured } = adapterReturning(() => json({ data: { serviceInstanceRedeploy: true } }));

    expect(await adapter.redeployService("svc-3")).toEqual({ kind: "ok", value: undefined });
    expect(sent(captured).query).toContain("serviceInstanceRedeploy(serviceId:$s, environmentId:$e)");
    expect(sent(captured).variables).toEqual({ s: "svc-3", e: "env-1" });
  });

  it("classifies a refused stop like any other call", async () => {
    const { adapter } = adapterReturning(() => json({ data: null, errors: [{ message: "Deployment not found", extensions: { traceId: "t-4" } }] }));

    expect(await adapter.stopDeployment("dep-x")).toMatchObject({ kind: "rejected", message: "Deployment not found", traceId: "t-4" });
  });
});
