import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { systemClock } from "./clock.ts";
import { ContainerControl } from "./containers.ts";
import { connect, migrate } from "./db.ts";
import type { RailwayAdapter } from "./railway/adapter.ts";
import { FakeRailway } from "./railway/fake.ts";
import { GraphqlRailway } from "./railway/graphql.ts";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

function railwayFromEnv(): RailwayAdapter {
  // Local development without a token: the same in-memory fake the tests use.
  if (process.env.RAILWAY_FAKE === "1") {
    console.warn("RAILWAY_FAKE=1: using the in-memory fake, nothing reaches Railway");
    return new FakeRailway();
  }
  return new GraphqlRailway({
    token: required("RAILWAY_TOKEN"),
    projectId: required("SANDBOX_PROJECT_ID"),
    environmentId: required("SANDBOX_ENVIRONMENT_ID"),
  });
}

const db = connect(required("DATABASE_URL"));
await migrate(db);
const control = new ContainerControl({ db, railway: railwayFromEnv(), clock: systemClock });
const app = createApp({ control, webRoot: join(import.meta.dirname, "..", "..", "dist", "web") });

const port = Number(process.env.PORT ?? 3000);
const server = serve({ fetch: app.fetch, port, hostname: process.env.HOST ?? "127.0.0.1" }, () =>
  console.log(`listening on ${process.env.HOST ?? "127.0.0.1"}:${port}`),
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close();
    void control.settled().finally(() => db.end());
  });
}
