import type {
  CreateContainerInput,
  CreatedService,
  DeploymentState,
  DeploymentWatch,
  Outcome,
  PublicDomain,
  RailwayAdapter,
} from "./adapter.ts";

export type FakeService = { id: string; name: string; image: string; domain: string | null; deploymentId: string };

/** A failure the next matching call will return instead of succeeding. */
export type InjectedFailure =
  | { kind: "rejected"; message: string; code?: string; traceId?: string }
  | { kind: "rate_limited"; retryAfterMs: number }
  /** The call reaches Railway and acts, but the response is lost. */
  | { kind: "ambiguous_after_acting" }
  /** The call never reaches Railway. */
  | { kind: "ambiguous_before_acting" };

export type FakeCall =
  | { method: "createContainer"; input: CreateContainerInput }
  | { method: "createDomain"; serviceId: string }
  | { method: "latestDeployment"; serviceId: string }
  | { method: "readDeployment"; deploymentId: string }
  | { method: "watchDeployment"; deploymentId: string }
  | { method: "stopDeployment"; deploymentId: string }
  | { method: "redeployService"; serviceId: string };

/** The calls that change something on Railway, and so can have failures injected. */
export type FakeMutation = "createContainer" | "stopDeployment" | "redeployService";

export type FakeRailwayOptions = {
  /** Move every new deployment to SUCCESS after this long (local development only; tests move it by hand). */
  autoSucceedAfterMs?: number;
};

/**
 * In-memory Railway. Records every call so tests can assert on what Railway
 * would have seen, and lets a test queue failures for upcoming calls and move
 * deployments through their statuses.
 */
export class FakeRailway implements RailwayAdapter {
  readonly calls: FakeCall[] = [];
  readonly services = new Map<string, FakeService>();
  readonly deployments = new Map<string, DeploymentState>();
  readonly #options: FakeRailwayOptions;
  #failures = new Map<FakeMutation, InjectedFailure[]>();
  #staleLatest = 0;
  /** Per service, the deployment its last redeploy replaced (what a lagging list still shows). */
  #replaced = new Map<string, string>();
  #watches = new Map<string, Set<DeploymentWatch>>();
  #refuseSubscriptions = false;
  #nextId = 1;
  #gate: Promise<void> | null = null;

  constructor(options: FakeRailwayOptions = {}) {
    this.#options = options;
  }

  /** Calls to one method, in order. */
  callsTo<M extends FakeCall["method"]>(method: M): Extract<FakeCall, { method: M }>[] {
    return this.calls.filter((c): c is Extract<FakeCall, { method: M }> => c.method === method);
  }

  /** Queue failures for createContainer; each call consumes one before behaving normally. */
  failNext(...failures: InjectedFailure[]): void {
    this.failNextOn("createContainer", ...failures);
  }

  /** Queue failures for one mutation; each call to it consumes one before behaving normally. */
  failNextOn(method: FakeMutation, ...failures: InjectedFailure[]): void {
    this.#failures.set(method, [...(this.#failures.get(method) ?? []), ...failures]);
  }

  /** The next `calls` latestDeployment calls after a redeploy still list the replaced deployment, as Railway may for a moment. */
  lagNewDeployments(calls: number): void {
    this.#staleLatest = calls;
  }

