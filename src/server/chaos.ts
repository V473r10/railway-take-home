// Chaos mode: break the app on purpose, against real Railway, and watch it recover.
//
// Off unless CHAOS=1. Every fault here is one the app is built to survive and the
// tests already inject into the fake (test/reconcile.test.ts, test/retries.test.ts,
// the simulation); this module lets a person inject them into the running app and
// read what happened in the container's timeline.
import type { Db } from "./db.ts";
import type {
  CreateContainerInput,
  CreatedService,
  DeploymentState,
  DeploymentWatch,
  Outcome,
  PublicDomain,
  RailwayAdapter,
  SandboxService,
  TokenIdentity,
} from "./railway/adapter.ts";
import type { RailwayCall, Timeline } from "./timeline.ts";

/** A fault that waits for the app's next call that changes something on Railway. */
export type ArmedFault =
  /** Railway acts on the call, and its response is thrown away: an ambiguous outcome. */
  | "drop_next_response"
  /** Railway acts on the call, and the process is killed before it hears back. */
  | "crash_after_next_write";

export const ARMED_FAULTS: readonly ArmedFault[] = ["drop_next_response", "crash_after_next_write"];

export type ChaosState = { armed: ArmedFault | null };

export type ChaosDeps = {
  railway: RailwayAdapter;
  db: Db;
  /** Kill the process at once, with no cleanup: in production, SIGKILL. */
  crash: () => void;
  log: (msg: string) => void;
};

/** What a write targets: the container is found by the service, domain or deployment it names. */
type Target = { name?: string; serviceId?: string; deploymentId?: string };

/**
 * A Railway adapter that passes every call through, except the one an armed fault is
 * waiting for, and the switches a person flips from the chaos panel.
 */
export class ChaosRailway implements RailwayAdapter {
  readonly #deps: ChaosDeps;
  readonly #watches = new Set<{ deploymentId: string; end: (reason: string) => void }>();
  #armed: ArmedFault | null = null;
  #timeline: Timeline | null = null;

  constructor(deps: ChaosDeps) {
    this.#deps = deps;
  }

  /** Where chaos entries go. Set once the app that owns the timeline exists. */
  useTimeline(timeline: Timeline): void {
    this.#timeline = timeline;
  }

  get state(): ChaosState {
    return { armed: this.#armed };
  }

  arm(fault: ArmedFault | null): void {
    this.#armed = fault;
    this.#deps.log(fault ? `chaos: armed ${fault}` : "chaos: disarmed");
  }

  /** End every open subscription, as a dropped WebSocket would. Returns how many were open. */
  async cutSubscriptions(): Promise<number> {
    const watches = [...this.#watches];
    for (const watch of watches) {
      const containerId = await this.#containerFor({ deploymentId: watch.deploymentId }).catch(() => null);
      if (containerId) await this.#timeline?.record(containerId, null, { kind: "chaos", fault: "cut_subscriptions" });
      watch.end("chaos: socket cut");
    }
    this.#deps.log(`chaos: cut ${watches.length} subscription(s)`);
    return watches.length;
  }

  /** Delete a container's service straight on Railway, as someone using Railway's dashboard would. */
  async deleteOutside(containerId: string): Promise<"deleted" | "no_service" | Outcome<void>> {
    const { rows } = await this.#deps.db.query<{ service_id: string | null }>(
      "SELECT service_id FROM containers WHERE id = $1 AND destroyed_at IS NULL AND missing_at IS NULL",
      [containerId],
    );
    const serviceId = rows[0]?.service_id;
    if (!serviceId) return "no_service";
    await this.#timeline?.record(containerId, null, { kind: "chaos", fault: "delete_outside" });
    const outcome = await this.#deps.railway.deleteService(serviceId);
    return outcome.kind === "ok" ? "deleted" : outcome;
  }

  /** Kill the process now, whatever it is doing. */
  async crashNow(): Promise<void> {
    // Marked on every container with work in flight: that is where the next process picks up.
    const { rows } = await this.#deps.db.query<{ id: string }>(
      "SELECT DISTINCT container_id AS id FROM operations WHERE status IN ('pending', 'in_progress')",
    );
    for (const { id } of rows) await this.#timeline?.record(id, null, { kind: "chaos", fault: "crash_now" });
    this.#deps.log("chaos: killing the process now");
    this.#deps.crash();
  }

