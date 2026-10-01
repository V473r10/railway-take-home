import type { Clock } from "./clock.ts";
import type { Db } from "./db.ts";
import type { DeploymentState, RailwayAdapter } from "./railway/adapter.ts";

/** Fallback backoff: after a subscription ends, wait this long before reading again and resubscribing. */
export const MIN_BACKOFF_MS = 2_000;
export const MAX_BACKOFF_MS = 60_000;
/** A Stop is confirmed by reading: first again after this long, doubling up to MAX_BACKOFF_MS. */
export const STOP_CONFIRM_MIN_MS = 2_000;

export type ObserverDeps = {
  db: Db;
  railway: RailwayAdapter;
  clock: Clock;
  /** Called after each observation is stored; `changed` says whether the stored state moved. */
  onObserved: (containerId: string, state: DeploymentState, changed: boolean) => Promise<void>;
  /**
   * Railway says the container's deployment was removed, or refuses to read it: its
   * service may have been deleted outside the app. The observer cannot tell that from
   * a Railway hiccup, so it only reports the suspicion; the caller checks the service list.
   */
  onSuspectGone: (containerId: string) => void;
  log: (msg: string) => void;
};

/**
 * The one thing in the process that watches Railway (ADR 0001). Per container:
 * subscribe to its current deployment first, then read it once by query, so a
 * change between the two cannot be lost (subscriptions only push changes). When
 * the subscription ends, it waits with backoff, reads again and resubscribes, so
 * a broken socket degrades into polling instead of into silence.
 */
export class Observer {
  readonly #deps: ObserverDeps;
  readonly #watching = new Map<string, AbortController>();
  readonly #confirming = new Map<string, AbortController>();
  readonly #tasks = new Set<Promise<void>>();
  #closed = false;

  constructor(deps: ObserverDeps) {
    this.#deps = deps;
  }

