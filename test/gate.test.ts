import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SESSION_COOKIE, SESSION_MAX_AGE_SECONDS } from "../src/server/gate.ts";
import { type CreateBody, create, type Harness, list, openEventStream, startHarness, TEST_PASSWORD } from "./harness.ts";

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.close();
});

const write = { method: "POST", headers: { "Idempotency-Key": randomUUID() } };

function login(password: unknown): Promise<Response> {
  return h.anonymous("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
}

/** Swap one character of the cookie's value, keeping it well formed. */
function tampered(cookie: string, at: "value" | "signature"): string {
  const [name, raw] = cookie.split("=") as [string, string];
  const decoded = decodeURIComponent(raw);
  const dot = decoded.lastIndexOf(".");
  const index = at === "value" ? 0 : dot + 1;
  const flipped = decoded[index] === "1" ? "2" : "1";
  return `${name}=${encodeURIComponent(decoded.slice(0, index) + flipped + decoded.slice(index + 1))}`;
}

describe("password gate", () => {
  it("refuses the list, every action and the live stream without a session", async () => {
    const created = (await (await create(h)).json()) as CreateBody;
    await h.settled();
    const id = created.container.id;

    const refused = [
      await h.anonymous("/api/containers"),
      await h.anonymous("/api/events"),
      await h.anonymous("/api/session"),
      await h.anonymous("/api/containers", write),
      ...(await Promise.all((["stop", "start", "destroy"] as const).map((a) => h.anonymous(`/api/containers/${id}/${a}`, write)))),
    ];

    for (const res of refused) {
      expect(res.status).toBe(401);
      expect(res.headers.get("content-type")).toMatch(/application\/json/);
    }
    await h.settled();
    // Nothing a stranger sent reached Railway: only the one create made with a session.
    expect(h.railway.callsTo("createContainer")).toHaveLength(1);
    expect(h.railway.callsTo("stopDeployment")).toHaveLength(0);
    expect(h.railway.callsTo("redeployService")).toHaveLength(0);
    expect(h.railway.callsTo("deleteService")).toHaveLength(0);
    expect(await list(h)).toHaveLength(1);
  });

  it("allows the list, the actions and the live stream with a session", async () => {
    expect((await h.request("/api/session")).status).toBe(200);
    expect((await h.request("/api/containers")).status).toBe(200);
    const created = await create(h);
    expect(created.status).toBe(202);
    const { container } = (await created.json()) as CreateBody;
    await h.settled();

    const stream = await h.events();
    const snapshot = await stream.next((e) => e.type === "snapshot");
    expect(snapshot).toMatchObject({ containers: [{ id: container.id }] });

    // Past the gate each action gets the container's own answer: a creating
    // container cannot be stopped or started yet (409), but can be destroyed.
    const answer = async (a: "stop" | "start" | "destroy") =>
      (await h.request(`/api/containers/${container.id}/${a}`, { method: "POST", headers: { "Idempotency-Key": randomUUID() } })).status;
    expect(await answer("stop")).toBe(409);
    expect(await answer("start")).toBe(409);
    expect(await answer("destroy")).toBe(202);
  });

  it("logs in with the right password and issues an HttpOnly, SameSite=Lax cookie that opens the app", async () => {
    const res = await login(TEST_PASSWORD);

    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(new RegExp(`^${SESSION_COOKIE}=`));
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Lax/);
    expect(setCookie).toMatch(new RegExp(`Max-Age=${SESSION_MAX_AGE_SECONDS}`));
    const cookie = setCookie.split(";")[0] ?? "";
    expect((await h.anonymous("/api/containers", { headers: { Cookie: cookie } })).status).toBe(200);
    const stream = await openEventStream(await h.anonymous("/api/events", { headers: { Cookie: cookie } }));
    await stream.close();
  });

  it.each([
    ["a wrong password", "not the password"],
    ["an empty password", ""],
    ["the right password in the wrong case", TEST_PASSWORD.toUpperCase()],
    ["a prefix of the right password", TEST_PASSWORD.slice(0, -1)],
  ])("rejects %s with a plain message and no cookie", async (_label, password) => {
    const res = await login(password);

    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(((await res.json()) as { error: string }).error).toBe("Wrong password.");
  });

  it("rejects a login that sends no password", async () => {
    const res = await h.anonymous("/api/session", { method: "POST", body: "password=x" });

    expect(res.status).toBe(400);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it.each(["value", "signature"] as const)("refuses a session cookie whose %s was tampered with", async (at) => {
    const cookie = tampered(h.sessionCookie, at);
    expect(cookie).not.toBe(h.sessionCookie);

    expect((await h.anonymous("/api/containers", { headers: { Cookie: cookie } })).status).toBe(401);
    expect((await h.anonymous("/api/events", { headers: { Cookie: cookie } })).status).toBe(401);
  });

  it("refuses an unsigned cookie with the session's name", async () => {
    const res = await h.anonymous("/api/containers", { headers: { Cookie: `${SESSION_COOKIE}=${Date.now()}` } });

    expect(res.status).toBe(401);
  });

  it("asks for the password again once a session is older than its max age", async () => {
    h.clock.advance(SESSION_MAX_AGE_SECONDS * 1000);
    expect((await h.request("/api/containers")).status).toBe(200);

    h.clock.advance(1);
    expect((await h.request("/api/containers")).status).toBe(401);
  });

  it("keeps the health check open for the platform", async () => {
    expect((await h.anonymous("/api/health")).status).toBe(200);
  });
});
