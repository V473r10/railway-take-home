// The browser only talks to this app's backend, never to Railway (ADR 0001).

export type ContainerState =
  | "creating"
  | "starting"
  | "stopping"
  | "destroying"
  | "running"
  | "stopped"
  | "failed"
  | "crashed"
  | "missing";

export type Availability = { allowed: true } | { allowed: false; reason: string };

export type ContainerAction = "stop" | "start" | "destroy";

export type Container = {
  id: string;
  name: string;
  state: ContainerState;
  url: string | null;
  createdAt: string;
  /** When the server's lifetime sweep destroys it. */
  expiresAt: string;
  lastError: { message: string; traceId: string | null } | null;
  /** Decided by the server with the same rule that refuses a request. */
  actions: Record<ContainerAction, Availability>;
};

type OperationKind = "create" | "stop" | "start" | "destroy";

/** One step in a container's life, as the server records it (src/server/timeline.ts). */
export type TimelineEntry = {
  seq: string;
  containerId: string;
  operationId: string | null;
  at: string;
} & (
  | { kind: "requested"; operation: OperationKind; by: "user" | "lifetime" }
  | { kind: "began"; operation: OperationKind; resumed: boolean }
  | { kind: "call"; call: string; attempt: number; outcome: "ok" | "rejected" | "rate_limited" | "ambiguous"; message?: string; traceId?: string | null }
  | { kind: "lookup"; call: string; result: "acted" | "not_acted" | "unknown"; message?: string }
  | { kind: "deployment"; deploymentId: string }
  | { kind: "observed"; deploymentId: string; status: string; stopped: boolean }
  | { kind: "succeeded"; operation: OperationKind }
  | { kind: "failed"; operation: OperationKind; message: string }
  | { kind: "unanswered"; operation: OperationKind; message: string }
  | { kind: "missing" }
  | { kind: "followed"; deploymentId: string }
);

/** Set while the app cannot confirm who its Railway token belongs to; every operation is refused (ADR 0003). */
export type ReadOnlyMode = { reason: string };

export type LiveEvent =
  /** `readOnly` is fixed until the server restarts, so the snapshot is the only event that carries it; the limit too. */
  | { type: "snapshot"; containers: Container[]; readOnly: ReadOnlyMode | null; containerLimit: number }
  | { type: "upsert"; container: Container }
  | { type: "remove"; id: string }
  | { type: "timeline"; entry: TimelineEntry };

/** The server answered 401: the session is missing or has expired, so show the login screen. */
export class NotLoggedIn extends Error {}

/** Whether this browser already holds a session cookie the server accepts. */
export async function hasSession(): Promise<boolean> {
  const res = await fetch("/api/session");
  if (res.status === 401) return false;
  if (!res.ok) throw new Error(await readError(res));
  return true;
}

/** Trade the shared password for a session cookie (HttpOnly, so this code never sees it). */
export async function logIn(password: string): Promise<void> {
  const res = await fetch("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (!res.ok) throw new Error(await readError(res));
}

/**
 * Follow the backend's SSE stream. EventSource reconnects on its own after a
 * drop, and every (re)connect starts with a full snapshot, so nothing is missed.
 */
export function subscribeToContainers(handlers: {
  onEvent: (event: LiveEvent) => void;
  onConnection: (connected: boolean) => void;
  /** EventSource gave up for good, which is how a refused (401) stream shows up. */
  onClosed: () => void;
}): () => void {
  const source = new EventSource("/api/events");
  const handle = (message: MessageEvent<string>) => handlers.onEvent(JSON.parse(message.data) as LiveEvent);
  for (const type of ["snapshot", "upsert", "remove", "timeline"]) source.addEventListener(type, handle);
  source.onopen = () => handlers.onConnection(true);
  source.onerror = () => {
    handlers.onConnection(false);
    if (source.readyState === EventSource.CLOSED) handlers.onClosed();
  };
  return () => source.close();
}

/** Apply one event to the list the UI shows, keeping creation order. */
export function applyEvent(list: Container[] | null, event: LiveEvent): Container[] {
  if (event.type === "snapshot") return event.containers;
  if (event.type === "timeline") return list ?? [];
  const current = list ?? [];
  if (event.type === "remove") return current.filter((c) => c.id !== event.id);
  const exists = current.some((c) => c.id === event.container.id);
  return exists ? current.map((c) => (c.id === event.container.id ? event.container : c)) : [...current, event.container];
}

/** For a gated route: a 401 means the session is gone, anything else carries the server's message. */
async function refusal(res: Response): Promise<Error> {
  return res.status === 401 ? new NotLoggedIn("Your session has ended.") : new Error(await readError(res));
}

async function readError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? `Request failed (HTTP ${res.status})`;
}

/** One key per click: resending the same click (a retry, a double submit) reuses it. */
export async function createContainer(idempotencyKey: string): Promise<void> {
  const res = await fetch("/api/containers", { method: "POST", headers: { "Idempotency-Key": idempotencyKey } });
  if (!res.ok) throw await refusal(res);
}

/** Stop, Start or Destroy a container. Like Create, one key per click. */
export async function requestAction(containerId: string, action: ContainerAction, idempotencyKey: string): Promise<void> {
  const res = await fetch(`/api/containers/${encodeURIComponent(containerId)}/${action}`, {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
  });
  if (!res.ok) throw await refusal(res);
}

/** A container's timeline so far, oldest first. */
export async function fetchTimeline(containerId: string): Promise<TimelineEntry[]> {
  const res = await fetch(`/api/containers/${encodeURIComponent(containerId)}/timeline`);
  if (!res.ok) throw await refusal(res);
  return ((await res.json()) as { entries: TimelineEntry[] }).entries;
}

/**
 * Entries from the fetch and from the live stream, each once, in order. The two overlap:
 * an entry recorded while the fetch was in flight can arrive both ways.
 */
export function mergeTimeline(a: readonly TimelineEntry[], b: readonly TimelineEntry[]): TimelineEntry[] {
  const bySeq = new Map<string, TimelineEntry>();
  for (const entry of [...a, ...b]) bySeq.set(entry.seq, entry);
  return [...bySeq.values()].sort((x, y) => (BigInt(x.seq) < BigInt(y.seq) ? -1 : 1));
}
