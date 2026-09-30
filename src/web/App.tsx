import { useEffect, useState } from "react";
import { applyEvent, type Container, type ContainerAction, createContainer, requestAction, subscribeToContainers } from "./api.ts";

const ACTION_LABEL: Record<ContainerAction, string> = { stop: "Stop", start: "Start", destroy: "Destroy" };

/**
 * Stop, Start and Destroy for one container. Availability comes from the server,
 * so a button is disabled for the same reason the API would refuse the click.
 */
function ContainerActions({ container, sending, onAction }: {
  container: Container;
  sending: boolean;
  onAction: (action: ContainerAction) => void;
}) {
  const { stop, start } = container.actions;
  const onDestroy = () => {
    // Destroy cannot be undone: the service and its deployments are deleted on Railway.
    if (window.confirm(`Destroy ${container.name}? This deletes its Railway service and cannot be undone.`)) onAction("destroy");
  };
  // When neither Stop nor Start can be done, say why; disabled buttons cannot be focused to find out.
  const hint = !stop.allowed && !start.allowed ? start.reason : null;
  const hintId = `actions-hint-${container.id}`;
  return (
    <div className="row-actions">
      {(["stop", "start"] as const).map((action) => (
        <button
          key={action}
          type="button"
          onClick={() => onAction(action)}
          disabled={sending || !container.actions[action].allowed}
          aria-describedby={hint ? hintId : undefined}
        >
          {ACTION_LABEL[action]}
          <span className="visually-hidden"> {container.name}</span>
        </button>
      ))}
      <button
        type="button"
        className="danger"
        onClick={onDestroy}
        disabled={sending || !container.actions.destroy.allowed}
        title={container.actions.destroy.allowed ? undefined : container.actions.destroy.reason}
      >
        Destroy
        <span className="visually-hidden"> {container.name}</span>
      </button>
      {hint && (
        <small id={hintId} className="hint">
          {hint}
        </small>
      )}
    </div>
  );
}

export function App() {
  const [containers, setContainers] = useState<Container[] | null>(null);
  const [connected, setConnected] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // Containers with a Stop or Start request on its way to the server.
  const [sending, setSending] = useState<ReadonlySet<string>>(new Set());

  useEffect(
    () =>
      subscribeToContainers({
        onEvent: (event) => setContainers((list) => applyEvent(list, event)),
        onConnection: setConnected,
      }),
    [],
  );

  const onCreate = async () => {
    setCreating(true);
    // A fresh key per click. Disabling the button stops most double clicks;
    // the key is what makes the ones that get through harmless.
    const key = crypto.randomUUID();
    try {
      // The new container arrives over the live stream; nothing to refresh here.
      await createContainer(key);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  const onAction = async (containerId: string, action: ContainerAction) => {
    setSending((ids) => new Set(ids).add(containerId));
    try {
      await requestAction(containerId, action, crypto.randomUUID());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending((ids) => {
        const next = new Set(ids);
        next.delete(containerId);
        return next;
      });
    }
  };

  return (
    <main>
      <header>
        <h1>Railway Container Control</h1>
        <div className="actions">
          <button type="button" className="primary" onClick={() => void onCreate()} disabled={creating}>
            {creating ? "Creating…" : "Create container"}
          </button>
        </div>
      </header>

      {!connected && (
        <p role="status" className="notice">
          Connection to the server lost. Reconnecting…
        </p>
      )}

      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}

      {containers === null ? (
        <p aria-live="polite">Loading…</p>
      ) : containers.length === 0 ? (
        <p>No containers yet.</p>
      ) : (
        <table>
          <caption className="visually-hidden">Containers</caption>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">State</th>
              <th scope="col">Public URL</th>
              <th scope="col">Created</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody aria-live="polite">
            {containers.map((c) => (
              <tr key={c.id}>
                <td>
                  <code>{c.name}</code>
                </td>
                <td>
                  <span className={`state state-${c.state}`}>{c.state}</span>
                  {c.lastError && (
                    <div className="error">
                      {c.lastError.message}
                      {c.lastError.traceId && <small> (trace {c.lastError.traceId})</small>}
                    </div>
                  )}
                </td>
                <td>
                  {c.state === "running" && c.url ? (
                    <a href={c.url} target="_blank" rel="noopener noreferrer">
                      {new URL(c.url).host}
                      <span className="visually-hidden"> (opens in a new tab)</span>
                    </a>
                  ) : (
                    <span aria-label="Not available">—</span>
                  )}
                </td>
                <td>
                  <time dateTime={c.createdAt}>{new Date(c.createdAt).toLocaleTimeString()}</time>
                </td>
                <td>
                  <ContainerActions container={c} sending={sending.has(c.id)} onAction={(action) => void onAction(c.id, action)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
