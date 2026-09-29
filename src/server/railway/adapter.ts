// The only boundary between this app and Railway. Everything else in the app
// talks to this interface; GraphQL never leaks past it. Two implementations:
// the real one (graphql.ts) and an in-memory fake used by the tests (fake.ts).

/** How a call to Railway ended, classified the way the retry policy needs it (ADR 0004). */
export type Outcome<T> =
  | { kind: "ok"; value: T }
  /** Railway answered and refused (HTTP 200 with `errors[]`, or a 4xx). Never retried. */
  | { kind: "rejected"; message: string; code: string | null; traceId: string | null }
  /** HTTP 429. Retried after `retryAfterMs`. */
  | { kind: "rate_limited"; retryAfterMs: number }
  /** No response: Railway may or may not have acted on the call. */
  | { kind: "ambiguous"; reason: string };

export type CreateContainerInput = {
  /** Service name; carries the create operation's id so it can be found again. */
  name: string;
  image: string;
};

export type CreatedService = { serviceId: string };

export interface RailwayAdapter {
  createContainer(input: CreateContainerInput): Promise<Outcome<CreatedService>>;
}

/** Every service this app creates starts with this prefix (a second ownership signal, never the only one). */
export const SERVICE_NAME_PREFIX = "rcc-";

export const CONTAINER_IMAGE = "nginx:alpine";

export function serviceNameFor(createOperationId: string): string {
  return `${SERVICE_NAME_PREFIX}${createOperationId}`;
}
