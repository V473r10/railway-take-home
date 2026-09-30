import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Context, Hono } from "hono";
import { getSignedCookie, setSignedCookie } from "hono/cookie";
import type { Clock } from "./clock.ts";

// A cost barrier, not an authentication system: one shared password, no
// accounts. It keeps strangers who find the URL from spending the owner's money.

export const SESSION_COOKIE = "rcc_session";
/** How long a session survives reloads before the password is asked again. */
export const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
/** Reachable without a session: logging in, and the platform's health check. */
const OPEN_ROUTES = [
  { method: "POST", path: "/api/session" },
  { method: "GET", path: "/api/health" },
];

export type GateConfig = {
  password: string;
  /** Signs the session cookie. Rotating it, or the password, ends every session. */
  secret: string;
  /** Send the cookie over HTTPS only. On in production; off for http://127.0.0.1. */
  secureCookie: boolean;
  clock: Clock;
};

/** Compare without leaking, through timing, how much of the guess was right. */
function samePassword(guess: string, password: string): boolean {
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(guess), digest(password));
}

/**
 * Put every `/api/*` route but the open ones behind a signed session cookie,
 * reads and the SSE stream included. Must be mounted before those routes.
 */
export function mountPasswordGate(app: Hono, { password, secret, secureCookie, clock }: GateConfig): void {
  // The password is part of the signing key, so changing it logs everyone out.
  const key = createHmac("sha256", secret).update(password).digest();

  const hasSession = async (c: Context): Promise<boolean> => {
    const value = await getSignedCookie(c, key, SESSION_COOKIE);
    // undefined: no cookie. false: signature does not match (tampered, or an old key).
    if (!value) return false;
    const issuedAt = Number(value);
    const age = clock.now().getTime() - issuedAt;
    return Number.isSafeInteger(issuedAt) && age >= 0 && age <= SESSION_MAX_AGE_SECONDS * 1000;
  };

  app.use("/api/*", async (c, next) => {
    const open = OPEN_ROUTES.some((r) => r.method === c.req.method && r.path === c.req.path);
    if (open || (await hasSession(c))) return next();
    return c.json({ error: "Enter the password to continue." }, 401);
  });

  // Lets the UI decide between the login screen and the app on load.
  app.get("/api/session", (c) => c.json({ ok: true }));

  app.post("/api/session", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { password?: unknown } | null;
    if (typeof body?.password !== "string") return c.json({ error: "Send the password as JSON: { \"password\": \"...\" }." }, 400);
    if (!samePassword(body.password, password)) return c.json({ error: "Wrong password." }, 401);
    await setSignedCookie(c, SESSION_COOKIE, String(clock.now().getTime()), key, {
      httpOnly: true,
      sameSite: "Lax",
      secure: secureCookie,
      path: "/",
      maxAge: SESSION_MAX_AGE_SECONDS,
    });
    return c.json({ ok: true });
  });
}
