import { type FormEvent, Fragment, useCallback, useEffect, useRef, useState } from "react";
import {
  applyEvent,
  type Container,
  type ContainerAction,
  createContainer,
  deleteOutside,
  fetchChaos,
  fetchTimeline,
  hasSession,
  logIn,
  mergeTimeline,
  NotLoggedIn,
  type ReadOnlyMode,
  requestAction,
  subscribeToContainers,
  type TimelineEntry,
} from "./api.ts";
import { ChaosPanel, useChaos } from "./ChaosPanel.tsx";
import { Timeline } from "./Timeline.tsx";

type OpenTimeline = { entries: TimelineEntry[]; loading: boolean; error: string | null };

const RECHECK_MS = 2_000;
const ACTION_LABEL: Record<ContainerAction, string> = { stop: "Stop", start: "Start", destroy: "Destroy" };
const READ_ONLY_BANNER_ID = "read-only-banner";
const LIMIT_HINT_ID = "limit-hint";

/** The current time, updated every second, for countdowns. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** Time left until the lifetime sweep destroys the container, as m:ss. */
function Countdown({ expiresAt, now }: { expiresAt: string; now: number }) {
  const left = Math.max(0, Date.parse(expiresAt) - now);
  const minutes = Math.floor(left / 60_000);
  const seconds = Math.floor((left % 60_000) / 1_000);
  const label = left === 0 ? "Expiring…" : `${minutes}:${String(seconds).padStart(2, "0")}`;
  // Not a live region: a screen reader announcing every second would be noise. The deadline is in the title.
  return (
    <time dateTime={expiresAt} title={`Destroyed at ${new Date(expiresAt).toLocaleTimeString()}`}>
      {label}
    </time>
  );
}

/**
 * Stop, Start and Destroy for one container. Availability comes from the server,
 * so a button is disabled for the same reason the API would refuse the click.
 */
function ContainerActions({ container, sending, readOnly, onAction, onDeleteOutside }: {
  container: Container;
  sending: boolean;
  readOnly: boolean;
  onAction: (action: ContainerAction) => void;
  /** Chaos mode only: delete the service straight on Railway, as Railway's dashboard would. */
  onDeleteOutside?: () => void;
}) {
  const { stop, start } = container.actions;
  const onDestroy = () => {
    // Destroy cannot be undone: the service and its deployments are deleted on Railway.
    if (window.confirm(`Destroy ${container.name}? This deletes its Railway service and cannot be undone.`)) onAction("destroy");
  };
  // When neither Stop nor Start can be done, say why; disabled buttons cannot be focused to find out.
  // In read-only mode the banner already says why, once for the whole page.
  const hint = readOnly ? "Read-only mode, see the banner above." : !stop.allowed && !start.allowed ? start.reason : null;
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
      {onDeleteOutside && container.state !== "missing" && (
        <button type="button" className="chaos-button" onClick={onDeleteOutside} disabled={sending}>
          Delete on Railway
          <span className="visually-hidden"> {container.name}, outside this app</span>
        </button>
      )}
      {hint && (
        <small id={hintId} className="hint">
          {hint}
        </small>
      )}
    </div>
  );
}

/** Asks for the shared password. A cost barrier in front of the app, not an account system. */
function Login({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSending(true);
    try {
      await logIn(password);
      onLoggedIn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSending(false);
    }
  };

  return (
    <main className="login">
      <h1>Railway Container Control</h1>
      <form onSubmit={(e) => void onSubmit(e)}>
        <label htmlFor="password">Password</label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          required
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-invalid={error !== null}
          aria-describedby={error ? "login-error" : undefined}
        />
        <button type="submit" className="primary" disabled={sending}>
          {sending ? "Checking…" : "Enter"}
        </button>
      </form>
      {error && (
        <p id="login-error" role="alert" className="error">
          {error}
        </p>
      )}
    </main>
  );
}

/** Login screen until the server accepts the session cookie; the app after. The cookie survives reloads. */
export function App() {
  const [session, setSession] = useState<"checking" | "out" | "in">("checking");
  // Bumped to reopen the live stream after it closed for a reason other than the session.
  const [stream, setStream] = useState(0);

  const check = useCallback((reopen: boolean) => {
    const attempt = () =>
      hasSession().then(
        (ok) => {
          setSession(ok ? "in" : "out");
          if (ok && reopen) setStream((n) => n + 1);
        },
        // The server is unreachable; keep what is on screen and ask again shortly.
        () => setTimeout(attempt, RECHECK_MS),
      );
    void attempt();
  }, []);
  useEffect(() => check(false), [check]);
  // The live stream only closes for good when it was refused: ask whether the session is still valid.
  const onStreamClosed = useCallback(() => check(true), [check]);
  const onSessionEnded = useCallback(() => setSession("out"), []);

  if (session === "checking") return <main aria-live="polite">Loading…</main>;
  if (session === "out") return <Login onLoggedIn={() => setSession("in")} />;
  return <Containers key={stream} onStreamClosed={onStreamClosed} onSessionEnded={onSessionEnded} />;
}

