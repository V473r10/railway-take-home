import { randomUUID } from "node:crypto";
import type { Clock } from "./clock.ts";
import { type Db, transaction } from "./db.ts";
import { CONTAINER_IMAGE, type RailwayAdapter, serviceNameFor } from "./railway/adapter.ts";

export type OperationKind = "create" | "stop" | "start" | "destroy";
export type OperationStatus = "pending" | "in_progress" | "succeeded" | "failed";

export type ContainerState =
  | "creating"
  | "starting"
  | "stopping"
  | "destroying"
  | "running"
  | "stopped"
  | "failed"
  | "crashed"
  | "missing";

export type OperationView = { id: string; kind: OperationKind; status: OperationStatus };

export type ContainerView = {
  id: string;
  name: string;
  state: ContainerState;
  serviceId: string | null;
  createdAt: string;
  activeOperation: OperationView | null;
  lastError: { message: string; traceId: string | null } | null;
};

export type RequestResult = { operation: OperationView; container: ContainerView; replayed: boolean };

/** The idempotency key was already used for a different action. */
export class IdempotencyKeyReused extends Error {}

const TRANSITIONAL: Record<OperationKind, ContainerState> = {
  create: "creating",
  start: "starting",
  stop: "stopping",
  destroy: "destroying",
};

type ContainerRow = {
  id: string;
  name: string;
  service_id: string | null;
  observed_status: string | null;
  observed_stopped: boolean | null;
  created_at: Date;
  op_id: string | null;
  op_kind: OperationKind | null;
  op_status: OperationStatus | null;
  op_error: string | null;
  op_trace_id: string | null;
};

/** Container state as the user sees it: an active operation first, then the last failure, then what Railway reported. */
export function deriveState(row: ContainerRow): ContainerState {
  const active = row.op_status === "pending" || row.op_status === "in_progress";
  if (active && row.op_kind) return TRANSITIONAL[row.op_kind];
  if (row.op_status === "failed") return "failed";
  if (row.observed_status === "SUCCESS") return row.observed_stopped ? "stopped" : "running";
  if (row.observed_status === "CRASHED") return "crashed";
  return "creating";
}

function toView(row: ContainerRow): ContainerView {
  const active = row.op_status === "pending" || row.op_status === "in_progress";
  return {
    id: row.id,
    name: row.name,
    state: deriveState(row),
    serviceId: row.service_id,
    createdAt: row.created_at.toISOString(),
    activeOperation: active && row.op_id && row.op_kind && row.op_status ? { id: row.op_id, kind: row.op_kind, status: row.op_status } : null,
    lastError: row.op_status === "failed" && row.op_error ? { message: row.op_error, traceId: row.op_trace_id } : null,
  };
}

// Each container with its most recent operation.
const CONTAINERS_SQL = `
  SELECT c.id, c.name, c.service_id, c.observed_status, c.observed_stopped, c.created_at,
         o.id AS op_id, o.kind AS op_kind, o.status AS op_status, o.last_error AS op_error, o.last_trace_id AS op_trace_id
  FROM containers c
  LEFT JOIN LATERAL (
    SELECT * FROM operations WHERE container_id = c.id ORDER BY created_at DESC, id DESC LIMIT 1
  ) o ON true
  WHERE c.destroyed_at IS NULL`;

class Replay extends Error {}

export type ContainerControlDeps = { db: Db; railway: RailwayAdapter; clock: Clock; log?: (msg: string) => void };

/**
 * Owns containers and operations. Every action is recorded as an operation
 * before Railway is called, and driven to completion in the background.
 */
export class ContainerControl {
  readonly #deps: ContainerControlDeps;
  readonly #inFlight = new Set<Promise<void>>();

  constructor(deps: ContainerControlDeps) {
    this.#deps = deps;
  }

  async requestCreate(idempotencyKey: string): Promise<RequestResult> {
    const { db, clock } = this.#deps;
    const operationId = randomUUID();
    const containerId = randomUUID();
    const now = clock.now();
    try {
      await transaction(db, async (client) => {
        await client.query("INSERT INTO containers (id, name, created_at) VALUES ($1, $2, $3)", [
          containerId,
          serviceNameFor(operationId),
          now,
        ]);
        // A concurrent request with the same key waits here for the first to commit, then inserts nothing.
        const inserted = await client.query(
          `INSERT INTO operations (id, container_id, kind, status, idempotency_key, created_at, updated_at)
           VALUES ($1, $2, 'create', 'pending', $3, $4, $4)
           ON CONFLICT (idempotency_key) DO NOTHING`,
          [operationId, containerId, idempotencyKey, now],
        );
        if (inserted.rowCount === 0) throw new Replay();
      });
    } catch (error) {
      if (error instanceof Replay) return this.#replay(idempotencyKey, "create");
      throw error;
    }
    this.#track(this.#driveCreate(operationId));
    return this.#result(operationId, false);
  }

