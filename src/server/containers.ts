import { randomUUID } from "node:crypto";
import type { Clock } from "./clock.ts";
import { type Db, transaction } from "./db.ts";
import { Observer } from "./observer.ts";
import { type Lookup, lookupFrom, withRetries } from "./retry.ts";
import {
  CONTAINER_IMAGE,
  DEPLOYMENT_FAILED_STATUSES,
  type DeploymentState,
  type Outcome,
  type PublicDomain,
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

/** Whether an action can be requested right now, and if not, the message that says why. */
export type Availability = { allowed: true } | { allowed: false; reason: string };

/** The actions a user requests on an existing container. */
export type ContainerAction = "stop" | "start" | "destroy";

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
  /** Computed by the same rule that refuses a request, so the UI and the API cannot disagree. */
  actions: Record<ContainerAction, Availability>;
};

/** `container` is null once the container is gone (a replayed Destroy). */
export type RequestResult = { operation: OperationView; container: ContainerView | null; replayed: boolean };

/** The idempotency key was already used for a different action. */
export class IdempotencyKeyReused extends Error {}

/** No such container, or it is gone. */
export class ContainerNotFound extends Error {}

/** The action cannot be requested in the container's current state; the message is shown to the user. */
export class ActionRefused extends Error {}

const TRANSITIONAL: Record<OperationKind, ContainerState> = {
  create: "creating",
  start: "starting",
  stop: "stopping",
  destroy: "destroying",
};

const LABEL: Record<OperationKind, string> = { create: "Create", start: "Start", stop: "Stop", destroy: "Destroy" };

/** How many times a Start looks for the deployment its redeploy produced before giving up. */
export const NEW_DEPLOYMENT_LOOKUPS = 8;
const LOOKUP_BACKOFF_MS = 1_000;
const MAX_LOOKUP_BACKOFF_MS = 30_000;

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

function isActive(status: OperationStatus | null): boolean {
  return status === "pending" || status === "in_progress";
}

/** Container state as the user sees it: an active operation first, then the last failure, then what Railway reported. */
export function deriveState(row: ContainerRow): ContainerState {
  if (isActive(row.op_status) && row.op_kind) return TRANSITIONAL[row.op_kind];
  if (row.op_status === "failed") return "failed";
  if (row.observed_status === "SUCCESS") return row.observed_stopped ? "stopped" : "running";
  if (row.observed_status === "CRASHED") return "crashed";
  return "creating";
}

/**
 * Whether Stop or Start can be requested. Decided from what Railway last reported,
 * not from the derived state: a failed Start leaves a stopped container that can be
 * started again. The database's one-active-operation index backs the first rule.
 */
export function availability(row: ContainerRow, action: ContainerAction): Availability {
  const refuse = (reason: string): Availability => ({ allowed: false, reason });
  // Destroy is the way out: it is accepted whatever else is happening, once.
  if (action === "destroy") {
    return isActive(row.op_status) && row.op_kind === "destroy" ? refuse("The container is already being destroyed.") : { allowed: true };
  }
  if (isActive(row.op_status) && row.op_kind) return refuse(`Wait for ${LABEL[row.op_kind]} to finish.`);
  if (!row.service_id) return refuse("This container has no Railway service.");
  const running = row.observed_status === "SUCCESS" && row.observed_stopped === false;
  if (action === "stop") return running ? { allowed: true } : refuse("Only a running container can be stopped.");
  if (running) return refuse("The container is already running.");
  if (row.observed_status === null) return refuse("Railway has not reported this container's deployment yet.");
  return { allowed: true };
}

function toView(row: ContainerRow): ContainerView {
  return {
    id: row.id,
    name: row.name,
    state: deriveState(row),
    serviceId: row.service_id,
    url: row.domain ? `https://${row.domain}` : null,
    createdAt: row.created_at.toISOString(),
    activeOperation:
      isActive(row.op_status) && row.op_id && row.op_kind && row.op_status ? { id: row.op_id, kind: row.op_kind, status: row.op_status } : null,
    lastError: row.op_status === "failed" && row.op_error ? { message: row.op_error, traceId: row.op_trace_id } : null,
    actions: { stop: availability(row, "stop"), start: availability(row, "start"), destroy: availability(row, "destroy") },
  };
}

