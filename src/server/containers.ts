import { randomUUID } from "node:crypto";
import type { Clock } from "./clock.ts";
import { type Db, transaction } from "./db.ts";
import { Observer } from "./observer.ts";
import {
  CONTAINER_IMAGE,
  DEPLOYMENT_FAILED_STATUSES,
  type DeploymentState,
  type Outcome,
  type RailwayAdapter,
  serviceNameFor,
} from "./railway/adapter.ts";

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
  /** The public URL; only reachable while the container is running. */
  url: string | null;
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
  domain: string | null;
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
    url: row.domain ? `https://${row.domain}` : null,
    createdAt: row.created_at.toISOString(),
    activeOperation: active && row.op_id && row.op_kind && row.op_status ? { id: row.op_id, kind: row.op_kind, status: row.op_status } : null,
    lastError: row.op_status === "failed" && row.op_error ? { message: row.op_error, traceId: row.op_trace_id } : null,
  };
}

// Each container with its most recent operation.
const CONTAINERS_SQL = `
  SELECT c.id, c.name, c.service_id, c.domain, c.observed_status, c.observed_stopped, c.created_at,
         o.id AS op_id, o.kind AS op_kind, o.status AS op_status, o.last_error AS op_error, o.last_trace_id AS op_trace_id
  FROM containers c
  LEFT JOIN LATERAL (
    SELECT * FROM operations WHERE container_id = c.id ORDER BY created_at DESC, id DESC LIMIT 1
  ) o ON true
  WHERE c.destroyed_at IS NULL`;

class Replay extends Error {}

export type ContainerControlDeps = { db: Db; railway: RailwayAdapter; clock: Clock; log?: (msg: string) => void };

/** Told the id of a container whose view may have changed (created, moved state, gone). */
export type ChangeListener = (containerId: string) => void;

/**
 * Owns containers and operations. Every action is recorded as an operation
 * before Railway is called, and driven to completion in the background.
 */
export class ContainerControl {
  readonly #deps: ContainerControlDeps;
  readonly #inFlight = new Set<Promise<void>>();
  readonly #listeners = new Set<ChangeListener>();
  readonly #observer: Observer;

  constructor(deps: ContainerControlDeps) {
    this.#deps = deps;
    this.#observer = new Observer({
      db: deps.db,
      railway: deps.railway,
      clock: deps.clock,
      log: deps.log ?? console.error,
      onObserved: (id, state, changed) => this.#onObserved(id, state, changed),
    });
  }

  /** Begin observing the containers that already exist. */
  async start(): Promise<void> {
    await this.#observer.start();
  }

  /** Let in-flight operations finish, then stop observing Railway. */
  async close(): Promise<void> {
    await this.settled();
    await this.#observer.close();
  }

  onChange(listener: ChangeListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
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
    this.#publish(containerId);
    this.#track(this.#driveCreate(operationId));
    return this.#result(operationId, false);
  }

  async listContainers(): Promise<ContainerView[]> {
    const { rows } = await this.#deps.db.query<ContainerRow>(`${CONTAINERS_SQL} ORDER BY c.created_at, c.id`);
    return rows.map(toView);
  }

  /** One container as the user sees it, or null once it is gone. */
  async getContainer(containerId: string): Promise<ContainerView | null> {
    const { rows } = await this.#deps.db.query<ContainerRow>(`${CONTAINERS_SQL} AND c.id = $1`, [containerId]);
    return rows[0] ? toView(rows[0]) : null;
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

    const created = await railway.createContainer({ name: op.name, image: CONTAINER_IMAGE });
    if (created.kind !== "ok") return this.#unsuccessful(operationId, op.container_id, created, "creating the service");
    await db.query("UPDATE containers SET service_id = $2 WHERE id = $1", [op.container_id, created.value.serviceId]);

    // The domain comes before observing, so a container is never shown running without its URL.
    const domain = await railway.createDomain(created.value.serviceId);
    if (domain.kind === "ok") {
      await db.query("UPDATE containers SET domain = $2 WHERE id = $1", [op.container_id, domain.value.domain]);
      this.#publish(op.container_id);
    } else {
      await this.#unsuccessful(operationId, op.container_id, domain, "creating the public domain");
    }
    // Observed state is the truth either way; the operation completes when the deployment succeeds.
    this.#observer.track(op.container_id);
  }

  /** A call that did not succeed: fail the operation, or leave it active and flagged when Railway may have acted. */
  async #unsuccessful(
    operationId: string,
    containerId: string,
    outcome: Exclude<Outcome<unknown>, { kind: "ok" }>,
    step: string,
  ): Promise<void> {
    switch (outcome.kind) {
      case "rejected":
        await this.#fail(operationId, outcome.message, outcome.traceId);
        break;
      case "rate_limited":
        // Railway did not act. Retrying is the retries ticket's job.
        await this.#fail(operationId, "Railway rate limit reached; try again shortly.", null);
        break;
      case "ambiguous":
        // Railway may have acted. Leave the operation active and flagged, so the name lookup
        // (retries ticket) or the startup reconciler can resolve it instead of guessing.
        await this.#deps.db.query(
          "UPDATE operations SET last_outcome_ambiguous = true, last_error = $2, updated_at = $3 WHERE id = $1",
          [operationId, `No response from Railway while ${step}: ${outcome.reason}`, this.#deps.clock.now()],
        );
        break;
    }
    this.#publish(containerId);
  }

  /** A create completes when its deployment is observed to succeed, and fails if Railway gives up on it. */
  async #onObserved(containerId: string, state: DeploymentState, changed: boolean): Promise<void> {
    const { db, clock } = this.#deps;
    let settled = 0;
    if (state.status === "SUCCESS" && !state.stopped) {
      const result = await db.query(
        `UPDATE operations SET status = 'succeeded', updated_at = $2
         WHERE container_id = $1 AND kind = 'create' AND status = 'in_progress'`,
        [containerId, clock.now()],
      );
      settled = result.rowCount ?? 0;
    } else if (DEPLOYMENT_FAILED_STATUSES.has(state.status)) {
      const result = await db.query(
        `UPDATE operations SET status = 'failed', last_error = $2, updated_at = $3
         WHERE container_id = $1 AND kind = 'create' AND status = 'in_progress'`,
        [containerId, `Railway reports the deployment as ${state.status}.`, clock.now()],
      );
      settled = result.rowCount ?? 0;
    }
    if (changed || settled > 0) this.#publish(containerId);
  }

  #publish(containerId: string): void {
    for (const listener of this.#listeners) {
      try {
        listener(containerId);
      } catch (error) {
        (this.#deps.log ?? console.error)(`change listener failed: ${String(error)}`);
      }
    }
  }

  async #fail(operationId: string, message: string, traceId: string | null): Promise<void> {
    // Only an active operation can fail; one the observer already settled stays settled.
    await this.#deps.db.query(
      "UPDATE operations SET status = 'failed', last_error = $2, last_trace_id = $3, updated_at = $4 WHERE id = $1 AND status IN ('pending', 'in_progress')",
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
