// What Railway's deployment status means for a container. The only place in the
// app that knows Railway's DeploymentStatus strings (besides the fake and tests);
// everything else asks for the phase.
import type { DeploymentState } from "./adapter.ts";

/**
 * A deployment's phase:
 * - `serving`: it runs and has not been stopped.
 * - `stopped`: it ran and was stopped (Railway keeps `status: SUCCESS` and sets `stopped`).
 * - `coming-up`: Railway has not finished bringing it up yet.
 * - `down`: Railway gave up on it or it died; it will not come back on its own.
 * - `going-away`: Railway is removing it, usually because its service is being deleted.
 */
export type DeploymentPhase = "serving" | "stopped" | "coming-up" | "down" | "going-away";

const PHASES: Readonly<Record<string, DeploymentPhase>> = {
  // A sleeping (serverless) deployment wakes on the first request: to the user it runs.
  SLEEPING: "serving",
  QUEUED: "coming-up",
  WAITING: "coming-up",
  INITIALIZING: "coming-up",
  BUILDING: "coming-up",
  DEPLOYING: "coming-up",
  NEEDS_APPROVAL: "coming-up",
  CRASHED: "down",
  FAILED: "down",
  SKIPPED: "down",
  REMOVING: "going-away",
  REMOVED: "going-away",
};

const reported = new Set<string>();

/**
 * The phase of a deployment as Railway reported it. A status this app does not know
 * yet reads as `coming-up`, which never settles an operation on its own; it is logged
 * once per status so it can be classified.
 */
export function phaseOf(state: Pick<DeploymentState, "status" | "stopped">, log: (msg: string) => void = console.error): DeploymentPhase {
  if (state.status === "SUCCESS") return state.stopped ? "stopped" : "serving";
  const phase = PHASES[state.status];
  if (phase) return phase;
  if (!reported.has(state.status)) {
    reported.add(state.status);
    log(`unknown Railway deployment status ${state.status}: treated as coming up`);
  }
  return "coming-up";
}
