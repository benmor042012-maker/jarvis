import { useEffect, useRef } from "react";

import { useJarvis } from "../state/jarvisStore";

const LABEL: Record<string, string> = {
  user: "You",
  assistant: "JARVIS",
  action: "Action",
  system: "System",
  error: "Error",
};

function time(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function ActivityLog() {
  const log = useJarvis((s) => s.log);
  const clearLog = useJarvis((s) => s.clearLog);
  const job = useJarvis((s) => s.job);
  const endRef = useRef<HTMLLIElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [log.length]);

  return (
    <aside className="log" aria-label="Activity log">
      <div className="log-head">
        <span>
          Activity
          {job && (job.status === "running" || job.status === "queued") && (
            <>
              {" "}
              · {job.completed}/{job.total}
            </>
          )}
        </span>
        <button type="button" className="btn btn-ghost" onClick={clearLog} disabled={log.length === 0}>
          Clear
        </button>
      </div>
      {log.length === 0 ? (
        <p className="log-empty">No activity yet. Try “open github”, “launch notepad” or “search for report”.</p>
      ) : (
        <ol className="log-list" aria-live="polite" aria-relevant="additions">
          {log.map((e) => (
            <li key={e.id} className="log-item" data-kind={e.kind}>
              <span className="bar" aria-hidden="true" />
              <div>
                <div className="log-meta">
                  <span>{LABEL[e.kind] ?? e.kind}</span>
                  <time dateTime={new Date(e.at).toISOString()}>{time(e.at)}</time>
                </div>
                <p className="log-text">{e.text}</p>
                {e.detail && (
                  <details>
                    <summary>Details</summary>
                    <pre>{e.detail}</pre>
                  </details>
                )}
              </div>
            </li>
          ))}
          <li ref={endRef} aria-hidden="true" />
        </ol>
      )}
    </aside>
  );
}
