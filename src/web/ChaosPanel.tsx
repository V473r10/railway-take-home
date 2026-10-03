import { useCallback, useEffect, useRef, useState } from "react";
import { type ArmedFault, armChaos, type ChaosState, crashServer, cutSubscriptions, NotLoggedIn } from "./api.ts";

const POLL_MS = 1_500;

const ARMED_LABEL: Record<ArmedFault, string> = {
  drop_next_response: "Lose the next response",
  crash_after_next_write: "Kill the process after the next write",
};

/**
 * Break the app on purpose, against real Railway, then open a container's timeline to
 * watch it recover. Shown only when the server runs with CHAOS=1.
 */
export function ChaosPanel({ state, onState, onSessionEnded }: {
  state: ChaosState;
  onState: (state: ChaosState) => void;
  onSessionEnded: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // A fault the server reports disarmed without a click here has fired.
  const armed = useRef(state.armed);
  useEffect(() => {
    if (armed.current && !state.armed) setMessage(`Fired: ${ARMED_LABEL[armed.current]}. Open the timeline of the container it hit.`);
    armed.current = state.armed;
  }, [state.armed]);

  const run = useCallback(
    async (work: () => Promise<string | null>) => {
      setBusy(true);
      try {
        setMessage(await work());
      } catch (e) {
        if (e instanceof NotLoggedIn) return onSessionEnded();
        setMessage(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [onSessionEnded],
  );

  const arm = (fault: ArmedFault | null) =>
    run(async () => {
      armed.current = null; // a disarm clicked here is not a fault firing
      onState(await armChaos(fault));
      return fault ? null : "Disarmed.";
    });

  const onCrash = () => {
    if (!window.confirm("Kill the server process now? It restarts and resumes whatever was in flight.")) return;
    void run(async () => {
      await crashServer();
      return "Killed. The page reconnects once the process is back.";
    });
  };

  return (
    <section className="chaos" aria-labelledby="chaos-title">
      <h2 id="chaos-title">Chaos mode</h2>
      <p className="hint">
        Break it on purpose, then open a container's timeline to see how it recovers. Every fault here is one the app is
        built to survive.
      </p>
      <div className="chaos-buttons">
        {(["drop_next_response", "crash_after_next_write"] as const).map((fault) => (
          <button key={fault} type="button" onClick={() => void arm(fault)} disabled={busy} aria-pressed={state.armed === fault}>
            {ARMED_LABEL[fault]}
          </button>
        ))}
        {state.armed && (
          <button type="button" onClick={() => void arm(null)} disabled={busy}>
            Disarm
          </button>
        )}
        <button type="button" onClick={() => void run(async () => `Cut ${(await cutSubscriptions()).cut} WebSocket subscription(s).`)} disabled={busy}>
          Cut the WebSocket
        </button>
        <button type="button" className="danger" onClick={onCrash} disabled={busy}>
          Kill the process now
        </button>
      </div>
      <p role="status" className="hint">
        {state.armed ? `Armed: ${ARMED_LABEL[state.armed]}. Create, stop, start or destroy a container to trigger it.` : message}
      </p>
    </section>
  );
}

/** Chaos mode's state, polled while a fault is armed so the panel shows when it fired. */
export function useChaos(fetchState: () => Promise<ChaosState>): [ChaosState | null, (s: ChaosState) => void] {
  const [state, setState] = useState<ChaosState | null>(null);
  useEffect(() => {
    void fetchState().then(setState, () => setState(null));
  }, [fetchState]);
  useEffect(() => {
    if (!state?.armed) return;
    const timer = setInterval(() => void fetchState().then(setState, () => {}), POLL_MS);
    return () => clearInterval(timer);
  }, [state?.armed, fetchState]);
  return [state, setState];
}
