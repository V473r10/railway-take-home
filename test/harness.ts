// Test harness. Every test enters through the HTTP API; the only replaced
// dependencies are Railway (the fake) and the clock. Postgres is real: each
// harness gets its own freshly migrated database.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { createApp } from "../src/server/app.ts";
import { type Clock, ManualClock } from "../src/server/clock.ts";
import { ContainerControl } from "../src/server/containers.ts";
import { connect, type Db, migrate } from "../src/server/db.ts";
import type { CreateContainerInput, DeploymentWatch, RailwayAdapter } from "../src/server/railway/adapter.ts";
import { type FakeCall, type FakeMutation, FakeRailway } from "../src/server/railway/fake.ts";

const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres@127.0.0.1:54329/postgres";

/** The shared password and signing secret every harness app is started with. */
export const TEST_PASSWORD = "correct horse battery staple";
export const TEST_SESSION_SECRET = "test-session-secret-at-least-32-characters";

export type Harness = {
  railway: FakeRailway;
  clock: ManualClock;
  /** The app's database, for the few tests that check a guarantee the schema itself must give. */
  db: Db;
  /** Send a request to the app, as a browser would after logging in. */
  request: (path: string, init?: RequestInit) => Promise<Response>;
  /** Send a request with no session cookie (or only the cookies given), as a stranger would. */
  anonymous: (path: string, init?: RequestInit) => Promise<Response>;
  /** The session cookie the harness logged in with, as a `Cookie` header value. */
  sessionCookie: string;
  /** Wait until every operation started so far has stopped making progress. */
  settled: () => Promise<void>;
  /** Open the SSE stream, as a browser tab would. */
  events: () => Promise<EventStream>;
  /** Kill the backend process on its next call to `method`, before or after Railway acts on it. */
  dieOn: (method: FakeMutation, when: DeathPoint) => void;
  /** Whether the current backend process has died. */
  readonly dead: boolean;
  /**
   * Start a new backend process on the same database and Railway; the old one, if
   * alive, is killed. `beforeBoot` runs in between, to set up what Railway will
   * answer at startup. Open event streams are closed.
   */
  restart: (beforeBoot?: (railway: FakeRailway) => void) => Promise<void>;
  close: () => Promise<void>;
};

export async function startHarness(): Promise<Harness> {
  const name = `rcc_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  try {
    await admin.connect();
  } catch (error) {
    throw new Error(`Cannot reach the test database at ${ADMIN_URL}. Start it with \`npm run db:test\`.`, { cause: error });
  }
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  const railway = new FakeRailway();
  const clock = new ManualClock();
  const log = () => {};
  const pools: Db[] = [];
  const gate = { password: TEST_PASSWORD, secret: TEST_SESSION_SECRET, secureCookie: false, clock };

  // One backend process: its own pool and its own line to Railway, over the shared database and fake.
  const boot = async () => {
    const db: Db = connect(url.toString(), () => {});
    pools.push(db);
    await migrate(db);
    const line = new ProcessRailway(railway);
    // A killed process runs no periodic job (the lifetime sweep) either.
    const alive = new AbortController();
    const processClock: Clock = {
      now: () => clock.now(),
      sleep: (ms, signal) => clock.sleep(ms, signal),
      every: (ms, run, signal) => clock.every(ms, run, AbortSignal.any([signal, alive.signal])),
    };
    line.onKill(() => alive.abort());
    const control = new ContainerControl({ db, railway: line, clock: processClock, log });
    await control.start();
    // The identity check at boot is not something a test's own requests caused.
    const identity = railway.calls.findIndex((c) => c.method === "verifyIdentity");
    if (identity !== -1) railway.calls.splice(identity, 1);
    return { db, line, control, app: createApp({ control, gate, log }) };
  };
  let current = await boot();
  const streams = new Set<EventStream>();
  const closeStreams = async () => {
    for (const stream of streams) await stream.close();
    streams.clear();
  };

  // Log in through the real route, so every other test runs behind the gate.
  const login = await current.app.request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: TEST_PASSWORD }),
  });
  const sessionCookie = login.headers.get("set-cookie")?.split(";")[0];
  if (login.status !== 200 || !sessionCookie) throw new Error(`harness login failed: HTTP ${login.status}`);
  const withSession = (init?: RequestInit): RequestInit => {
    const headers = new Headers(init?.headers);
    if (!headers.has("Cookie")) headers.set("Cookie", sessionCookie);
    return { ...init, headers };
  };

  return {
    railway,
    clock,
    get db() {
      return current.db;
    },
    request: async (path, init) => current.app.request(path, withSession(init)),
    anonymous: async (path, init) => current.app.request(path, init),
    sessionCookie,
    settled: () => current.control.settled(),
    events: async () => {
      const stream = await openEventStream(await current.app.request("/api/events", withSession()));
      streams.add(stream);
      return stream;
    },
    dieOn: (method, when) => current.line.dieOn(method, when),
    get dead() {
      return current.line.dead;
    },
    restart: async (beforeBoot) => {
      await closeStreams();
      current.line.kill();
      beforeBoot?.(railway);
      current = await boot();
    },
    close: async () => {
      await closeStreams();
      await current.control.close();
      // A killed process's pool has nothing in flight: its drives wait on Railway forever.
      for (const pool of pools) await pool.end();
      const cleanup = new pg.Client({ connectionString: ADMIN_URL });
      await cleanup.connect();
      await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await cleanup.end();
    },
  };
}

