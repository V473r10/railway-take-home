import { setTimeout as delay } from "node:timers/promises";

/** Injected so lifetimes, sweeps and backoff can be tested without waiting. */
export interface Clock {
  now(): Date;
  /** Resolve after `ms`, or reject with the signal's reason once it aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  /** Call `run` every `ms` until the signal aborts. Kept apart from `sleep`: a periodic job is not someone waiting. */
  every(ms: number, run: () => void, signal: AbortSignal): void;
}

export const systemClock: Clock = {
  now: () => new Date(),
  sleep: async (ms, signal) => {
    await delay(ms, undefined, { signal });
  },
  every: (ms, run, signal) => {
    if (signal.aborted) return;
    const timer = setInterval(run, ms);
    // A periodic job alone does not keep the process alive.
    timer.unref();
    signal.addEventListener("abort", () => clearInterval(timer), { once: true });
  },
};

type Timer = { at: number; resolve: () => void };
type Periodic = { next: number; ms: number; run: () => void; signal: AbortSignal };

/** A clock that only moves when a test moves it. Sleepers wake when `advance` passes their deadline. */
export class ManualClock implements Clock {
  #now: number;
  #timers: Timer[] = [];
  #periodic: Periodic[] = [];

  constructor(start = new Date("2026-01-01T00:00:00Z")) {
    this.#now = start.getTime();
  }

  now(): Date {
    return new Date(this.#now);
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const timer: Timer = { at: this.#now + ms, resolve };
      this.#timers.push(timer);
      signal?.addEventListener(
        "abort",
        () => {
          this.#timers = this.#timers.filter((t) => t !== timer);
          reject(signal.reason);
        },
        { once: true },
      );
    });
  }

  every(ms: number, run: () => void, signal: AbortSignal): void {
    if (!signal.aborted) this.#periodic.push({ next: this.#now + ms, ms, run, signal });
  }

  /** How many sleepers are waiting; lets a test wait until the code under test has gone to sleep. Periodic jobs are not counted. */
  get sleepers(): number {
    return this.#timers.length;
  }

  /** Wakes the sleepers whose deadline passed, and runs each periodic job once for every period that elapsed. */
  advance(ms: number): void {
    this.#now += ms;
    const due = this.#timers.filter((t) => t.at <= this.#now);
    this.#timers = this.#timers.filter((t) => t.at > this.#now);
    for (const t of due) t.resolve();
    this.#periodic = this.#periodic.filter((p) => !p.signal.aborted);
    for (const p of this.#periodic) {
      while (p.next <= this.#now && !p.signal.aborted) {
        p.next += p.ms;
        p.run();
      }
    }
  }
}
