/** Injected so lifetimes, sweeps and backoff can be tested without waiting. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** A clock that only moves when a test moves it. */
export class ManualClock implements Clock {
  #now: number;

  constructor(start = new Date("2026-01-01T00:00:00Z")) {
    this.#now = start.getTime();
  }

  now(): Date {
    return new Date(this.#now);
  }

  advance(ms: number): void {
    this.#now += ms;
  }
}
