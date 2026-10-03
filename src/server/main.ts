import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { ChaosRailway } from "./chaos.ts";
import { systemClock } from "./clock.ts";
import { ContainerControl } from "./containers.ts";
import { connect, migrate } from "./db.ts";
import type { GateConfig } from "./gate.ts";
import type { RailwayAdapter } from "./railway/adapter.ts";
import { FakeRailway } from "./railway/fake.ts";
import { GraphqlRailway } from "./railway/graphql.ts";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

function gateFromEnv(): GateConfig {
  const secret = required("SESSION_SECRET");
  if (secret.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters");
  return {
    password: required("APP_PASSWORD"),
    secret,
    // Railway serves the app over HTTPS; local development is plain http://127.0.0.1.
    secureCookie: process.env.NODE_ENV === "production" || process.env.RAILWAY_ENVIRONMENT !== undefined,
    clock: systemClock,
  };
}

function railwayFromEnv(): RailwayAdapter {
  // Local development without a token: the same in-memory fake the tests use.
  if (process.env.RAILWAY_FAKE === "1") {
    console.warn("RAILWAY_FAKE=1: using the in-memory fake, nothing reaches Railway");
    // Deployments succeed on their own after a moment, so the UI can be exercised end to end.
    return new FakeRailway({ autoSucceedAfterMs: 1500 });
  }
  return new GraphqlRailway({
    token: required("RAILWAY_TOKEN"),
    projectId: required("SANDBOX_PROJECT_ID"),
    environmentId: required("SANDBOX_ENVIRONMENT_ID"),
  });
}

// Read before touching the database, so a missing password stops the app at once.
const gate = gateFromEnv();
const db = connect(required("DATABASE_URL"));
await migrate(db);
const railway = railwayFromEnv();
// Chaos mode: a panel in the UI to break the app on purpose (src/server/chaos.ts).
// Its kill switch relies on the process being restarted after a crash: Railway's
// ON_FAILURE restart policy does that in production, scripts/supervise.sh locally.
const chaos =
  process.env.CHAOS === "1"
    ? new ChaosRailway({ railway, db, crash: () => process.kill(process.pid, "SIGKILL"), log: console.error })
    : undefined;
if (chaos) console.warn("CHAOS=1: chaos mode is on; anyone with the password can break this app on purpose");
const control = new ContainerControl({ db, railway: chaos ?? railway, clock: systemClock });
chaos?.useTimeline(control.timeline);
await control.start();
const app = createApp({ control, gate, chaos, webRoot: join(import.meta.dirname, "..", "..", "dist", "web") });

const port = Number(process.env.PORT ?? 3000);
// Railway's proxy and health check reach the container from outside, so there the
// server listens on every interface ("::" covers IPv4 too); locally it stays on loopback.
const hostname = process.env.HOST ?? (process.env.RAILWAY_ENVIRONMENT === undefined ? "127.0.0.1" : "::");
const server = serve({ fetch: app.fetch, port, hostname }, () => console.log(`listening on ${hostname}:${port}`));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close();
    // Open SSE streams would otherwise keep the server from closing.
    if ("closeAllConnections" in server) server.closeAllConnections();
    void control.close().finally(() => db.end());
  });
}
