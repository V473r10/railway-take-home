import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";

export type Db = pg.Pool;

export function connect(databaseUrl: string, log: (msg: string) => void = console.error): Db {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  // An idle client can lose its connection (Postgres restart, a terminated backend).
  // Without a listener that error is uncaught and takes the process down; the pool
  // discards the client and opens a new one on the next query.
  pool.on("error", (error) => log(`idle database connection lost: ${error.message}`));
  return pool;
}

const MIGRATIONS_DIR = join(import.meta.dirname, "..", "..", "migrations");

/** Apply every migration not applied yet, in file-name order, each in its own transaction. */
export async function migrate(db: Db): Promise<void> {
  const client = await db.connect();
  try {
    // Serialise concurrent boots (two instances starting at once).
    await client.query("SELECT pg_advisory_lock(727001)");
    await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    const applied = new Set((await client.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(727001)").catch(() => {});
    client.release();
  }
}

/** Run `fn` in a transaction on one pooled client. */
export async function transaction<T>(db: Db, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
