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

export type Container = {
  id: string;
  name: string;
  state: ContainerState;
  createdAt: string;
  lastError: { message: string; traceId: string | null } | null;
};

async function readError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? `Request failed (HTTP ${res.status})`;
}

export async function listContainers(): Promise<Container[]> {
  const res = await fetch("/api/containers");
  if (!res.ok) throw new Error(await readError(res));
  return ((await res.json()) as { containers: Container[] }).containers;
}

/** One key per click: resending the same click (a retry, a double submit) reuses it. */
export async function createContainer(idempotencyKey: string): Promise<void> {
  const res = await fetch("/api/containers", { method: "POST", headers: { "Idempotency-Key": idempotencyKey } });
  if (!res.ok) throw new Error(await readError(res));
}