function Containers({ onStreamClosed, onSessionEnded }: { onStreamClosed: () => void; onSessionEnded: () => void }) {
  const [containers, setContainers] = useState<Container[] | null>(null);
  const [readOnly, setReadOnly] = useState<ReadOnlyMode | null>(null);
  const [containerLimit, setContainerLimit] = useState<number | null>(null);
  const now = useNow();
  const [connected, setConnected] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // Containers with a Stop or Start request on its way to the server.
  const [sending, setSending] = useState<ReadonlySet<string>>(new Set());
  // The timelines on screen, by container. Fetched when opened, then kept current from the live stream.
  const [timelines, setTimelines] = useState<Readonly<Record<string, OpenTimeline>>>({});
  const openTimelines = useRef<ReadonlySet<string>>(new Set());
  const [chaos, setChaos] = useChaos(fetchChaos);

  const loadTimeline = useCallback(
    (id: string) => {
      setTimelines((t) => ({ ...t, [id]: { entries: t[id]?.entries ?? [], loading: true, error: null } }));
      fetchTimeline(id).then(
        (entries) =>
          setTimelines((t) => (t[id] ? { ...t, [id]: { entries: mergeTimeline(t[id].entries, entries), loading: false, error: null } } : t)),
        (e: unknown) => {
          if (e instanceof NotLoggedIn) return onSessionEnded();
          setTimelines((t) => (t[id] ? { ...t, [id]: { ...t[id], loading: false, error: e instanceof Error ? e.message : String(e) } } : t));
        },
      );
    },
    [onSessionEnded],
  );

  const toggleTimeline = (id: string) => {
    const next = new Set(openTimelines.current);
    if (next.has(id)) {
      next.delete(id);
      setTimelines(({ [id]: _closed, ...rest }) => rest);
    } else {
      next.add(id);
      loadTimeline(id);
    }
    openTimelines.current = next;
  };

  useEffect(
    () =>
      subscribeToContainers({
        onEvent: (event) => {
          if (event.type === "snapshot") {
            setReadOnly(event.readOnly);
            setContainerLimit(event.containerLimit);
            // Entries recorded while the stream was down never arrived: fetch what is open again.
            for (const id of openTimelines.current) loadTimeline(id);
          }
          if (event.type === "timeline") {
            const { entry } = event;
            setTimelines((t) => {
              const open = t[entry.containerId];
              return open ? { ...t, [entry.containerId]: { ...open, entries: mergeTimeline(open.entries, [entry]) } } : t;
            });
            return;
          }
          setContainers((list) => applyEvent(list, event));
        },
        onConnection: setConnected,
        onClosed: onStreamClosed,
      }),
    [onStreamClosed, loadTimeline],
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
      if (e instanceof NotLoggedIn) return onSessionEnded();
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
      if (e instanceof NotLoggedIn) return onSessionEnded();
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending((ids) => {
        const next = new Set(ids);
        next.delete(containerId);
        return next;
      });
    }
  };

  const onDeleteOutside = async (containerId: string) => {
    try {
      await deleteOutside(containerId);
      setError(null);
    } catch (e) {
      if (e instanceof NotLoggedIn) return onSessionEnded();
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // A hint only: the server refuses the create either way, with its own message.
  const atLimit = containerLimit !== null && containers !== null && containers.length >= containerLimit;
  const createHintId = readOnly ? READ_ONLY_BANNER_ID : atLimit ? LIMIT_HINT_ID : undefined;

  return (
    <main>
      <header>
        <h1>Railway Container Control</h1>
        <div className="actions">
          <button
            type="button"
            className="primary"
            onClick={() => void onCreate()}
            disabled={creating || readOnly !== null || atLimit}
            aria-describedby={createHintId}
          >
            {creating ? "Creating…" : "Create container"}
          </button>
          {atLimit && !readOnly && (
            <small id={LIMIT_HINT_ID} className="hint">
              {containerLimit} of {containerLimit} containers in use (stopped ones count). Destroy one to create another.
            </small>
          )}
        </div>
      </header>

      {chaos?.enabled && <ChaosPanel state={chaos} onState={setChaos} onSessionEnded={onSessionEnded} />}

      {readOnly && (
        <p id={READ_ONLY_BANNER_ID} role="alert" className="banner-read-only">
          {readOnly.reason}
        </p>
      )}

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
              <th scope="col">Time left</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody aria-live="polite">
            {containers.map((c) => {
              const timeline = timelines[c.id];
              return (
                <Fragment key={c.id}>
                  <tr>
                    <td>
                      <code>{c.name}</code>
                      <div>
                        <button
                          type="button"
                          className="link"
                          aria-expanded={timeline !== undefined}
                          aria-controls={`timeline-${c.id}`}
                          onClick={() => toggleTimeline(c.id)}
                        >
                          {timeline ? "Hide timeline" : "Timeline"}
                          <span className="visually-hidden"> of {c.name}</span>
                        </button>
                      </div>
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
                      <Countdown expiresAt={c.expiresAt} now={now} />
                    </td>
                    <td>
                      <ContainerActions
                        container={c}
                        sending={sending.has(c.id)}
                        readOnly={readOnly !== null}
                        onAction={(action) => void onAction(c.id, action)}
                        onDeleteOutside={chaos?.enabled ? () => void onDeleteOutside(c.id) : undefined}
                      />
                    </td>
                  </tr>
                  {timeline && (
                    <tr id={`timeline-${c.id}`} className="timeline-row">
                      <td colSpan={6}>
                        <Timeline {...timeline} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
    </main>
  );
}
