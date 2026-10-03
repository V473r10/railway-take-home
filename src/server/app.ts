import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
  ActionRefused,
  CONTAINER_LIMIT,
  ContainerLimitReached,
  ContainerNotFound,
  type ContainerControl,
  IdempotencyKeyReused,
  ReadOnlyRefused,
} from "./containers.ts";
import { type GateConfig, mountPasswordGate } from "./gate.ts";
import { LiveFeed } from "./live.ts";

// Printable ASCII, the shape of a UUID or similar client-generated token.
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{8,200}$/;
const ACTIONS = ["stop", "start", "destroy"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SSE_RETRY_MS = 2_000;
const SSE_HEARTBEAT_MS = 20_000;

export type AppDeps = { control: ContainerControl; gate: GateConfig; webRoot?: string; log?: (msg: string) => void };

/** The HTTP API, which is also the one seam every test enters through. */
export function createApp({ control, gate, webRoot, log }: AppDeps): Hono {
  const app = new Hono();
  const feed = new LiveFeed(control, log);

  // Before every other route. The static UI below stays open so the login screen can render.
  mountPasswordGate(app, gate);

  app.get("/api/health", (c) => c.json({ ok: true }));

  app.get("/api/containers", async (c) =>
    c.json({ containers: await control.listContainers(), readOnly: control.readOnly, containerLimit: CONTAINER_LIMIT }),
  );

  // The browser's only view of state: the full list on connect, then each change (ADR 0001).
  app.get("/api/events", (c) =>
    streamSSE(c, async (stream) => {
      let writes: Promise<unknown> = Promise.resolve();
      const write = (chunk: () => Promise<unknown>) => {
        writes = writes.then(chunk).catch(() => {});
      };
      // EventSource reconnects on its own after a drop; this is how long it waits.
      write(() => stream.write(`retry: ${SSE_RETRY_MS}\n\n`));
      const disconnect = feed.connect((event) => write(() => stream.writeSSE({ event: event.type, data: JSON.stringify(event) })));
      // A comment line now and then keeps proxies from closing an idle stream.
      const heartbeat = setInterval(() => write(() => stream.write(": keep-alive\n\n")), SSE_HEARTBEAT_MS);
      await new Promise<void>((resolve) => stream.onAbort(resolve));
      clearInterval(heartbeat);
      disconnect();
    }),
  );

  // Everything the app did for one container, oldest first; live updates come over /api/events.
  app.get("/api/containers/:id/timeline", async (c) => {
    const id = c.req.param("id");
    if (!UUID.test(id)) return c.json({ error: "No such container." }, 404);
    const entries = await control.timeline.list(id);
    if (!entries) return c.json({ error: "No such container." }, 404);
    return c.json({ entries });
  });

  app.post("/api/containers", async (c) => {
    const key = c.req.header("Idempotency-Key");
    if (!key || !IDEMPOTENCY_KEY.test(key)) {
      return c.json({ error: "Every write needs an Idempotency-Key header (8-200 printable characters)." }, 400);
    }
    try {
      const result = await control.requestCreate(key);
      c.header("Idempotent-Replayed", String(result.replayed));
      return c.json({ operation: result.operation, container: result.container }, result.replayed ? 200 : 202);
    } catch (error) {
      if (error instanceof ReadOnlyRefused) return c.json({ error: error.message }, 503);
      if (error instanceof ContainerLimitReached) return c.json({ error: error.message }, 409);
      if (error instanceof IdempotencyKeyReused) return c.json({ error: "This Idempotency-Key was already used for a different action." }, 422);
      throw error;
    }
  });

  app.post("/api/containers/:id/:action{stop|start|destroy}", async (c) => {
    const key = c.req.header("Idempotency-Key");
    if (!key || !IDEMPOTENCY_KEY.test(key)) {
      return c.json({ error: "Every write needs an Idempotency-Key header (8-200 printable characters)." }, 400);
    }
    const id = c.req.param("id");
    const action = ACTIONS.find((a) => a === c.req.param("action"));
    if (!action) return c.json({ error: "Not found" }, 404);
    if (!UUID.test(id)) return c.json({ error: "No such container." }, 404);
    try {
      const result = await control.requestAction(id, action, key);
      c.header("Idempotent-Replayed", String(result.replayed));
      return c.json({ operation: result.operation, container: result.container }, result.replayed ? 200 : 202);
    } catch (error) {
      // 503, not 409: the refusal is about the app, not the container; no other action or wait helps until a restart.
      if (error instanceof ReadOnlyRefused) return c.json({ error: error.message }, 503);
      if (error instanceof ContainerNotFound) return c.json({ error: "No such container." }, 404);
      if (error instanceof ActionRefused) return c.json({ error: error.message }, 409);
      if (error instanceof IdempotencyKeyReused) return c.json({ error: "This Idempotency-Key was already used for a different action." }, 422);
      throw error;
    }
  });

  app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

  app.onError((error, c) => {
    console.error(error);
    return c.json({ error: "Internal error" }, 500);
  });

  if (webRoot && existsSync(webRoot)) {
    // serveStatic resolves `root` against the process cwd.
    app.use("/*", serveStatic({ root: relative(process.cwd(), webRoot) }));
    const index = readFile(join(webRoot, "index.html"), "utf8");
    app.get("/*", async (c) => c.html(await index));
  }

  return app;
}
