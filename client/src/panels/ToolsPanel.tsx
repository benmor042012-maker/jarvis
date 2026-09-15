import { useCallback, useEffect, useState } from "react";

import { api } from "../api";
import { Dialog } from "../components/Dialog";
import { describeError } from "../lib/protocol";
import { useJarvis } from "../state/jarvisStore";
import type { PolicyValue, ToolInfo } from "../types";

const POLICIES: { value: PolicyValue | "default"; label: string }[] = [
  { value: "default", label: "Default for the mode" },
  { value: "allowed", label: "Allowed" },
  { value: "ask_every_time", label: "Ask every time" },
  { value: "allowed_for_task", label: "Allowed for a task" },
  { value: "blocked", label: "Blocked" },
];

export function ToolsPanel() {
  const setPanel = useJarvis((s) => s.setPanel);
  const mode = useJarvis((s) => s.status?.mode);
  const isOwner = useJarvis((s) => s.creds?.role) === "owner";
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  const load = useCallback(async () => {
    try {
      setTools((await api.tools()).tools);
      setError(null);
    } catch (err) {
      setError(describeError(err));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const change = async (tool: string, policy: PolicyValue | "default") => {
    setSaving(tool);
    try {
      setTools((await api.setToolPolicy(tool, policy)).tools);
      setError(null);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSaving(null);
    }
  };

  const shown = tools.filter((t) => !filter || `${t.name} ${t.title} ${t.description} ${t.category}`.toLowerCase().includes(filter.toLowerCase()));
  const categories = [...new Set(shown.map((t) => t.category))];

  return (
    <Dialog title="Tools and permissions" onClose={() => { setPanel(null); }} wide>
      <p className="help">
        Mode: <strong>{mode ?? "—"}</strong>. Safe mode runs only low-risk reversible tools. Assistant mode asks for medium and high risk. Advanced mode uses the per-tool policy below — high-risk tools always ask, whatever the policy says.
        {!isOwner && " Only the JARVIS computer can change policies."}
      </p>
      <label className="field">
        <span>Filter</span>
        <input value={filter} onChange={(e) => { setFilter(e.target.value); }} placeholder="e.g. file, mouse, powershell" />
      </label>
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
      {tools.length === 0 && !error && <p className="help">Loading tools…</p>}
      {categories.map((cat) => (
        <section key={cat}>
          <h3>{cat}</h3>
          <ul className="list">
            {shown
              .filter((t) => t.category === cat)
              .map((t) => (
                <li key={t.name} className="list-item">
                  <div>
                    <strong>
                      {t.title} <span className="risk" data-risk={t.risk}>{t.risk}</span> {!t.availability.ok && <span className="pill" data-state="offline">unavailable</span>}
                    </strong>
                    <span className="help">
                      {t.description} {t.availability.ok ? "" : `· ${t.availability.reason ?? ""}`}
                    </span>
                  </div>
                  <label>
                    <span className="sr-only">Policy for {t.title}</span>
                    <select value={t.policy ?? "default"} disabled={!isOwner || saving === t.name} onChange={(e) => void change(t.name, e.target.value as PolicyValue | "default")}>
                      {POLICIES.map((p) => (
                        <option key={p.value} value={p.value}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </li>
              ))}
          </ul>
        </section>
      ))}
    </Dialog>
  );
}
