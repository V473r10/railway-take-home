import { useEffect, useState } from "react";
import { applyEvent, type Container, createContainer, subscribeToContainers } from "./api.ts";

export function App() {
  const [containers, setContainers] = useState<Container[] | null>(null);
  const [connected, setConnected] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

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
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
