import type { TimelineEntry } from "./api.ts";

type Tone = "ok" | "warn" | "bad" | "info";

const OPERATION: Record<string, string> = { create: "Create", stop: "Stop", start: "Start", destroy: "Destroy" };

function shortId(id: string): string {
  return id.slice(0, 8);
}

/** What one entry says, in words, and how alarming it is. */
function describe(entry: TimelineEntry): { tone: Tone; text: string; detail?: string } {
  switch (entry.kind) {
    case "requested":
      return entry.by === "lifetime"
        ? { tone: "info", text: `${OPERATION[entry.operation]} requested by the lifetime sweep` }
        : { tone: "info", text: `${OPERATION[entry.operation]} requested` };
    case "began":
      return entry.resumed
        ? { tone: "warn", text: `${OPERATION[entry.operation]} resumed by a new process`, detail: "The last one stopped mid-way; this one looks at Railway before acting." }
        : { tone: "info", text: `${OPERATION[entry.operation]} started` };
    case "call": {
      const attempt = entry.attempt > 1 ? ` (attempt ${entry.attempt})` : "";
      switch (entry.outcome) {
        case "ok":
          return { tone: "ok", text: `${entry.call}${attempt}: answered` };
        case "ambiguous":
          return { tone: "warn", text: `${entry.call}${attempt}: no response`, detail: `Railway may or may not have acted. ${entry.message ?? ""}`.trim() };
        case "rate_limited":
          return { tone: "warn", text: `${entry.call}${attempt}: rate limited`, detail: "Railway did not act; retried after Retry-After." };
        case "rejected":
          return {
            tone: "bad",
            text: `${entry.call}${attempt}: rejected`,
            detail: `${entry.message ?? ""}${entry.traceId ? ` (trace ${entry.traceId})` : ""}`,
          };
      }
      break;
    }
    case "lookup":
      switch (entry.result) {
        case "acted":
          return { tone: "ok", text: `Looked before repeating ${entry.call}: it had acted`, detail: "Not repeated." };
        case "not_acted":
          return { tone: "info", text: `Looked before repeating ${entry.call}: it had not acted`, detail: "Repeating it." };
        case "unknown":
          return { tone: "warn", text: `Looked before repeating ${entry.call}: no answer either`, detail: `Not repeated yet. ${entry.message ?? ""}`.trim() };
      }
      break;
    case "deployment":
      return { tone: "info", text: `New deployment ${shortId(entry.deploymentId)}` };
    case "observed":
      return { tone: "info", text: `Railway reports ${entry.status}${entry.stopped ? ", stopped" : ""}`, detail: `deployment ${shortId(entry.deploymentId)}` };
    case "succeeded":
      return { tone: "ok", text: `${OPERATION[entry.operation]} succeeded` };
    case "failed":
      return { tone: "bad", text: `${OPERATION[entry.operation]} failed`, detail: entry.message };
    case "unanswered":
      return {
        tone: "warn",
        text: `${OPERATION[entry.operation]}: no answer after every retry`,
        detail: "Left active and flagged, so it is resolved by looking at Railway instead of guessing.",
      };
    case "missing":
      return { tone: "bad", text: "Service deleted outside the app" };
    case "followed":
      return { tone: "info", text: `Deployment replaced outside the app; following ${shortId(entry.deploymentId)}` };
  }
  return { tone: "info", text: (entry as { kind: string }).kind };
}

function clockTime(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleTimeString([], { hour12: false })}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

/** Everything the app did for one container: each request, each call to Railway and how it ended. */
export function Timeline({ entries, loading, error }: { entries: readonly TimelineEntry[]; loading: boolean; error: string | null }) {
  if (error) return <p className="error">{error}</p>;
  if (loading && entries.length === 0) return <p aria-live="polite">Loading the timeline…</p>;
  if (entries.length === 0) return <p>Nothing recorded yet.</p>;
  return (
    <ol className="timeline" aria-live="off">
      {entries.map((entry) => {
        const { tone, text, detail } = describe(entry);
        return (
          <li key={entry.seq} className={`tone-${tone}`}>
            <time dateTime={entry.at}>{clockTime(entry.at)}</time>
            <span className="timeline-text">
              {text}
              {detail && <small> {detail}</small>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
