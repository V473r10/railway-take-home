import { setTimeout as delay } from "node:timers/promises";

/** Injected so lifetimes, sweeps and backoff can be tested without waiting. */
export interface Clock {
  now(): Date;
  /** Resolve after `ms`, or reject with the signal's reason once it aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: Clock = {
  now: () => new Date(),
  sleep: async (ms, signal) => {
    await delay(ms, undefined, { signal });
  },
};

type Timer = { at: number; resolve: () => void };

/** A clock that only moves when a test moves it. Sleepers wake when `advance` passes their deadline. */
export class ManualClock implements Clock {
  #now: number;
  #timers: Timer[] = [];

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

  /** How many sleepers are waiting; lets a test wait until the code under test has gone to sleep. */
  get sleepers(): number {
    return this.#timers.length;
  }

  advance(ms: number): void {
    this.#now += ms;
    const due = this.#timers.filter((t) => t.at <= this.#now);
    this.#timers = this.#timers.filter((t) => t.at > this.#now);
    for (const t of due) t.resolve();
  }
}
