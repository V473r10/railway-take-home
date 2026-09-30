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
  lastError: { message: string; traceId: string | null } | null;
  /** Decided by the server with the same rule that refuses a request. */
  actions: Record<ContainerAction, Availability>;
};

/** Set while the app cannot confirm who its Railway token belongs to; every operation is refused (ADR 0003). */
export type ReadOnlyMode = { reason: string };

export type LiveEvent =
  /** `readOnly` is fixed until the server restarts, so the snapshot is the only event that carries it. */
  | { type: "snapshot"; containers: Container[]; readOnly: ReadOnlyMode | null }
  | { type: "upsert"; container: Container }
  | { type: "remove"; id: string };

/**
 * Follow the backend's SSE stream. EventSource reconnects on its own after a
 * drop, and every (re)connect starts with a full snapshot, so nothing is missed.
 */
export function subscribeToContainers(handlers: {
  onEvent: (event: LiveEvent) => void;
  onConnection: (connected: boolean) => void;
}): () => void {
  const source = new EventSource("/api/events");
  const handle = (message: MessageEvent<string>) => handlers.onEvent(JSON.parse(message.data) as LiveEvent);
  for (const type of ["snapshot", "upsert", "remove"]) source.addEventListener(type, handle);
  source.onopen = () => handlers.onConnection(true);
  source.onerror = () => handlers.onConnection(false);
  return () => source.close();
}

/** Apply one event to the list the UI shows, keeping creation order. */
export function applyEvent(list: Container[] | null, event: LiveEvent): Container[] {
  if (event.type === "snapshot") return event.containers;
  const current = list ?? [];
  if (event.type === "remove") return current.filter((c) => c.id !== event.id);
  const exists = current.some((c) => c.id === event.container.id);
  return exists ? current.map((c) => (c.id === event.container.id ? event.container : c)) : [...current, event.container];
}

async function readError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? `Request failed (HTTP ${res.status})`;
}

/** One key per click: resending the same click (a retry, a double submit) reuses it. */
export async function createContainer(idempotencyKey: string): Promise<void> {
  const res = await fetch("/api/containers", { method: "POST", headers: { "Idempotency-Key": idempotencyKey } });
  if (!res.ok) throw new Error(await readError(res));
}

/** Stop, Start or Destroy a container. Like Create, one key per click. */
export async function requestAction(containerId: string, action: ContainerAction, idempotencyKey: string): Promise<void> {
  const res = await fetch(`/api/containers/${encodeURIComponent(containerId)}/${action}`, {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
  });
  if (!res.ok) throw new Error(await readError(res));
}
