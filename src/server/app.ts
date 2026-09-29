import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { type ContainerControl, IdempotencyKeyReused } from "./containers.ts";

// Printable ASCII, the shape of a UUID or similar client-generated token.
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{8,200}$/;

export type AppDeps = { control: ContainerControl; webRoot?: string };

/** The HTTP API, which is also the one seam every test enters through. */
export function createApp({ control, webRoot }: AppDeps): Hono {
  const app = new Hono();

  app.get("/api/health", (c) => c.json({ ok: true }));

  app.get("/api/containers", async (c) => c.json({ containers: await control.listContainers() }));

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
