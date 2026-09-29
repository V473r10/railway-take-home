// Test harness. Every test enters through the HTTP API; the only replaced
// dependencies are Railway (the fake) and the clock. Postgres is real: each
// harness gets its own freshly migrated database.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { createApp } from "../src/server/app.ts";
import { ManualClock } from "../src/server/clock.ts";
import { ContainerControl } from "../src/server/containers.ts";
import { connect, type Db, migrate } from "../src/server/db.ts";
import { FakeRailway } from "../src/server/railway/fake.ts";

const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres@127.0.0.1:54329/postgres";

export type Harness = {
  railway: FakeRailway;
  clock: ManualClock;
  /** Send a request to the app, as a browser would. */
  request: (path: string, init?: RequestInit) => Promise<Response>;
  /** Wait until every operation started so far has stopped making progress. */
  settled: () => Promise<void>;
  /** Open the SSE stream, as a browser tab would. */
  events: () => Promise<EventStream>;
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
  const db: Db = connect(url.toString(), () => {});
  await migrate(db);

  const railway = new FakeRailway();
  const clock = new ManualClock();
  const log = () => {};
  const control = new ContainerControl({ db, railway, clock, log });
  await control.start();
  const app = createApp({ control, log });
  const streams = new Set<EventStream>();

  return {
    railway,
    clock,
    request: async (path, init) => app.request(path, init),
    settled: () => control.settled(),
    events: async () => {
      const stream = await openEventStream(await app.request("/api/events"));
      streams.add(stream);
      return stream;
    },
    close: async () => {
      for (const stream of streams) await stream.close();
      await control.close();
      await db.end();
      const cleanup = new pg.Client({ connectionString: ADMIN_URL });
      await cleanup.connect();
      await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await cleanup.end();
    },
  };
}

export type ContainerBody = {
  id: string;
  name: string;
  state: string;
  serviceId: string | null;
  url: string | null;
  lastError: { message: string; traceId: string | null } | null;
};

export type CreateBody = { operation: { id: string; kind: string; status: string }; container: ContainerBody };

export function create(h: Harness, idempotencyKey: string = randomUUID()): Promise<Response> {
  return h.request("/api/containers", { method: "POST", headers: { "Idempotency-Key": idempotencyKey } });
}

export async function list(h: Harness): Promise<ContainerBody[]> {
  const res = await h.request("/api/containers");
  return ((await res.json()) as { containers: ContainerBody[] }).containers;
}

export type LiveEvent =
  | { type: "snapshot"; containers: ContainerBody[] }
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