/** When a process dies on a call: before the call reaches Railway, or after Railway acted on it. */
export type DeathPoint = "before_acting" | "after_acting";

/**
 * One process's line to Railway. Once the process is killed it gets no answer to
 * anything, in flight or new, and hears nothing from its subscriptions: whatever it
 * was doing stops there, exactly as far as Railway got, as a killed process would.
 */
class ProcessRailway implements RailwayAdapter {
  readonly #railway: FakeRailway;
  readonly #subscriptions = new Set<() => void>();
  #death: { method: FakeMutation; when: DeathPoint } | null = null;
  #dead = false;
  #onKill: Array<() => void> = [];

  constructor(railway: FakeRailway) {
    this.#railway = railway;
  }

  get dead(): boolean {
    return this.#dead;
  }

  dieOn(method: FakeMutation, when: DeathPoint): void {
    this.#death = { method, when };
  }

  kill(): void {
    this.#dead = true;
    for (const unsubscribe of this.#subscriptions) unsubscribe();
    this.#subscriptions.clear();
    for (const listener of this.#onKill) listener();
    this.#onKill = [];
  }

  onKill(listener: () => void): void {
    this.#onKill.push(listener);
  }

  async #forward<T>(method: FakeCall["method"], call: () => Promise<T>): Promise<T> {
    if (!this.#dead && this.#death?.method === method) {
      const { when } = this.#death;
      this.#death = null;
      if (when === "after_acting") await call();
      this.kill();
    }
    if (this.#dead) return new Promise<T>(() => {});
    return call();
  }

  verifyIdentity() {
    return this.#forward("verifyIdentity", () => this.#railway.verifyIdentity());
  }
  createContainer(input: CreateContainerInput) {
    return this.#forward("createContainer", () => this.#railway.createContainer(input));
  }
  findService(name: string) {
    return this.#forward("findService", () => this.#railway.findService(name));
  }
  createDomain(serviceId: string) {
    return this.#forward("createDomain", () => this.#railway.createDomain(serviceId));
  }
  serviceDomain(serviceId: string) {
    return this.#forward("serviceDomain", () => this.#railway.serviceDomain(serviceId));
  }
  latestDeployment(serviceId: string) {
    return this.#forward("latestDeployment", () => this.#railway.latestDeployment(serviceId));
  }
  readDeployment(deploymentId: string) {
    return this.#forward("readDeployment", () => this.#railway.readDeployment(deploymentId));
  }
  stopDeployment(deploymentId: string) {
    return this.#forward("stopDeployment", () => this.#railway.stopDeployment(deploymentId));
  }
  redeployService(serviceId: string) {
    return this.#forward("redeployService", () => this.#railway.redeployService(serviceId));
  }
  deleteService(serviceId: string) {
    return this.#forward("deleteService", () => this.#railway.deleteService(serviceId));
  }
  watchDeployment(deploymentId: string, watch: DeploymentWatch): () => void {
    if (this.#dead) return () => {};
    const unsubscribe = this.#railway.watchDeployment(deploymentId, {
      onState: (state) => {
        if (!this.#dead) watch.onState(state);
      },
      onEnd: (reason) => {
        if (!this.#dead) watch.onEnd(reason);
      },
    });
    this.#subscriptions.add(unsubscribe);
    return () => {
      this.#subscriptions.delete(unsubscribe);
      unsubscribe();
    };
  }
}

export type ContainerBody = {
  id: string;
  name: string;
  state: string;
  serviceId: string | null;
  url: string | null;
  createdAt: string;
  expiresAt: string;
  lastError: { message: string; traceId: string | null } | null;
  actions: Record<"stop" | "start" | "destroy", { allowed: true } | { allowed: false; reason: string }>;
};

export type CreateBody = { operation: { id: string; kind: string; status: string }; container: ContainerBody };

export function create(h: Harness, idempotencyKey: string = randomUUID()): Promise<Response> {
  return h.request("/api/containers", { method: "POST", headers: { "Idempotency-Key": idempotencyKey } });
}

export function action(h: Harness, containerId: string, kind: "stop" | "start" | "destroy", idempotencyKey: string = randomUUID()): Promise<Response> {
  return h.request(`/api/containers/${containerId}/${kind}`, { method: "POST", headers: { "Idempotency-Key": idempotencyKey } });
}

export async function list(h: Harness): Promise<ContainerBody[]> {
  const res = await h.request("/api/containers");
  return ((await res.json()) as { containers: ContainerBody[] }).containers;
}

export type LiveEvent =
  | { type: "snapshot"; containers: ContainerBody[]; readOnly: { reason: string } | null }
  | { type: "upsert"; container: ContainerBody }
  | { type: "remove"; id: string };

export type EventStream = {
  readonly events: LiveEvent[];
  /** Resolve with the first event (already received or still to come) that matches. */
  next: (match: (event: LiveEvent) => boolean, timeoutMs?: number) => Promise<LiveEvent>;
  close: () => Promise<void>;
};

/** Read an SSE response the way EventSource would: frames split by a blank line, `event:` and `data:` fields. */
export async function openEventStream(res: Response): Promise<EventStream> {
  if (res.status !== 200 || !res.body) throw new Error(`SSE stream refused: HTTP ${res.status}`);
  if (!res.headers.get("content-type")?.startsWith("text/event-stream")) throw new Error("not an event stream");
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  const events: LiveEvent[] = [];
  const waiters = new Set<() => void>();
  let buffer = "";
  let closed = false;

  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += value;
        let end = buffer.indexOf("\n\n");
        while (end !== -1) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = frame
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (data) events.push(JSON.parse(data) as LiveEvent);
          for (const wake of waiters) wake();
          end = buffer.indexOf("\n\n");
        }
      }
    } catch {
      // Cancelled by close().
    }
  })();

  return {
    events,
    next: (match, timeoutMs = 3_000) =>
      new Promise((resolve, reject) => {
        const check = () => {
          const found = events.find(match);
          if (!found) return false;
          waiters.delete(check);
          clearTimeout(timer);
          resolve(found);
          return true;
        };
        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(new Error(`no matching SSE event; received ${JSON.stringify(events)}`));
        }, timeoutMs);
        if (!check()) waiters.add(check);
      }),
    close: async () => {
      if (closed) return;
      closed = true;
      await reader.cancel().catch(() => {});
      await pump;
    },
  };
}

/** Poll a condition that becomes true asynchronously (the observer runs in the background). */
export async function eventually(condition: () => boolean | Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