  async listContainers(): Promise<ContainerView[]> {
    const { rows } = await this.#deps.db.query<ContainerRow>(`${CONTAINERS_SQL} ORDER BY c.created_at, c.id`);
    return rows.map(toView);
  }

  /** Resolves once every operation started so far has stopped making progress. Used by tests and shutdown. */
  async settled(): Promise<void> {
    while (this.#inFlight.size > 0) await Promise.all(this.#inFlight);
  }

  async #replay(idempotencyKey: string, kind: OperationKind): Promise<RequestResult> {
    const { rows } = await this.#deps.db.query<{ id: string; kind: OperationKind }>(
      "SELECT id, kind FROM operations WHERE idempotency_key = $1",
      [idempotencyKey],
    );
    const existing = rows[0];
    if (!existing) throw new Error("idempotency conflict without an existing operation");
    if (existing.kind !== kind) throw new IdempotencyKeyReused(`key already used for ${existing.kind}`);
    return this.#result(existing.id, true);
  }

  async #result(operationId: string, replayed: boolean): Promise<RequestResult> {
    const { rows } = await this.#deps.db.query<{ id: string; kind: OperationKind; status: OperationStatus; container_id: string }>(
      "SELECT id, kind, status, container_id FROM operations WHERE id = $1",
      [operationId],
    );
    const op = rows[0]!;
    const containers = await this.#deps.db.query<ContainerRow>(`${CONTAINERS_SQL} AND c.id = $1`, [op.container_id]);
    return { operation: { id: op.id, kind: op.kind, status: op.status }, container: toView(containers.rows[0]!), replayed };
  }

  async #driveCreate(operationId: string): Promise<void> {
    const { db, railway, clock } = this.#deps;
    const { rows } = await db.query<{ container_id: string; name: string }>(
      `UPDATE operations o SET status = 'in_progress', attempts = attempts + 1, updated_at = $2
       FROM containers c WHERE o.id = $1 AND c.id = o.container_id AND o.status = 'pending'
       RETURNING o.container_id, c.name`,
      [operationId, clock.now()],
    );
    const op = rows[0];
    if (!op) return;

    const outcome = await railway.createContainer({ name: op.name, image: CONTAINER_IMAGE });
    switch (outcome.kind) {
      case "ok":
        // The operation stays in progress until the deployment is observed (live-state ticket).
        await db.query("UPDATE containers SET service_id = $2 WHERE id = $1", [op.container_id, outcome.value.serviceId]);
        return;
      case "rejected":
        await this.#fail(operationId, outcome.message, outcome.traceId);
        return;
      case "rate_limited":
        // Railway did not act. Retrying is the retries ticket's job.
        await this.#fail(operationId, "Railway rate limit reached; try again shortly.", null);
        return;
      case "ambiguous":
        // Railway may have created the service. Leave the operation active and flagged, so the
        // name lookup (retries ticket) or the startup reconciler can resolve it instead of guessing.
        await db.query(
          "UPDATE operations SET last_outcome_ambiguous = true, last_error = $2, updated_at = $3 WHERE id = $1",
          [operationId, `No response from Railway: ${outcome.reason}`, clock.now()],
        );
        return;
    }
  }

  async #fail(operationId: string, message: string, traceId: string | null): Promise<void> {
    await this.#deps.db.query(
      "UPDATE operations SET status = 'failed', last_error = $2, last_trace_id = $3, updated_at = $4 WHERE id = $1",
      [operationId, message, traceId, this.#deps.clock.now()],
    );
  }

  #track(work: Promise<void>): void {
    const tracked = work.catch((error: unknown) => {
      (this.#deps.log ?? console.error)(`operation failed unexpectedly: ${error instanceof Error ? error.stack : String(error)}`);
    });
    this.#inFlight.add(tracked);
    void tracked.finally(() => this.#inFlight.delete(tracked));
  }
}
