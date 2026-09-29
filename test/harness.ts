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
  const control = new ContainerControl({ db, railway, clock });
  const app = createApp({ control });

  return {
    railway,
    clock,
    request: async (path, init) => app.request(path, init),
    settled: () => control.settled(),
    close: async () => {
      await control.settled();
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