  /**
   * Watch every container that has a service. Called once at startup. `except` are
   * containers a resumed operation starts watching itself, once it knows what to watch.
   */
  async start(except: ReadonlySet<string> = new Set()): Promise<void> {
    const { rows } = await this.#deps.db.query<{ id: string }>(
      "SELECT id FROM containers WHERE service_id IS NOT NULL AND destroyed_at IS NULL AND missing_at IS NULL",
    );
    for (const row of rows) if (!except.has(row.id)) this.track(row.id);
  }

  /** Start watching a container, or restart the watch after its current deployment changed. */
  track(containerId: string): void {
    if (this.#closed) return;
    this.#watching.get(containerId)?.abort();
    const controller = new AbortController();
    this.#watching.set(containerId, controller);
    const task = this.#watch(containerId, controller.signal).catch((error: unknown) => {
      if (!controller.signal.aborted) this.#deps.log(`observer: ${containerId}: ${error instanceof Error ? error.stack : String(error)}`);
    });
    this.#tasks.add(task);
    void task.finally(() => {
      this.#tasks.delete(task);
      if (this.#watching.get(containerId) === controller) this.#watching.delete(containerId);
    });
  }

  /**
   * Read a deployment until Railway reports it stopped (or no longer SUCCESS), storing
   * each read as a push would. Needed because subscriptions push `status` changes only:
   * a stop leaves the status at SUCCESS and flips `deploymentStopped`, which Railway
   * never pushes (measured in the deploy smoke, #12). The first read is immediate; then
   * it backs off, and ends once `stillWanted` says no, or the container is untracked.
   */
  confirmStopped(containerId: string, deploymentId: string, stillWanted: () => Promise<boolean>): void {
    if (this.#closed) return;
    this.#confirming.get(containerId)?.abort();
    const controller = new AbortController();
    this.#confirming.set(containerId, controller);
    const { signal } = controller;
    const run = async () => {
      let wait = STOP_CONFIRM_MIN_MS;
      while (!signal.aborted) {
        const outcome = await this.#deps.railway.readDeployment(deploymentId);
        if (signal.aborted) return;
        if (outcome.kind === "ok") {
          await this.#store(containerId, outcome.value);
          if (outcome.value.stopped || outcome.value.status !== "SUCCESS") return;
        }
        if (!(await stillWanted())) return;
        await this.#deps.clock.sleep(outcome.kind === "rate_limited" ? outcome.retryAfterMs : wait, signal);
        wait = Math.min(wait * 2, MAX_BACKOFF_MS);
      }
    };
    const task = run().catch((error: unknown) => {
      if (!signal.aborted) this.#deps.log(`observer: confirming stop of ${deploymentId}: ${String(error)}`);
    });
    this.#tasks.add(task);
    void task.finally(() => {
      this.#tasks.delete(task);
      if (this.#confirming.get(containerId) === controller) this.#confirming.delete(containerId);
    });
  }

  untrack(containerId: string): void {
    this.#confirming.get(containerId)?.abort();
    this.#watching.get(containerId)?.abort();
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const controller of this.#watching.values()) controller.abort();
    for (const controller of this.#confirming.values()) controller.abort();
    while (this.#tasks.size > 0) await Promise.all(this.#tasks);
  }

  async #watch(containerId: string, signal: AbortSignal): Promise<void> {
    const deploymentId = await this.#currentDeployment(containerId, signal);
    if (!deploymentId) return;
    let backoff = MIN_BACKOFF_MS;
    while (!signal.aborted) {
      const startedAt = this.#deps.clock.now().getTime();
      const reason = await this.#subscribeOnce(containerId, deploymentId, signal);
      if (signal.aborted) return;
      // A subscription that stayed up for a while was healthy; start the backoff over.
      if (this.#deps.clock.now().getTime() - startedAt >= MAX_BACKOFF_MS) backoff = MIN_BACKOFF_MS;
      this.#deps.log(`observer: subscription for ${deploymentId} ended (${reason}); reading again in ${backoff} ms`);
      await this.#deps.clock.sleep(backoff, signal);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    }
  }

  /** The container's current deployment id, asking Railway for it when the database does not know it yet. */
  async #currentDeployment(containerId: string, signal: AbortSignal): Promise<string | null> {
    const { db, railway, clock, log, onSuspectGone } = this.#deps;
    const { rows } = await db.query<{ service_id: string | null; current_deployment_id: string | null }>(
      "SELECT service_id, current_deployment_id FROM containers WHERE id = $1 AND destroyed_at IS NULL AND missing_at IS NULL",
      [containerId],
    );
    const row = rows[0];
    if (!row?.service_id) return null;
    if (row.current_deployment_id) return row.current_deployment_id;

    let backoff = MIN_BACKOFF_MS;
    while (!signal.aborted) {
      const outcome = await railway.latestDeployment(row.service_id);
      if (outcome.kind === "ok" && outcome.value) {
        await db.query("UPDATE containers SET current_deployment_id = $2 WHERE id = $1 AND current_deployment_id IS NULL", [
          containerId,
          outcome.value.deploymentId,
        ]);
        return outcome.value.deploymentId;
      }
      if (outcome.kind === "rejected") {
        log(`observer: cannot read deployments of ${row.service_id}: ${outcome.message}`);
        onSuspectGone(containerId);
        return null;
      }
      // No deployment yet, rate limited, or no response: wait and ask again.
      await clock.sleep(outcome.kind === "rate_limited" ? outcome.retryAfterMs : backoff, signal);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    }
    return null;
  }

  /** One subscription plus the read that follows it. Resolves with the reason it ended, once every observation is stored. */
  #subscribeOnce(containerId: string, deploymentId: string, signal: AbortSignal): Promise<string> {
    const { railway, log } = this.#deps;
    return new Promise((resolve) => {
      let pushed = false;
      let stored: Promise<void> = Promise.resolve();
      const store = (work: () => Promise<void>) => {
        stored = stored.then(work).catch((error: unknown) => log(`observer: storing state of ${deploymentId}: ${String(error)}`));
      };
      let done = false;
      const finish = (reason: string) => {
        if (done) return;
        done = true;
        signal.removeEventListener("abort", onAbort);
        void stored.finally(() => resolve(reason));
      };
      const onAbort = () => {
        unsubscribe();
        finish("closed");
      };

      // Subscribe first ...
      const unsubscribe = railway.watchDeployment(deploymentId, {
        onState: (state) => {
          pushed = true;
          store(() => this.#store(containerId, state));
        },
        onEnd: finish,
      });
      signal.addEventListener("abort", onAbort, { once: true });

      // ... then read. A push that arrives while the read is in flight is newer, so the read is dropped.
      store(async () => {
        const outcome = await railway.readDeployment(deploymentId);
        if (outcome.kind === "rejected") this.#deps.onSuspectGone(containerId);
        if (outcome.kind !== "ok") return log(`observer: reading ${deploymentId}: ${outcome.kind}`);
        if (!pushed && !signal.aborted) await this.#store(containerId, outcome.value);
      });
    });
  }

  async #store(containerId: string, state: DeploymentState): Promise<void> {
    if (state.status === "REMOVED") this.#deps.onSuspectGone(containerId);
    // Only the current deployment's state counts; a late event from an older deployment is dropped.
    // `observed_at` is when the observed state last changed, so it can be compared with a failure.
    const { rows } = await this.#deps.db.query<{ changed: boolean }>(
      `UPDATE containers c SET observed_status = $3, observed_stopped = $4,
         observed_at = CASE WHEN old.observed_status IS DISTINCT FROM $3 OR old.observed_stopped IS DISTINCT FROM $4
                            THEN $5 ELSE old.observed_at END
       FROM (SELECT id, observed_status, observed_stopped, observed_at FROM containers WHERE id = $1 FOR UPDATE) old
       WHERE c.id = old.id AND c.current_deployment_id = $2 AND c.destroyed_at IS NULL AND c.missing_at IS NULL
       RETURNING (old.observed_status IS DISTINCT FROM $3 OR old.observed_stopped IS DISTINCT FROM $4) AS changed`,
      [containerId, state.deploymentId, state.status, state.stopped, this.#deps.clock.now()],
    );
    const row = rows[0];
    if (row) await this.#deps.onObserved(containerId, state, row.changed);
  }
}
