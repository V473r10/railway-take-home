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

export type PublicDomain = { domain: string };

/**
 * What Railway reports for one deployment. `status` is Railway's DeploymentStatus
 * (SUCCESS, DEPLOYING, CRASHED, ...). A stopped deployment keeps `status: SUCCESS`
 * and sets `stopped`, so the two are only meaningful together (M0 spike).
 */
export type DeploymentState = { deploymentId: string; status: string; stopped: boolean };

export type DeploymentWatch = {
  /** A change pushed by Railway. Never the current state on subscribe: read that separately. */
  onState: (state: DeploymentState) => void;
  /** The subscription is over (socket closed, error frame, auth refused). Not called after `close`. */
  onEnd: (reason: string) => void;
};

export interface RailwayAdapter {
  createContainer(input: CreateContainerInput): Promise<Outcome<CreatedService>>;
  /** Give the service a public Railway domain routed to the image's port. */
  createDomain(serviceId: string): Promise<Outcome<PublicDomain>>;
  /** The service's newest deployment, or null while Railway has not started one yet. */
  latestDeployment(serviceId: string): Promise<Outcome<DeploymentState | null>>;
  readDeployment(deploymentId: string): Promise<Outcome<DeploymentState>>;
  /** Stop a deployment. It keeps `status: SUCCESS` and becomes `stopped` (M0 spike). */
  stopDeployment(deploymentId: string): Promise<Outcome<void>>;
  /**
   * Deploy the service again. Railway answers with a boolean, not the new
   * deployment: find that with `latestDeployment` (M0 spike).
   */
  redeployService(serviceId: string): Promise<Outcome<void>>;
  /** Subscribe to changes of one deployment. Returns the function that ends the subscription. */
  watchDeployment(deploymentId: string, watch: DeploymentWatch): () => void;
}

/** Every service this app creates starts with this prefix (a second ownership signal, never the only one). */
export const SERVICE_NAME_PREFIX = "rcc-";

export const CONTAINER_IMAGE = "nginx:alpine";

/** The port `CONTAINER_IMAGE` listens on; the public domain routes to it. */
export const CONTAINER_PORT = 80;

/** Deployment statuses after which Railway will not move the deployment on its own. */
export const DEPLOYMENT_FAILED_STATUSES: ReadonlySet<string> = new Set(["FAILED", "CRASHED", "REMOVED", "SKIPPED"]);

export function serviceNameFor(createOperationId: string): string {
  return `${SERVICE_NAME_PREFIX}${createOperationId}`;
}
