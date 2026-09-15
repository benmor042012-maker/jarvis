import { useCallback, useEffect, useState } from "react";

import { api } from "../api";
import { Dialog } from "../components/Dialog";
import { describeError } from "../lib/protocol";
import { useAction } from "../lib/useAction";
import { useJarvis } from "../state/jarvisStore";
import type { AuditEntry } from "../types";

export function AuditPanel() {
  const setPanel = useJarvis((s) => s.setPanel);
  const isOwner = useJarvis((s) => s.creds?.role) === "owner";
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(7);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setEntries((await api.audit(500, days)).entries);
      setError(null);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, [days]);
  useEffect(() => {
    void load();
  }, [load]);

  const [exportData, exportState] = useAction(async () => {
    const data = await api.exportData();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `jarvis-export-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  const [wipe, wipeState] = useAction(async () => {
    await api.deleteData({ audit: true, memory: true, drafts: true, screenshots: true });
    await load();
  });

  const shown = entries.filter((e) => !filter || JSON.stringify(e).toLowerCase().includes(filter.toLowerCase())).reverse();

  return (
    <Dialog title="Activity log" onClose={() => { setPanel(null); }} wide>
      <p className="help">Every plan, approval, action, denial and emergency stop, stored locally in ~/.jarvis/logs. Secrets, clipboard contents, typed text and file contents are never written here — only sizes and paths.</p>
      <div className="row">
        <label className="field">
          <span>Days</span>
          <select value={days} onChange={(e) => { setDays(Number(e.target.value)); }}>
            {[1, 7, 30, 90].map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>
        <label className="field grow">
          <span>Filter</span>
          <input value={filter} onChange={(e) => { setFilter(e.target.value); }} placeholder="tool, event, device…" />
        </label>
        <button type="button" className="btn" onClick={() => void load()} disabled={loading}>
          {loading ? "Loading…" : "Refresh"}
        </button>
        {isOwner && (
          <>
            <button type="button" className="btn" onClick={() => void exportData()} disabled={exportState.phase === "loading"}>
              {exportState.phase === "loading" ? "Exporting…" : exportState.phase === "success" ? "Exported ✓" : "Export my data"}
            </button>
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => {
                if (window.confirm("Delete local logs, memory, drafts and screenshots? This cannot be undone.")) void wipe();
              }}
              disabled={wipeState.phase === "loading"}
            >
              {wipeState.phase === "loading" ? "Deleting…" : "Delete local data"}
            </button>
          </>
        )}
      </div>
      {(error ?? exportState.error ?? wipeState.error) && (
        <p role="alert" className="error-text">
          {error ?? exportState.error ?? wipeState.error}
        </p>
      )}
      {shown.length === 0 && !loading ? (
        <p className="log-empty">Nothing recorded for this period.</p>
      ) : (
        <ol className="audit">
          {shown.map((e, i) => (
            <li key={`${e.time}-${String(i)}`} data-status={e.status ?? ""}>
              <time dateTime={e.time}>{e.time.slice(11, 19)}</time>
              <span className="event">{e.event}</span>
              {e.tool && <span className="tool">{e.tool}</span>}
              {e.risk && <span className="risk" data-risk={e.risk}>{e.risk}</span>}
              {e.device && <span className="who">{e.device}</span>}
              {e.status && <span className="st">{e.status}</span>}
              {(e.params ?? e.detail) != null && (
                <details>
                  <summary>details</summary>
                  <pre>{JSON.stringify({ params: e.params, detail: e.detail }, null, 2)}</pre>
                </details>
              )}
            </li>
          ))}
        </ol>
      )}
    </Dialog>
  );
}
