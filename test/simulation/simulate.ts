// Seeded simulation of the whole app against a hostile Railway.
//
// One seed drives a random sequence of steps: users clicking (twice, concurrently,
// replaying old keys), Railway losing responses, rate limiting and refusing, the
// backend dying mid-call and restarting, deployments crashing, services deleted from
// the dashboard, foreign services appearing, sockets dropping and time jumping. After
// every step the safety invariants are checked; at the end the world calms down and
// the liveness invariants are checked: every operation finishes, the screen agrees
// with Railway, and once lifetimes run out nothing the app created is left on Railway.
//
// The sequence of steps is a pure function of the seed, so a failure prints the seed
// and its trace, and `SIM_SEED=<seed>` replays it. Postgres is real, so the exact
// interleaving inside one step can vary between runs; the steps themselves do not.
import type { FakeMutation } from "../../src/server/railway/fake.ts";
import { phaseOf } from "../../src/server/railway/deployment-phase.ts";
import { type ContainerBody, type DeathPoint, type Harness, startHarness } from "../harness.ts";
import { Random } from "./random.ts";

export type SimulationOptions = { seed: number; steps: number };

export type SimulationReport = { seed: number; steps: number; trace: string[]; stats: Record<string, number> };

export class InvariantViolated extends Error {}

type Kind = "create" | "stop" | "start" | "destroy";
/** A key the app accepted, and the operation it made: sending it again must answer with that operation. */
type UsedKey = { key: string; kind: Kind; containerId: string | null; operationId: string };

const MUTATIONS: readonly FakeMutation[] = [
  "createContainer",
  "createDomain",
  "stopDeployment",
  "redeployService",
  "deleteService",
  "findService",
  "listServices",
];
const DEATH_POINTS: readonly DeathPoint[] = ["before_acting", "after_acting"];
const TRANSITIONAL = new Set(["creating", "starting", "stopping", "destroying"]);
/** Every status a request may answer with; anything else (a 500 above all) is a violation. */
const ALLOWED_STATUS: Record<Kind, ReadonlySet<number>> = {
  create: new Set([200, 202, 409, 503]),
  stop: new Set([200, 202, 404, 409, 503]),
  start: new Set([200, 202, 404, 409, 503]),
  destroy: new Set([200, 202, 404, 409, 503]),
};
const CONTAINER_LIMIT = 5;

export async function simulate({ seed, steps }: SimulationOptions): Promise<SimulationReport> {
  const h = await startHarness();
  const sim = new Simulation(h, new Random(seed), seed);
  try {
    for (let step = 1; step <= steps; step++) {
      sim.step = step;
      const before = h.railway.calls.length;
      await hangsAfter(10_000, "the step", sim.randomStep());
      await sim.quiesce();
      sim.logCalls(before);
      await sim.checkSafety();
    }
    sim.step = steps + 1;
    await sim.calmDown();
    await sim.checkLiveness();
    await sim.outliveEveryone();
    return { seed, steps, trace: sim.trace, stats: sim.stats };
  } catch (error) {
    // A single replayed seed prints its whole trace; a sweep only the end of each failure.
    const tail = (process.env.SIM_SEED ? sim.trace : sim.trace.slice(-40)).join("\n");
    const message = error instanceof Error ? error.message : String(error);
    const failure = new InvariantViolated(
      `seed ${seed}, step ${sim.step}: ${message}\n\nlast steps:\n${tail}\n\nreplay: SIM_SEED=${seed} SIM_STEPS=${steps} npx vitest run test/simulation.test.ts`,
    );
    failure.stack = error instanceof Error ? `${failure.message}\n${error.stack ?? ""}` : failure.message;
    throw failure;
  } finally {
    if (process.env.SIM_LIVE) process.stderr.write("closing\n");
    await h.close();
  }
}