// Each container with its most recent operation.
const CONTAINERS_SQL = `
  SELECT c.id, c.name, c.service_id, c.domain, c.observed_status, c.observed_stopped, c.created_at,
         o.id AS op_id, o.kind AS op_kind, o.status AS op_status, o.last_error AS op_error, o.last_trace_id AS op_trace_id
  FROM containers c
  LEFT JOIN LATERAL (
    SELECT * FROM operations WHERE container_id = c.id ORDER BY seq DESC LIMIT 1
  ) o ON true
  WHERE c.destroyed_at IS NULL`;

class Replay extends Error {}

type BegunOperation = {
  container_id: string;
  name: string;
  service_id: string | null;
  domain: string | null;
  /** The container's current deployment when the drive began. */
  deployment_id: string | null;
  /** A Start's: the deployment its redeploy replaces. */
  replaced_deployment_id: string | null;
  /** A previous process already began this operation and stopped before it finished. */
  resumed: boolean;
};

const RETRY = { kind: "retry" } as const;

function done<T>(value: T): Lookup<T> {
  return { kind: "done", outcome: { kind: "ok", value } };
}

/** A Postgres unique violation of one named constraint or index. */
function isUniqueViolation(error: unknown, constraint: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "23505" &&
    (error as { constraint?: unknown }).constraint === constraint
  );
}

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
  readonly #closing = new AbortController();
  /** Per container, the drive in flight for it, so a Destroy can interrupt it and wait for it. */
  readonly #drives = new Map<string, { done: Promise<void>; abort: AbortController }>();

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

  /**
   * Reconcile, then observe. An operation still active in the database was left by a
   * process that stopped mid-way, so Railway may or may not have acted on its last call.
   * Each one is resumed: it looks at Railway first and then does only what is still
   * missing, so nothing is duplicated (ADR 0004). Every resumed drive is claimed here,
   * before the app accepts requests, and the one-active-operation rule keeps a new
   * request from interleaving with it; Destroy can still interrupt it, as always.
   */
  async start(): Promise<void> {
    const { rows } = await this.#deps.db.query<{ id: string; kind: OperationKind; container_id: string }>(
      "SELECT id, kind, container_id FROM operations WHERE status IN ('pending', 'in_progress') ORDER BY seq",
    );
    // A Destroy supersedes whatever else its container was doing; only the Destroy is resumed.
    const destroying = new Set(rows.filter((r) => r.kind === "destroy").map((r) => r.container_id));
    const resumed = rows.filter((r) => r.kind === "destroy" || !destroying.has(r.container_id));
    // A resumed Create, Start or Destroy decides itself when its container is watched.
    await this.#observer.start(new Set(resumed.filter((r) => r.kind !== "stop").map((r) => r.container_id)));
    if (resumed.length > 0) (this.#deps.log ?? console.error)(`reconciling ${resumed.length} operation(s) left active by a previous process`);
    for (const op of resumed) {
      if (op.kind === "destroy") this.#track(this.#driveDestroy(op.id, op.container_id, { resume: true }));
      else if (op.kind === "create") this.#trackDrive(op.container_id, (signal) => this.#driveCreate(op.id, signal, { resume: true }));
      else if (op.kind === "stop") this.#trackDrive(op.container_id, (signal) => this.#driveStop(op.id, signal, { resume: true }));
      else this.#trackDrive(op.container_id, (signal) => this.#driveStart(op.id, signal, { resume: true }));
    }
  }

  /** Let in-flight operations finish, then stop observing Railway. */
  async close(): Promise<void> {
    // A Start still looking for its new deployment stops waiting; the next boot's observer picks it up.
    this.#closing.abort();
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
    this.#trackDrive(containerId, (signal) => this.#driveCreate(operationId, signal));
    return this.#result(operationId, false);
  }

  /**
   * Record a Stop, Start or Destroy. The container row is locked first, so a
   * concurrent request for the same container waits here and then sees this one as active.
   */
  async requestAction(containerId: string, action: ContainerAction, idempotencyKey: string): Promise<RequestResult> {
    const { db, clock } = this.#deps;
    const operationId = randomUUID();
    const now = clock.now();
    try {
      await transaction(db, async (client) => {
        // A replay first: the container may be gone because of this very request (a Destroy sent twice).
        const seen = await client.query("SELECT 1 FROM operations WHERE idempotency_key = $1", [idempotencyKey]);
        if ((seen.rowCount ?? 0) > 0) throw new Replay();
        const locked = await client.query("SELECT id FROM containers WHERE id = $1 AND destroyed_at IS NULL FOR UPDATE", [containerId]);
        if (locked.rowCount === 0) throw new ContainerNotFound();
        // Checked after the lock: a request with the same key that got there first has committed by now.
        const used = await client.query("SELECT 1 FROM operations WHERE idempotency_key = $1", [idempotencyKey]);
        if ((used.rowCount ?? 0) > 0) throw new Replay();

        const { rows } = await client.query<ContainerRow>(`${CONTAINERS_SQL} AND c.id = $1`, [containerId]);
        const row = rows[0];
        if (!row) throw new ContainerNotFound();
        const allowed = availability(row, action);
        if (!allowed.allowed) throw new ActionRefused(allowed.reason);

        const inserted = await client.query(
          `INSERT INTO operations (id, container_id, kind, status, idempotency_key, created_at, updated_at)
           VALUES ($1, $2, $3, 'pending', $4, $5, $5)
           ON CONFLICT (idempotency_key) DO NOTHING`,
          [operationId, containerId, action, idempotencyKey, now],
        );
        if (inserted.rowCount === 0) throw new Replay();
      });
    } catch (error) {
      if (error instanceof Replay) return this.#replay(idempotencyKey, action, containerId);
      // Unreachable while the row lock above holds; the indexes are what guarantee it regardless.
      if (isUniqueViolation(error, "operations_one_active_per_container")) throw new ActionRefused("Wait for the current operation to finish.");
      if (isUniqueViolation(error, "operations_one_active_destroy_per_container")) throw new ActionRefused("The container is already being destroyed.");
      throw error;
    }
    this.#publish(containerId);
    if (action === "destroy") this.#track(this.#driveDestroy(operationId, containerId));
    else if (action === "stop") this.#trackDrive(containerId, (signal) => this.#driveStop(operationId, signal));
    else this.#trackDrive(containerId, (signal) => this.#driveStart(operationId, signal));
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

  async #replay(idempotencyKey: string, kind: OperationKind, containerId?: string): Promise<RequestResult> {
    const { rows } = await this.#deps.db.query<{ id: string; kind: OperationKind; container_id: string }>(
      "SELECT id, kind, container_id FROM operations WHERE idempotency_key = $1",
      [idempotencyKey],
    );
    const existing = rows[0];
    if (!existing) throw new Error("idempotency conflict without an existing operation");
    if (existing.kind !== kind || (containerId !== undefined && existing.container_id !== containerId)) {
      throw new IdempotencyKeyReused(`key already used for ${existing.kind} on another request`);
    }
    return this.#result(existing.id, true);
  }

  async #result(operationId: string, replayed: boolean): Promise<RequestResult> {
    const { rows } = await this.#deps.db.query<{ id: string; kind: OperationKind; status: OperationStatus; container_id: string }>(
      "SELECT id, kind, status, container_id FROM operations WHERE id = $1",
      [operationId],
    );
    const op = rows[0];
    if (!op) throw new Error(`operation ${operationId} vanished`);
    const container = await this.getContainer(op.container_id);
    return { operation: { id: op.id, kind: op.kind, status: op.status }, container, replayed };
  }

  async #driveCreate(operationId: string, signal: AbortSignal, { resume = false } = {}): Promise<void> {
    const { db, railway } = this.#deps;
    const op = await this.#begin(operationId, { resume });
    if (!op) return;

    let serviceId = op.service_id;
    if (!serviceId && op.resumed) {
      // The previous process may have created the service and died before recording it.
      const found = await this.#call(operationId, () => railway.findService(op.name), { signal });
      if (found.kind !== "ok") return this.#unsuccessful(operationId, op.container_id, found, "looking for the service");
      serviceId = found.value?.serviceId ?? null;
    }
    if (!serviceId) {
      // serviceCreate takes no idempotency key, so before repeating a create that may have
      // acted, look for the service by the name this operation gave it (ADR 0004).
      const created = await this.#call(operationId, () => railway.createContainer({ name: op.name, image: CONTAINER_IMAGE }), {
        signal,
        lookup: async () => lookupFrom(await railway.findService(op.name), (found) => (found ? done(found) : RETRY)),
      });
      if (created.kind !== "ok") return this.#unsuccessful(operationId, op.container_id, created, "creating the service");
      serviceId = created.value.serviceId;
    }
    // Recorded even when a Destroy is waiting, so the Destroy knows which service to delete.
    if (serviceId !== op.service_id) await db.query("UPDATE containers SET service_id = $2 WHERE id = $1", [op.container_id, serviceId]);
    if (signal.aborted) return;

    // The domain comes before observing, so a container is never shown running without its URL.
    if (!op.domain) {
      const domain = await this.#domainFor(operationId, serviceId, op.resumed, signal);
      if (domain.kind === "ok") {
        await db.query("UPDATE containers SET domain = $2 WHERE id = $1", [op.container_id, domain.value.domain]);
        this.#publish(op.container_id);
      } else {
        await this.#unsuccessful(operationId, op.container_id, domain, "creating the public domain");
      }
    }
    // Observed state is the truth either way; the operation completes when the deployment succeeds.
    this.#observer.track(op.container_id);
  }

  /** The service's public domain: the one it has, when resuming, or a new one. */
  async #domainFor(operationId: string, serviceId: string, resumed: boolean, signal: AbortSignal): Promise<Outcome<PublicDomain>> {
    const { railway } = this.#deps;
    if (resumed) {
      const found = await this.#call(operationId, () => railway.serviceDomain(serviceId), { signal });
      if (found.kind !== "ok") return found;
      if (found.value) return { kind: "ok", value: found.value };
    }
    return this.#call(operationId, () => railway.createDomain(serviceId), {
      signal,
      lookup: async () => lookupFrom(await railway.serviceDomain(serviceId), (found) => (found ? done(found) : RETRY)),
    });
  }

  /**
   * Mark an operation in progress and load what driving it needs. Null if it is not
   * pending anymore; when resuming, one a previous process left in progress is taken too.
   * A Start (`clearDeployment`) records the deployment it replaces and clears the
   * container's current one, unless a resumed Start already recorded its new one.
   */
  async #begin(operationId: string, { clearDeployment = false, resume = false } = {}): Promise<BegunOperation | null> {
    const { db, clock } = this.#deps;
    return transaction(db, async (client) => {
      const prior = await client.query<{ status: OperationStatus }>("SELECT status FROM operations WHERE id = $1 FOR UPDATE", [operationId]);
      const status = prior.rows[0]?.status;
      const resumed = resume && status === "in_progress";
      if (status !== "pending" && !resumed) return null;
      const { rows } = await client.query<Omit<BegunOperation, "resumed">>(
        `UPDATE operations o SET status = 'in_progress', attempts = attempts + 1, updated_at = $2
         FROM containers c WHERE o.id = $1 AND c.id = o.container_id
         RETURNING o.container_id, c.name, c.service_id, c.domain, c.current_deployment_id AS deployment_id, o.replaced_deployment_id`,
        [operationId, clock.now()],
      );
      const row = rows[0];
      if (!row) return null;
      const op: BegunOperation = { ...row, resumed };
      if (clearDeployment && !resumed) {
        op.replaced_deployment_id = op.deployment_id;
        await client.query("UPDATE operations SET replaced_deployment_id = $2 WHERE id = $1", [operationId, op.deployment_id]);
      }
      const recordedNew = resumed && op.deployment_id !== null && op.deployment_id !== op.replaced_deployment_id;
      if (clearDeployment && !recordedNew) await client.query("UPDATE containers SET current_deployment_id = NULL WHERE id = $1", [op.container_id]);
      return op;
    });
  }

  /** A Stop completes when the observer sees the deployment stopped. */
  async #driveStop(operationId: string, signal: AbortSignal, { resume = false } = {}): Promise<void> {
    const { railway } = this.#deps;
    const op = await this.#begin(operationId, { resume });
    if (!op) return;
    const deploymentId = op.deployment_id;
    if (!deploymentId) return this.#failAndPublish(operationId, op.container_id, "The container has no deployment to stop.");
    if (op.resumed) {
      const seen = await this.#call(operationId, () => railway.readDeployment(deploymentId), { signal });
      if (seen.kind !== "ok") return this.#unsuccessful(operationId, op.container_id, seen, "reading the deployment");
      // The previous process's stop did act: the observer completes the Stop from what it reads.
      if (seen.value.stopped) return;
    }
    const stopped = await this.#call(operationId, () => railway.stopDeployment(deploymentId), {
      signal,
      lookup: async () => lookupFrom(await railway.readDeployment(deploymentId), (state) => (state.stopped ? done(undefined) : RETRY)),
    });
    if (stopped.kind !== "ok") return this.#unsuccessful(operationId, op.container_id, stopped, "stopping the deployment");
  }

  /**
   * A Start redeploys the service, which makes a new deployment with a new id.
   * The current deployment is cleared while that happens, so nothing the old one
   * reports (Railway removes it) is stored as the container's state; a process that
   * dies here leaves it cleared, and the next boot resumes the Start from the replaced
   * deployment recorded on the operation.
   */
  async #driveStart(operationId: string, signal: AbortSignal, { resume = false } = {}): Promise<void> {
    const { db, railway } = this.#deps;
    const op = await this.#begin(operationId, { clearDeployment: true, resume });
    if (!op) return;
    const serviceId = op.service_id;
    const replaced = op.replaced_deployment_id;
    if (op.resumed && op.deployment_id !== null && op.deployment_id !== replaced) {
      // The previous process recorded the new deployment; the observer completes the Start.
      this.#observer.track(op.container_id);
      return;
    }
    this.#observer.untrack(op.container_id);
    const restore = async () => {
      await db.query("UPDATE containers SET current_deployment_id = $2 WHERE id = $1 AND current_deployment_id IS NULL", [
        op.container_id,
        replaced,
      ]);
      this.#observer.track(op.container_id);
    };
    if (!serviceId) {
      await restore();
      return this.#failAndPublish(operationId, op.container_id, "The container has no Railway service to start.");
    }

    if (op.resumed) {
      // The previous process's redeploy may have acted: a deployment newer than the replaced one says so.
      const latest = await this.#call(operationId, () => railway.latestDeployment(serviceId), { signal });
      if (latest.kind !== "ok") {
        await restore();
        return this.#unsuccessful(operationId, op.container_id, latest, "looking for the new deployment");
      }
      if (latest.value && latest.value.deploymentId !== replaced) return this.#adoptDeployment(operationId, op.container_id, latest.value);
    }

    // A redeploy that acted shows up as a newer deployment; only without one is it repeated.
    const redeployed = await this.#call(operationId, () => railway.redeployService(serviceId), {
      signal,
      lookup: async () =>
        lookupFrom(await railway.latestDeployment(serviceId), (latest) =>
          latest && latest.deploymentId !== replaced ? done(undefined) : RETRY,
        ),
    });
    if (redeployed.kind === "rejected" || redeployed.kind === "rate_limited") {
      // Railway did not act: the old deployment is still the current one.
      await restore();
      return this.#unsuccessful(operationId, op.container_id, redeployed, "redeploying the service");
    }
    if (redeployed.kind === "ambiguous") {
      // Railway may have started a new deployment; looking for one below tells.
      await this.#unsuccessful(operationId, op.container_id, redeployed, "redeploying the service");
    }

    const found = await this.#newDeployment(serviceId, replaced, signal);
    if (found === "interrupted") return;
    if (found === null) {
      await restore();
      if (redeployed.kind === "ambiguous") return; // stays flagged for the reconciler
      return this.#failAndPublish(operationId, op.container_id, "Railway did not report a new deployment after the redeploy.");
    }
    await this.#adoptDeployment(operationId, op.container_id, found);
  }

  /** Make a Start's new deployment the container's current one, and watch it. */
  async #adoptDeployment(operationId: string, containerId: string, found: DeploymentState): Promise<void> {
    const { db, clock } = this.#deps;
    await transaction(db, async (client) => {
      await client.query(
        `UPDATE containers SET current_deployment_id = $2, observed_status = $3, observed_stopped = $4, observed_at = $5
         WHERE id = $1 AND current_deployment_id IS NULL`,
        [containerId, found.deploymentId, found.status, found.stopped, clock.now()],
      );
      // A new deployment exists, so an ambiguous redeploy did happen.
      await client.query("UPDATE operations SET last_outcome_ambiguous = false, last_error = NULL WHERE id = $1", [operationId]);
    });
    this.#publish(containerId);
    this.#observer.track(containerId);
  }

  /**
   * The deployment a redeploy produced: the service's latest one once it is not the
   * one it replaced. Railway may list the old one for a moment, so it asks a few times.
   */
  async #newDeployment(serviceId: string, replaced: string | null, signal: AbortSignal): Promise<DeploymentState | null | "interrupted"> {
    const { railway, clock } = this.#deps;
    let backoff = LOOKUP_BACKOFF_MS;
    for (let attempt = 1; attempt <= NEW_DEPLOYMENT_LOOKUPS; attempt++) {
      const outcome = await railway.latestDeployment(serviceId);
      if (outcome.kind === "ok" && outcome.value && outcome.value.deploymentId !== replaced) return outcome.value;
      if (outcome.kind === "rejected") return null;
      if (attempt === NEW_DEPLOYMENT_LOOKUPS) break;
      try {
        await clock.sleep(outcome.kind === "rate_limited" ? outcome.retryAfterMs : backoff, signal);
      } catch {
        return "interrupted";
      }
      backoff = Math.min(backoff * 2, MAX_LOOKUP_BACKOFF_MS);
    }
    return null;
  }

  /**
   * Destroy supersedes whatever else the container is doing. It interrupts and
   * waits for the drive in flight first: a Create still waiting on serviceCreate
   * would otherwise record a service after it was deleted, or leave one nobody tracks.
   */
  async #driveDestroy(operationId: string, containerId: string, { resume = false } = {}): Promise<void> {
    const { db, railway, clock } = this.#deps;
    const prior = this.#drives.get(containerId);
    if (prior) {
      prior.abort.abort();
      await prior.done;
    }
    const op = await this.#begin(operationId, { resume });
    if (!op) return;
    await db.query(
      `UPDATE operations SET status = 'failed', last_error = 'Superseded by Destroy.', updated_at = $2
       WHERE container_id = $1 AND kind <> 'destroy' AND status IN ('pending', 'in_progress')`,
      [containerId, clock.now()],
    );
    this.#observer.untrack(containerId);

    let serviceId = op.service_id;
    // A resumed Destroy may have deleted the service already, and a create Railway never
    // confirmed may have made one anyway. Either way the container's name tells.
    if (op.resumed || (!serviceId && (await this.#createWasAmbiguous(containerId)))) {
      const found = await this.#call(operationId, () => railway.findService(op.name), { signal: this.#closing.signal });
      if (found.kind !== "ok") {
        this.#observer.track(containerId);
        return this.#unsuccessful(operationId, containerId, found, "looking for the service");
      }
      serviceId = found.value?.serviceId ?? null;
    }
    if (serviceId) {
      const target = serviceId;
      // A delete that acted leaves no service with the container's name; only then is it not repeated.
      const deleted = await this.#call(operationId, () => railway.deleteService(target), {
        signal: this.#closing.signal,
        lookup: async () => lookupFrom(await railway.findService(op.name), (found) => (found ? RETRY : done(undefined))),
      });
      if (deleted.kind !== "ok") {
        this.#observer.track(containerId);
        return this.#unsuccessful(operationId, containerId, deleted, "deleting the service");
      }
    }
    await transaction(db, async (client) => {
      await client.query("UPDATE containers SET destroyed_at = $2 WHERE id = $1", [containerId, clock.now()]);
      await client.query("UPDATE operations SET status = 'succeeded', updated_at = $2 WHERE id = $1", [operationId, clock.now()]);
    });
    this.#publish(containerId);
  }

  async #failAndPublish(operationId: string, containerId: string, message: string): Promise<void> {
    await this.#fail(operationId, message, null);
    this.#publish(containerId);
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
        // Railway did not act, and still refused after every retry.
        await this.#fail(operationId, "Railway rate limit reached; try again shortly.", null);
        break;
      case "ambiguous":
        // Railway may have acted and every retry went unanswered. Leave the operation active
        // and flagged, so the startup reconciler can resolve it instead of guessing.
        await this.#deps.db.query(
          "UPDATE operations SET last_outcome_ambiguous = true, last_error = $2, updated_at = $3 WHERE id = $1",
          [operationId, `No response from Railway while ${step}: ${outcome.reason}`, this.#deps.clock.now()],
        );
        break;
    }
    this.#publish(containerId);
  }

  /**
   * An operation completes when Railway is observed to reach what it asked for:
   * Create and Start a running deployment, Stop a stopped one. Any of them fails
   * if Railway gives up on the deployment.
   */
  async #onObserved(containerId: string, state: DeploymentState, changed: boolean): Promise<void> {
    const { db, clock } = this.#deps;
    let settled = 0;
    if (state.status === "SUCCESS") {
      const kinds = state.stopped ? ["stop"] : ["create", "start"];
      const result = await db.query(
        `UPDATE operations SET status = 'succeeded', updated_at = $2
         WHERE container_id = $1 AND kind = ANY($3) AND status = 'in_progress'`,
        [containerId, clock.now(), kinds],
      );
      settled = result.rowCount ?? 0;
    } else if (DEPLOYMENT_FAILED_STATUSES.has(state.status)) {
      const result = await db.query(
        `UPDATE operations SET status = 'failed', last_error = $2, updated_at = $3
         WHERE container_id = $1 AND kind IN ('create', 'start', 'stop') AND status = 'in_progress'`,
        [containerId, `Railway reports the deployment as ${state.status}.`, clock.now()],
      );
      settled = result.rowCount ?? 0;
    }
    if (changed || settled > 0) this.#publish(containerId);
  }

  /**
   * One call to Railway under the retry policy (ADR 0004). While an attempt's outcome is
   * unknown the operation stays flagged in the database, so a process that dies mid-retry
   * leaves the reconciler a trace; the flag is cleared once Railway's answer is known.
   */
  async #call<T>(
    operationId: string,
    call: () => Promise<Outcome<T>>,
    options: { signal: AbortSignal; lookup?: () => Promise<Lookup<T>> },
  ): Promise<Outcome<T>> {
    const { db, clock } = this.#deps;
    let flagged = false;
    const outcome = await withRetries(call, {
      clock,
      signal: options.signal,
      lookup: options.lookup,
      onAmbiguous: async () => {
        if (flagged) return;
        flagged = true;
        await db.query("UPDATE operations SET last_outcome_ambiguous = true, updated_at = $2 WHERE id = $1", [operationId, clock.now()]);
      },
    });
    if (flagged && outcome.kind !== "ambiguous") {
      await db.query("UPDATE operations SET last_outcome_ambiguous = false WHERE id = $1", [operationId]);
    }
    return outcome;
  }

  /** Whether the container's create ended without Railway ever answering it. */
  async #createWasAmbiguous(containerId: string): Promise<boolean> {
    const { rows } = await this.#deps.db.query<{ ambiguous: boolean }>(
      "SELECT last_outcome_ambiguous AS ambiguous FROM operations WHERE container_id = $1 AND kind = 'create'",
      [containerId],
    );
    return rows[0]?.ambiguous === true;
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

  #track(work: Promise<void>): Promise<void> {
    const tracked = work.catch((error: unknown) => {
      (this.#deps.log ?? console.error)(`operation failed unexpectedly: ${error instanceof Error ? error.stack : String(error)}`);
    });
    this.#inFlight.add(tracked);
    void tracked.finally(() => this.#inFlight.delete(tracked));
    return tracked;
  }

  /** Run a drive that a Destroy of the same container may interrupt (through `signal`) and wait for. */
  #trackDrive(containerId: string, run: (signal: AbortSignal) => Promise<void>): void {
    const abort = new AbortController();
    const entry = { abort, done: this.#track(run(AbortSignal.any([abort.signal, this.#closing.signal]))) };
    this.#drives.set(containerId, entry);
    void entry.done.finally(() => {
      if (this.#drives.get(containerId) === entry) this.#drives.delete(containerId);
    });
  }
}
