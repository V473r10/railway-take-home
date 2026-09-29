import type { CreateContainerInput, CreatedService, Outcome, RailwayAdapter } from "./adapter.ts";

export type FakeService = { id: string; name: string; image: string };

/** A failure the next matching call will return instead of succeeding. */
export type InjectedFailure =
  | { kind: "rejected"; message: string; code?: string; traceId?: string }
  | { kind: "rate_limited"; retryAfterMs: number }
  /** The call reaches Railway and acts, but the response is lost. */
  | { kind: "ambiguous_after_acting" }
  /** The call never reaches Railway. */
  | { kind: "ambiguous_before_acting" };

export type FakeCall = { method: "createContainer"; input: CreateContainerInput };

/**
 * In-memory Railway. Records every call so tests can assert on what Railway
 * would have seen, and lets a test queue failures for upcoming calls.
 */
export class FakeRailway implements RailwayAdapter {
  readonly calls: FakeCall[] = [];
  readonly services = new Map<string, FakeService>();
  #failures: InjectedFailure[] = [];
  #nextId = 1;
  #gate: Promise<void> | null = null;

  /** Queue failures; each call consumes one before behaving normally. */
  failNext(...failures: InjectedFailure[]): void {
    this.#failures.push(...failures);
  }

  /** Hold every call until the returned release function is invoked. */
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

  async createContainer(input: CreateContainerInput): Promise<Outcome<CreatedService>> {
    this.calls.push({ method: "createContainer", input });
    if (this.#gate) await this.#gate;
    const failure = this.#failures.shift();
    if (failure?.kind === "ambiguous_before_acting") return { kind: "ambiguous", reason: "fake: request lost" };
    if (failure?.kind === "rejected") {
      return { kind: "rejected", message: failure.message, code: failure.code ?? null, traceId: failure.traceId ?? null };
    }
    if (failure?.kind === "rate_limited") return failure;

    const service: FakeService = { id: `svc-${this.#nextId++}`, name: input.name, image: input.image };
    this.services.set(service.id, service);
    if (failure?.kind === "ambiguous_after_acting") return { kind: "ambiguous", reason: "fake: response lost" };
    return { kind: "ok", value: { serviceId: service.id } };
  }
}
