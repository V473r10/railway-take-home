import type { Clock } from "./clock.ts";
import type { Outcome } from "./railway/adapter.ts";

// The retry policy of ADR 0004, in one place. Only calls Railway gave no usable
// answer to are retried: a 429 (Railway did not act) after `Retry-After`, and an
// ambiguous outcome (Railway may have acted) after backoff. A rejection is final.

/** Calls to Railway per step, the first one included. */
export const MAX_ATTEMPTS = 5;
export const RETRY_BACKOFF_MS = 1_000;
export const MAX_RETRY_BACKOFF_MS = 30_000;

/**
 * What a look at Railway says after an ambiguous call: it did act (`done`, with the
 * result to use), it did not (`retry`), or the look itself got no answer (`unknown`,
 * so the call must not be repeated yet: repeating a create that did act makes two).
 */
export type Lookup<T> = { kind: "done"; outcome: Outcome<T> } | { kind: "retry" } | { kind: "unknown"; reason: string };

export type RetryOptions<T> = {
  clock: Clock;
  /** Looks at Railway before a call that may have acted is repeated. Without one, it is repeated blindly. */
  lookup?: () => Promise<Lookup<T>>;
  /** Told of every ambiguous attempt, so the operation is flagged while Railway's answer is unknown. */
  onAmbiguous?: (reason: string) => Promise<void>;
  /** Ends the waiting early; the last outcome is returned as it is. */
  signal?: AbortSignal;
};

/** Run one call to Railway under the retry policy and return its final outcome. */
export async function withRetries<T>(call: () => Promise<Outcome<T>>, options: RetryOptions<T>): Promise<Outcome<T>> {
  const { clock, lookup, onAmbiguous, signal } = options;
  let outcome = await call();
  let backoff = RETRY_BACKOFF_MS;
  for (let attempt = 1; ; attempt++) {
    if (outcome.kind === "ok" || outcome.kind === "rejected") return outcome;
    if (outcome.kind === "ambiguous") await onAmbiguous?.(outcome.reason);
    if (attempt >= MAX_ATTEMPTS) return outcome;
    try {
      await clock.sleep(outcome.kind === "rate_limited" ? outcome.retryAfterMs : backoff, signal);
    } catch {
      return outcome;
    }
    backoff = Math.min(backoff * 2, MAX_RETRY_BACKOFF_MS);

    if (outcome.kind === "ambiguous" && lookup) {
      const seen = await lookup();
      if (seen.kind === "done") return seen.outcome;
      if (seen.kind === "unknown") {
        // Still not known whether the call acted: look again next time instead of repeating it.
        outcome = { kind: "ambiguous", reason: seen.reason };
        continue;
      }
    }
    outcome = await call();
  }
}

/** Turn a lookup's own outcome into a Lookup: anything but an answer leaves it unknown. */
export function lookupFrom<T, U>(outcome: Outcome<T>, decide: (value: T) => Lookup<U>): Lookup<U> {
  if (outcome.kind === "ok") return decide(outcome.value);
  if (outcome.kind === "rejected") return { kind: "unknown", reason: `lookup refused: ${outcome.message}` };
  if (outcome.kind === "rate_limited") return { kind: "unknown", reason: "lookup rate limited" };
  return { kind: "unknown", reason: `lookup got no response: ${outcome.reason}` };
}