/** A step that never ends is a finding too (a request stuck on a lock, say): fail it with the trace. */
async function hangsAfter<T>(ms: number, what: string, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const hung = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not finish in ${ms / 1000} s of wall time`)), ms);
  });
  try {
    return await Promise.race([work, hung]);
  } finally {
    clearTimeout(timer);
  }
}

class Simulation {
  readonly trace: string[] = [];
  readonly stats: Record<string, number> = {};
  step = 0;
  readonly #h: Harness;
  readonly #rng: Random;
  readonly #seed: number;
  /** Every container the app ever answered with, in the order the simulation first saw it. */
  readonly #known: string[] = [];
  readonly #keys: UsedKey[] = [];
  readonly #foreign = new Set<string>();
  #nextKey = 1;

  constructor(h: Harness, rng: Random, seed: number) {
    this.#h = h;
    this.#rng = rng;
    this.#seed = seed;
  }

  #log(line: string): void {
    this.trace.push(`#${this.step} ${line}`);
    if (process.env.SIM_LIVE) process.stderr.write(`#${this.step} ${line}\n`);
  }

  /** The calls Railway saw since `from`, as one indented line, so a trace shows what the app did. */
  logCalls(from: number): void {
    const calls = this.#h.railway.calls.slice(from);
    if (calls.length === 0) return;
    const describe = (c: (typeof calls)[number]) => {
      const arg = "serviceId" in c ? c.serviceId : "deploymentId" in c ? c.deploymentId : "name" in c ? c.name.slice(0, 12) : "input" in c ? c.input.name.slice(0, 12) : "";
      return arg ? `${c.method}(${arg})` : c.method;
    };
    this.trace.push(`     railway saw: ${calls.map(describe).join(" ")}`);
  }

  #count(name: string): void {
    this.stats[name] = (this.stats[name] ?? 0) + 1;
  }

  #alias(containerId: string | null | undefined): string {
    if (!containerId) return "c?";
    const i = this.#known.indexOf(containerId);
    return i === -1 ? "c?" : `c${i + 1}`;
  }

  #newKey(): string {
    return `sim-${this.#seed}-${String(this.#nextKey++).padStart(4, "0")}`;
  }

  /** The app's services on Railway: every service but the ones the simulation added by hand. */
  #ownServices() {
    return [...this.#h.railway.services.values()].filter((s) => !this.#foreign.has(s.id));
  }

  async randomStep(): Promise<void> {
    const h = this.#h;
    const alive = !h.dead;
    const rng = this.#rng;
    const hasKnown = this.#known.length > 0;
    const action = rng.weighted<() => Promise<void>>([
      [alive ? 6 : 0, () => this.#create()],
      [alive ? 2 : 0, () => this.#doubleCreate()],
      [alive && hasKnown ? 8 : 0, () => this.#act()],
      [alive && hasKnown ? 2 : 0, () => this.#doubleAct()],
      [alive && hasKnown ? 2 : 0, () => this.#concurrentActs()],
      [alive && this.#keys.length > 0 ? 1.5 : 0, () => this.#replay()],
      [alive ? 4 : 0, async () => this.#injectFailures()],
      [alive ? 1.2 : 0, async () => this.#dieOnNextCall()],
      [alive ? 0.8 : 4, () => this.#restart()],
      [6, async () => this.#railwayMoves()],
      [0.8, async () => this.#deleteOutsideApp()],
      [0.3, async () => this.#addForeignService()],
      [1, async () => this.#dropSockets()],
      [0.4, async () => this.#lagDeployments()],
      [5, async () => this.#advanceTime()],
    ]);
    await action();
  }

  // --- what users do ---------------------------------------------------------------

  async #send(kind: Kind, containerId: string | null, key: string): Promise<{ status: number; operationId: string | null; containerId: string | null }> {
    const path = kind === "create" ? "/api/containers" : `/api/containers/${containerId}/${kind}`;
    const res = await this.#h.request(path, { method: "POST", headers: { "Idempotency-Key": key } });
    const body = (await res.json()) as { operation?: { id: string }; container?: ContainerBody | null; error?: string };
    if (!ALLOWED_STATUS[kind].has(res.status)) {
      throw new Error(`${kind} answered HTTP ${res.status}: ${JSON.stringify(body)}`);
    }
    const id = body.container?.id ?? containerId;
    if (id && !this.#known.includes(id)) this.#known.push(id);
    const operationId = body.operation?.id ?? null;
    if (operationId && (res.status === 200 || res.status === 202)) {
      const seen = this.#keys.find((k) => k.key === key);
      if (seen && seen.operationId !== operationId) {
        throw new Error(`key ${key} answered with operation ${operationId}, but it made ${seen.operationId}`);
      }
      if (!seen) this.#keys.push({ key, kind, containerId: id ?? null, operationId });
    }
    this.#count(`http ${res.status}`);
    return { status: res.status, operationId, containerId: id ?? null };
  }

  async #create(): Promise<void> {
    const key = this.#newKey();
    const r = await this.#send("create", null, key);
    this.#log(`create [${key}] -> ${r.status} ${this.#alias(r.containerId)}`);
  }

  /** The same click arriving twice at once: at most one operation may come of it. */
  async #doubleCreate(): Promise<void> {
    const key = this.#newKey();
    const n = this.#rng.int(2, 3);
    const results = await Promise.all(Array.from({ length: n }, () => this.#send("create", null, key)));
    this.#log(`create x${n} [${key}] -> ${results.map((r) => r.status).join(",")} ${this.#alias(results[0]?.containerId)}`);
    this.#assertOneOperation(key, results);
  }

  #pickAction(): { kind: Kind; containerId: string } {
    return {
      kind: this.#rng.weighted<Kind>([
        [3, "stop"],
        [3, "start"],
        [2, "destroy"],
      ]),
      containerId: this.#rng.pick(this.#known),
    };
  }

  async #act(): Promise<void> {
    const { kind, containerId } = this.#pickAction();
    const key = this.#newKey();
    const r = await this.#send(kind, containerId, key);
    this.#log(`${kind} ${this.#alias(containerId)} [${key}] -> ${r.status}`);
  }

  async #doubleAct(): Promise<void> {
    const { kind, containerId } = this.#pickAction();
    const key = this.#newKey();
    const results = await Promise.all([this.#send(kind, containerId, key), this.#send(kind, containerId, key)]);
    this.#log(`${kind} x2 ${this.#alias(containerId)} [${key}] -> ${results.map((r) => r.status).join(",")}`);
    this.#assertOneOperation(key, results);
  }

  /** Two different clicks at the same moment, on the same container or not. */
  async #concurrentActs(): Promise<void> {
    const a = this.#pickAction();
    const b = this.#rng.chance(0.6) ? { ...this.#pickAction(), containerId: a.containerId } : this.#pickAction();
    const [ka, kb] = [this.#newKey(), this.#newKey()];
    const [ra, rb] = await Promise.all([this.#send(a.kind, a.containerId, ka), this.#send(b.kind, b.containerId, kb)]);
    this.#log(
      `${a.kind} ${this.#alias(a.containerId)} [${ka}] || ${b.kind} ${this.#alias(b.containerId)} [${kb}] -> ${ra.status},${rb.status}`,
    );
  }

  /** A click resent long after: it must answer with the operation it made the first time. */
  async #replay(): Promise<void> {
    const used = this.#rng.pick(this.#keys);
    const r = await this.#send(used.kind, used.containerId, used.key);
    this.#log(`replay ${used.kind} ${this.#alias(used.containerId)} [${used.key}] -> ${r.status}`);
    if (r.status !== 200 && r.status !== 503) throw new Error(`replayed key ${used.key} answered HTTP ${r.status}, not 200`);
  }

  #assertOneOperation(key: string, results: Array<{ status: number; operationId: string | null }>): void {
    const fresh = results.filter((r) => r.status === 202).length;
    if (fresh > 1) throw new Error(`key ${key} sent concurrently made ${fresh} operations`);
    const ops = new Set(results.map((r) => r.operationId).filter(Boolean));
    if (ops.size > 1) throw new Error(`key ${key} sent concurrently answered with ${ops.size} different operations`);
  }

  // --- what goes wrong between the app and Railway ---------------------------------

  #injectFailures(): void {
    const method = this.#rng.pick(MUTATIONS);
    const burst = this.#rng.weighted([
      [6, 1],
      [3, 2],
      [2, 4],
      [1, 6],
    ]);
    const failures = Array.from({ length: burst }, () =>
      this.#rng.weighted([
        [3, { kind: "ambiguous_after_acting" } as const],
        [3, { kind: "ambiguous_before_acting" } as const],
        [2, { kind: "rate_limited", retryAfterMs: this.#rng.int(1, 5) * 1_000 } as const],
        [1, { kind: "rejected", message: "sim: Railway refused", traceId: `trace-${this.step}` } as const],
      ]),
    );
    this.#h.railway.failNextOn(method, ...failures);
    this.#log(`railway will fail the next ${method}: ${failures.map((f) => f.kind).join(",")}`);
    this.#count("injected failures");
  }

  #dieOnNextCall(): void {
    const method = this.#rng.pick(MUTATIONS);
    const when = this.#rng.pick(DEATH_POINTS);
    this.#h.dieOn(method, when);
    this.#log(`backend will die on its next ${method}, ${when}`);
  }

  async #readOnly(): Promise<boolean> {
    const body = (await (await this.#h.request("/api/containers")).json()) as { readOnly: unknown };
    return body.readOnly !== null;
  }

  async #restart(allowBadToken = true): Promise<void> {
    const badToken = allowBadToken && this.#rng.chance(0.1);
    const wasDead = this.#h.dead;
    await this.#h.restart((railway) => {
      if (badToken) railway.failNextOn("verifyIdentity", { kind: "ambiguous_before_acting" });
    });
    this.#log(`${wasDead ? "dead backend restarted" : "backend killed and restarted"}${badToken ? " (identity unconfirmed: read-only)" : ""}`);
    this.#count("restarts");
  }

  // --- what Railway does on its own --------------------------------------------------

  #railwayMoves(): void {
    const railway = this.#h.railway;
    const services = this.#ownServices();
    if (services.length === 0) return this.#log("railway: nothing to move");
    const service = this.#rng.pick(services);
    const state = railway.deployments.get(service.deploymentId);
    if (!state) return;
    const phase = phaseOf(state, () => {});
    const stopAccepted = railway.stopsAccepted.has(service.deploymentId);
    const moves: Array<readonly [number, () => void]> = [];
    if (phase === "coming-up") {
      moves.push([6, () => railway.setDeployment(service.id, "SUCCESS")]);
      moves.push([1, () => railway.setDeployment(service.id, "FAILED")]);
    }
    if (phase === "serving" && stopAccepted) moves.push([6, () => railway.setDeployment(service.id, "SUCCESS", true)]);
    if (phase === "serving") moves.push([1, () => railway.setDeployment(service.id, "CRASHED")]);
    if (moves.length === 0) return this.#log(`railway: ${service.name} stays ${state.status}`);
    this.#rng.weighted(moves)();
    const after = railway.deployments.get(service.deploymentId);
    this.#log(`railway: ${service.name} ${state.status}${state.stopped ? "/stopped" : ""} -> ${after?.status}${after?.stopped ? "/stopped" : ""}`);
  }

  #deleteOutsideApp(): void {
    const services = this.#ownServices();
    if (services.length === 0) return;
    const service = this.#rng.pick(services);
    const listedFor = this.#rng.chance(0.5) ? this.#rng.int(1, 3) : 0;
    this.#h.railway.deleteOutsideApp(service.id, { listedFor });
    this.#log(`someone deletes ${service.name} from the Railway dashboard (still listed for ${listedFor})`);
    this.#count("outside deletions");
  }

  /** A service the app did not create; sometimes with the app's own prefix, to tempt it. */
  #addForeignService(): void {
    const name = this.#rng.chance(0.5) ? `rcc-imposter-${this.step}` : `someone-else-${this.step}`;
    this.#foreign.add(this.#h.railway.addServiceOutsideApp(name));
    this.#log(`someone adds ${name} to the sandbox by hand`);
  }

  #dropSockets(): void {
    this.#h.railway.dropSubscriptions();
    this.#log("railway drops every subscription");
  }

  #lagDeployments(): void {
    const calls = this.#rng.int(1, 4);
    this.#h.railway.lagNewDeployments(calls);
    this.#log(`railway lists stale deployments for ${calls} calls`);
  }

  #advanceTime(): void {
    const ms = this.#rng.weighted([
      [4, 1_000],
      [4, 2_000],
      [3, 5_000],
      [2, 30_000],
      [2, 61_000],
      [1, 10 * 60_000],
    ]);
    this.#h.clock.advance(ms);
    this.#log(`time +${ms / 1000}s`);
  }

  // --- waiting and checking -------------------------------------------------------

  /**
   * Wait until the app stops making progress on its own: no database client busy, no
   * new call to Railway, no new sleeper on the clock, for a few rounds in a row. What
   * is left is waiting on the clock, on Railway, or on a dead process.
   */
  async quiesce(): Promise<void> {
    const h = this.#h;
    const fingerprint = () => {
      const db = h.db;
      return `${h.railway.calls.length}:${h.clock.sleepers}:${db.totalCount - db.idleCount}:${db.waitingCount}`;
    };
    let last = fingerprint();
    let quiet = 0;
    for (let round = 0; round < 400; round++) {
      await new Promise((resolve) => setTimeout(resolve, 4));
      const now = fingerprint();
      const busy = !now.endsWith(":0:0");
      if (now === last && !busy) {
        if (++quiet >= 3) return;
      } else {
        quiet = 0;
        last = now;
      }
    }
    throw new Error("the app never went quiet (busy for 1.6 s of wall time)");
  }

  async #rows() {
    const { rows } = await this.#h.db.query<{
      id: string;
      name: string;
      service_id: string | null;
      current_deployment_id: string | null;
      destroyed: boolean;
      missing: boolean;
    }>(
      "SELECT id, name, service_id, current_deployment_id, destroyed_at IS NOT NULL AS destroyed, missing_at IS NOT NULL AS missing FROM containers",
    );
    return rows;
  }

  /** What must hold after every single step, whatever is going wrong. */
  async checkSafety(): Promise<void> {
    const railway = this.#h.railway;
    const rows = await this.#rows();
    const live = rows.filter((r) => !r.destroyed);
    const own = this.#ownServices();

    // No duplicate: one create never makes two services.
    const names = new Map<string, number>();
    for (const s of own) names.set(s.name, (names.get(s.name) ?? 0) + 1);
    for (const [name, n] of names) if (n > 1) throw new Error(`duplicate: ${n} services on Railway are named ${name}`);

    // No orphan: every service the app made belongs to a container that still exists.
    const liveNames = new Set(live.map((r) => r.name));
    for (const s of own) {
      if (!liveNames.has(s.name)) throw new Error(`orphan: ${s.name} (${s.id}) is on Railway, but no live container owns it`);
    }

    // The container limit holds, counting stopped and failed containers.
    if (live.length > CONTAINER_LIMIT) throw new Error(`limit: ${live.length} containers exist, limit is ${CONTAINER_LIMIT}`);

    // Ownership: the app never changes a service it did not create.
    const foreignDeployments = new Set([...this.#foreign].map((id) => railway.services.get(id)?.deploymentId));
    for (const call of railway.calls) {
      const touched =
        ("serviceId" in call && this.#foreign.has(call.serviceId)) ||
        (call.method === "stopDeployment" && foreignDeployments.has(call.deploymentId));
      if (touched && call.method !== "serviceDomain" && call.method !== "latestDeployment") {
        throw new Error(`ownership: the app called ${call.method} on a service it did not create: ${JSON.stringify(call)}`);
      }
    }
  }

  /**
   * The storm ends: every queued failure is forgotten, a dead backend comes back, and
   * Railway finishes what it was asked to do. Time moves in small steps for a few
   * minutes, so every backoff, sweep and retry gets its chance.
   */
  async calmDown(): Promise<void> {
    const h = this.#h;
    h.railway.clearFailures();
    h.railway.refuseSubscriptions(false);
    h.spare();
    this.#log("--- calm: no more failures, Railway finishes what it was asked ---");
    // A calm world has a good token too: a read-only backend is restarted with one.
    if (h.dead || (await this.#readOnly())) await this.#restart(false);
    await this.quiesce();
    for (let round = 0; round < 60; round++) {
      this.#settleRailway();
      h.clock.advance(5_000);
      await this.quiesce();
      await this.checkSafety();
    }
  }

  /** Railway brings up what is coming up and stops what it accepted a stop for. */
  #settleRailway(): void {
    const railway = this.#h.railway;
    for (const service of this.#ownServices()) {
      const state = railway.deployments.get(service.deploymentId);
      if (!state) continue;
      const phase = phaseOf(state, () => {});
      if (phase === "coming-up") railway.setDeployment(service.id, "SUCCESS");
      else if (phase === "serving" && railway.stopsAccepted.has(service.deploymentId)) railway.setDeployment(service.id, "SUCCESS", true);
    }
  }

  /** Once calm: nothing is left half done, and the screen shows what Railway has. */
  async checkLiveness(): Promise<void> {
    const h = this.#h;
    const { rows: active } = await h.db.query<{ kind: string; container_id: string; last_error: string | null }>(
      "SELECT kind, container_id, last_error FROM operations WHERE status IN ('pending', 'in_progress')",
    );
    for (const op of active) {
      throw new Error(`stuck: ${op.kind} on ${this.#alias(op.container_id)} is still active after the calm (${op.last_error ?? "no error"})`);
    }
    const res = await h.request("/api/containers");
    const { containers } = (await res.json()) as { containers: ContainerBody[] };
    const rows = new Map((await this.#rows()).map((r) => [r.id, r]));
    for (const c of containers) {
      const where = `${this.#alias(c.id)} (${c.name}) shows ${c.state}`;
      const service = c.serviceId ? h.railway.services.get(c.serviceId) : undefined;
      const deployment = service ? h.railway.deployments.get(service.deploymentId) : undefined;
      const phase = deployment ? phaseOf(deployment, () => {}) : null;
      if (TRANSITIONAL.has(c.state)) throw new Error(`${where} after the calm`);
      if (c.serviceId && !service && c.state !== "missing") throw new Error(`${where}, but its service is gone from Railway`);
      if (c.state === "missing" && service) throw new Error(`${where}, but its service is on Railway`);
      if (c.state === "running" && (phase !== "serving" || !c.url)) {
        throw new Error(`${where} (url ${c.url}), but Railway reports ${deployment?.status ?? "nothing"}`);
      }
      if (c.state === "stopped" && phase !== "stopped") throw new Error(`${where}, but Railway reports ${deployment?.status}`);
      const row = rows.get(c.id);
      if (service && c.state !== "missing" && row?.current_deployment_id !== service.deploymentId) {
        throw new Error(`${where} and watches deployment ${row?.current_deployment_id}, but Railway's current one is ${service.deploymentId}`);
      }
    }
    this.#log(`liveness ok: ${containers.length} container(s), ${containers.map((c) => `${this.#alias(c.id)}=${c.state}`).join(" ")}`);
  }

  /** Past every lifetime, nothing the app created is left, and nothing anyone else made was touched. */
  async outliveEveryone(): Promise<void> {
    const h = this.#h;
    for (let minute = 0; minute < 35; minute++) {
      this.#settleRailway();
      h.clock.advance(60_000);
      await this.quiesce();
      if (process.env.SIM_LIVE) process.stderr.write(`minute ${minute}: ${(await this.#rows()).filter((r) => !r.destroyed).length} live\n`);
      await this.checkSafety();
    }
    const live = (await this.#rows()).filter((r) => !r.destroyed);
    if (live.length > 0) throw new Error(`lifetime: ${live.length} container(s) outlived their 30 minutes: ${live.map((r) => this.#alias(r.id)).join(", ")}`);
    const own = this.#ownServices();
    if (own.length > 0) throw new Error(`lifetime: ${own.map((s) => s.name).join(", ")} still on Railway after every lifetime ran out`);
    for (const id of this.#foreign) {
      if (!h.railway.services.has(id)) throw new Error(`ownership: foreign service ${id} was deleted`);
    }
    this.#log("every lifetime ran out: Railway holds nothing of the app's, and every foreign service is intact");
  }
}
