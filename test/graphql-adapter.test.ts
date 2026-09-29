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
