import type { ArmedFault } from "./chaos.ts";
import type { Clock } from "./clock.ts";
import type { OperationKind } from "./containers.ts";
import type { Db } from "./db.ts";

/** A call to Railway, by the name of its GraphQL field. */
export type RailwayCall =
  | "serviceCreate"
  | "serviceDomainCreate"
  | "deploymentStop"
  | "serviceInstanceRedeploy"
  | "serviceDelete"
  | "services"
  | "domains"
  | "deployment";

/** Who asked for an operation. */
export type RequestedBy = "user" | "lifetime";

/** One step in a container's life, as the timeline shows it. */
export type TimelineEvent =
  | { kind: "requested"; operation: OperationKind; by: RequestedBy }
  /** The operation started being driven; `resumed` when a new process took over one a dead process left. */
  | { kind: "began"; operation: OperationKind; resumed: boolean }
  /** One attempt of a call to Railway and how it ended (ADR 0004). */
  | {
      kind: "call";
      call: RailwayCall;
      attempt: number;
      outcome: "ok" | "rejected" | "rate_limited" | "ambiguous";
      message?: string;
      traceId?: string | null;
    }
  /** After an ambiguous call, a look at Railway before repeating it: did the call act? */
  | { kind: "lookup"; call: RailwayCall; result: "acted" | "not_acted" | "unknown"; message?: string }
  /** A Start found the deployment its redeploy produced. */
  | { kind: "deployment"; deploymentId: string }
  /** The state Railway reports for the current deployment changed. */
  | { kind: "observed"; deploymentId: string; status: string; stopped: boolean }
  | { kind: "succeeded"; operation: OperationKind }
  | { kind: "failed"; operation: OperationKind; message: string }
  /** Every retry of a call that may have acted went unanswered: the operation stays active and flagged for the reconciler. */
  | { kind: "unanswered"; operation: OperationKind; message: string }
  /** The service was found deleted outside the app. */
  | { kind: "missing" }
  /** The deployment was replaced outside the app (a redeploy from Railway's dashboard); the container follows the new one. */
  | { kind: "followed"; deploymentId: string }
  /** Chaos mode broke something on purpose here (src/server/chaos.ts); `call` is the call an armed fault hit. */
  | { kind: "chaos"; fault: ArmedFault | "delete_outside" | "cut_subscriptions" | "crash_now"; call?: RailwayCall };

export type TimelineEntry = TimelineEvent & {
  /** Insertion order; a string because Postgres bigints do not fit a JS number in general. */
  seq: string;
  containerId: string;
  operationId: string | null;
  at: string;
};

export type TimelineListener = (entry: TimelineEntry) => void;

/** At most this many entries are returned for one container, the newest ones. */
export const TIMELINE_LIMIT = 300;

type Row = { seq: string; container_id: string; operation_id: string | null; at: Date; kind: string; detail: Record<string, unknown> };

function toEntry(row: Row): TimelineEntry {
  return {
    ...(row.detail as object),
    kind: row.kind,
    seq: row.seq,
    containerId: row.container_id,
    operationId: row.operation_id,
    at: row.at.toISOString(),
  } as TimelineEntry;
}

/**
 * Each container's timeline. A record of what the app did, kept for people (the UI,
 * a reviewer, whoever debugs a trace id): nothing reads it to decide anything, so a
 * failed write is logged and dropped rather than allowed to fail the operation it describes.
 */
export class Timeline {
  readonly #db: Db;
  readonly #clock: Clock;
  readonly #log: (msg: string) => void;
  readonly #listeners = new Set<TimelineListener>();

  constructor(db: Db, clock: Clock, log: (msg: string) => void) {
    this.#db = db;
    this.#clock = clock;
    this.#log = log;
  }

  async record(containerId: string, operationId: string | null, event: TimelineEvent): Promise<void> {
    const { kind, ...detail } = event;
    let row: Row | undefined;
    try {
      const { rows } = await this.#db.query<Row>(
        `INSERT INTO timeline_entries (container_id, operation_id, at, kind, detail) VALUES ($1, $2, $3, $4, $5)
         RETURNING seq::text, container_id, operation_id, at, kind, detail`,
        [containerId, operationId, this.#clock.now(), kind, detail],
      );
      row = rows[0];
    } catch (error) {
      this.#log(`timeline: could not record ${kind} for ${containerId}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (!row) return;
    const entry = toEntry(row);
    for (const listener of this.#listeners) {
      try {
        listener(entry);
      } catch (error) {
        this.#log(`timeline listener failed: ${String(error)}`);
      }
    }
  }

  /** The container's newest entries, oldest first; null if no such container ever existed. */
  async list(containerId: string): Promise<TimelineEntry[] | null> {
    const exists = await this.#db.query("SELECT 1 FROM containers WHERE id = $1", [containerId]);
    if (!exists.rowCount) return null;
    const { rows } = await this.#db.query<Row>(
      `SELECT * FROM (
         SELECT seq::text, container_id, operation_id, at, kind, detail FROM timeline_entries
         WHERE container_id = $1 ORDER BY seq DESC LIMIT $2
       ) newest ORDER BY seq::bigint`,
      [containerId, TIMELINE_LIMIT],
    );
    return rows.map(toEntry);
  }

  onEntry(listener: TimelineListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}