  /** Hold every createContainer call until the returned release function is invoked. */
  hold(): () => void {
    let release!: () => void;
    this.#gate = new Promise((resolve) => {
      release = resolve;
    });
    return () => {
      this.#gate = null;
      release();
    };
  }

  /** While set, every new subscription ends right away, as a refused or broken socket would. */
  refuseSubscriptions(refuse = true): void {
    this.#refuseSubscriptions = refuse;
  }

  /** End every open subscription, as a dropped socket would. */
  dropSubscriptions(): void {
    const all = [...this.#watches.values()].flatMap((set) => [...set]);
    this.#watches.clear();
    for (const w of all) w.onEnd("fake: socket dropped");
  }

  /** How many subscriptions are open right now. */
  get openSubscriptions(): number {
    return [...this.#watches.values()].reduce((n, set) => n + set.size, 0);
  }

  /** Railway moves the service's current deployment; open subscriptions to it are told. */
  setDeployment(serviceId: string, status: string, stopped = false): void {
    const service = this.services.get(serviceId);
    if (!service) throw new Error(`fake: no service ${serviceId}`);
    const state: DeploymentState = { deploymentId: service.deploymentId, status, stopped };
    this.deployments.set(state.deploymentId, state);
    for (const w of this.#watches.get(state.deploymentId) ?? []) w.onState({ ...state });
  }

  async createContainer(input: CreateContainerInput): Promise<Outcome<CreatedService>> {
    this.calls.push({ method: "createContainer", input });
    if (this.#gate) await this.#gate;
    const failure = this.#failures.get("createContainer")?.shift();
    const early = failedBeforeActing(failure);
    if (early) return early;

    const n = this.#nextId++;
    // Like Railway with `source.image`: creating the service also starts its first deployment.
    const service: FakeService = { id: `svc-${n}`, name: input.name, image: input.image, domain: null, deploymentId: `dep-${n}` };
    this.services.set(service.id, service);
    this.deployments.set(service.deploymentId, { deploymentId: service.deploymentId, status: "DEPLOYING", stopped: false });
    if (this.#options.autoSucceedAfterMs !== undefined) {
      setTimeout(() => this.setDeployment(service.id, "SUCCESS"), this.#options.autoSucceedAfterMs).unref();
    }
    if (failure?.kind === "ambiguous_after_acting") return { kind: "ambiguous", reason: "fake: response lost" };
    return { kind: "ok", value: { serviceId: service.id } };
  }

  async stopDeployment(deploymentId: string): Promise<Outcome<void>> {
    this.calls.push({ method: "stopDeployment", deploymentId });
    const failure = this.#failures.get("stopDeployment")?.shift();
    const early = failedBeforeActing(failure);
    if (early) return early;
    const state = this.deployments.get(deploymentId);
    if (!state) return notFound("Deployment not found");
    // Railway takes a moment to stop it; tests move it with setDeployment(..., "SUCCESS", true).
    if (this.#options.autoSucceedAfterMs !== undefined) {
      const service = [...this.services.values()].find((s) => s.deploymentId === deploymentId);
      if (service) setTimeout(() => this.setDeployment(service.id, "SUCCESS", true), this.#options.autoSucceedAfterMs).unref();
    }
    if (failure?.kind === "ambiguous_after_acting") return { kind: "ambiguous", reason: "fake: response lost" };
    return { kind: "ok", value: undefined };
  }

  async redeployService(serviceId: string): Promise<Outcome<void>> {
    this.calls.push({ method: "redeployService", serviceId });
    const failure = this.#failures.get("redeployService")?.shift();
    const early = failedBeforeActing(failure);
    if (early) return early;
    const service = this.services.get(serviceId);
    if (!service) return notFound("Service not found");

    // A redeploy is a new deployment with a new id; the one it replaces is removed.
    const replaced = service.deploymentId;
    service.deploymentId = `dep-${this.#nextId++}`;
    this.deployments.set(service.deploymentId, { deploymentId: service.deploymentId, status: "DEPLOYING", stopped: false });
    const removed: DeploymentState = { deploymentId: replaced, status: "REMOVED", stopped: false };
    this.deployments.set(replaced, removed);
    for (const w of this.#watches.get(replaced) ?? []) w.onState({ ...removed });
    this.#replaced.set(serviceId, replaced);
    if (this.#options.autoSucceedAfterMs !== undefined) {
      setTimeout(() => this.setDeployment(service.id, "SUCCESS"), this.#options.autoSucceedAfterMs).unref();
    }
    if (failure?.kind === "ambiguous_after_acting") return { kind: "ambiguous", reason: "fake: response lost" };
    return { kind: "ok", value: undefined };
  }

  async createDomain(serviceId: string): Promise<Outcome<PublicDomain>> {
    this.calls.push({ method: "createDomain", serviceId });
    const service = this.services.get(serviceId);
    if (!service) return notFound("Service not found");
    service.domain ??= `${service.name}.up.railway.app`;
    return { kind: "ok", value: { domain: service.domain } };
  }

  async latestDeployment(serviceId: string): Promise<Outcome<DeploymentState | null>> {
    this.calls.push({ method: "latestDeployment", serviceId });
    const service = this.services.get(serviceId);
    if (!service) return notFound("Service not found");
    const replaced = this.deployments.get(this.#replaced.get(serviceId) ?? "");
    if (this.#staleLatest > 0 && replaced) {
      this.#staleLatest--;
      return { kind: "ok", value: { ...replaced } };
    }
    const state = this.deployments.get(service.deploymentId);
    return { kind: "ok", value: state ? { ...state } : null };
  }

  async readDeployment(deploymentId: string): Promise<Outcome<DeploymentState>> {
    this.calls.push({ method: "readDeployment", deploymentId });
    const state = this.deployments.get(deploymentId);
    return state ? { kind: "ok", value: { ...state } } : notFound("Deployment not found");
  }

  watchDeployment(deploymentId: string, watch: DeploymentWatch): () => void {
    this.calls.push({ method: "watchDeployment", deploymentId });
    if (this.#refuseSubscriptions) {
      queueMicrotask(() => watch.onEnd("fake: subscription refused"));
      return () => {};
    }
    const set = this.#watches.get(deploymentId) ?? new Set();
    set.add(watch);
    this.#watches.set(deploymentId, set);
    return () => {
      set.delete(watch);
    };
  }
}

/** The outcome of an injected failure that stops the call before Railway acts, if it is one. */
function failedBeforeActing(failure: InjectedFailure | undefined): Outcome<never> | null {
  switch (failure?.kind) {
    case "ambiguous_before_acting":
      return { kind: "ambiguous", reason: "fake: request lost" };
    case "rejected":
      return { kind: "rejected", message: failure.message, code: failure.code ?? null, traceId: failure.traceId ?? null };
    case "rate_limited":
      return failure;
    default:
      return null;
  }
}

function notFound(message: string): Outcome<never> {
  return { kind: "rejected", message, code: "NOT_FOUND", traceId: null };
}