  verifyIdentity(): Promise<Outcome<TokenIdentity>> {
    return this.#deps.railway.verifyIdentity();
  }
  createContainer(input: CreateContainerInput): Promise<Outcome<CreatedService>> {
    return this.#write("serviceCreate", { name: input.name }, () => this.#deps.railway.createContainer(input));
  }
  findService(name: string): Promise<Outcome<CreatedService | null>> {
    return this.#deps.railway.findService(name);
  }
  listServices(): Promise<Outcome<SandboxService[]>> {
    return this.#deps.railway.listServices();
  }
  createDomain(serviceId: string): Promise<Outcome<PublicDomain>> {
    return this.#write("serviceDomainCreate", { serviceId }, () => this.#deps.railway.createDomain(serviceId));
  }
  serviceDomain(serviceId: string): Promise<Outcome<PublicDomain | null>> {
    return this.#deps.railway.serviceDomain(serviceId);
  }
  latestDeployment(serviceId: string): Promise<Outcome<DeploymentState | null>> {
    return this.#deps.railway.latestDeployment(serviceId);
  }
  readDeployment(deploymentId: string): Promise<Outcome<DeploymentState>> {
    return this.#deps.railway.readDeployment(deploymentId);
  }
  stopDeployment(deploymentId: string): Promise<Outcome<void>> {
    return this.#write("deploymentStop", { deploymentId }, () => this.#deps.railway.stopDeployment(deploymentId));
  }
  redeployService(serviceId: string): Promise<Outcome<void>> {
    return this.#write("serviceInstanceRedeploy", { serviceId }, () => this.#deps.railway.redeployService(serviceId));
  }
  deleteService(serviceId: string): Promise<Outcome<void>> {
    return this.#write("serviceDelete", { serviceId }, () => this.#deps.railway.deleteService(serviceId));
  }

  watchDeployment(deploymentId: string, watch: DeploymentWatch): () => void {
    let open = true;
    const entry = {
      deploymentId,
      end: (reason: string) => {
        if (!open) return;
        close();
        watch.onEnd(reason);
      },
    };
    const unsubscribe = this.#deps.railway.watchDeployment(deploymentId, {
      onState: (state) => {
        if (open) watch.onState(state);
      },
      onEnd: (reason) => {
        if (!open) return;
        open = false;
        this.#watches.delete(entry);
        watch.onEnd(reason);
      },
    });
    const close = () => {
      open = false;
      this.#watches.delete(entry);
      unsubscribe();
    };
    this.#watches.add(entry);
    return close;
  }

  /** A call that changes something on Railway: where an armed fault fires, once. */
  async #write<T>(call: RailwayCall, target: Target, run: () => Promise<Outcome<T>>): Promise<Outcome<T>> {
    const fault = this.#armed;
    if (!fault) return run();
    this.#armed = null;
    const outcome = await run();
    const containerId = await this.#containerFor(target).catch(() => null);
    if (containerId) await this.#timeline?.record(containerId, null, { kind: "chaos", fault, call });
    if (fault === "crash_after_next_write") {
      this.#deps.log(`chaos: ${call} reached Railway (${outcome.kind}); killing the process before it hears back`);
      this.#deps.crash();
      // The process is gone; nothing waits for this.
      return new Promise<Outcome<T>>(() => {});
    }
    this.#deps.log(`chaos: ${call} reached Railway (${outcome.kind}); its response is dropped`);
    return { kind: "ambiguous", reason: `chaos: ${call} reached Railway, its response was dropped` };
  }

  async #containerFor({ name, serviceId, deploymentId }: Target): Promise<string | null> {
    const { rows } = await this.#deps.db.query<{ id: string }>(
      `SELECT id FROM containers
       WHERE destroyed_at IS NULL AND (name = $1 OR service_id = $2 OR current_deployment_id = $3)
       LIMIT 1`,
      [name ?? null, serviceId ?? null, deploymentId ?? null],
    );
    return rows[0]?.id ?? null;
  }
}
