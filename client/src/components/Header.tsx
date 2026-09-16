import { api } from "../api";
import { useAction } from "../lib/useAction";
import { reconnectNow, useJarvis } from "../state/jarvisStore";
import type { Panel } from "../state/jarvisStore";

const PANELS: { id: Exclude<Panel, null>; label: string; icon: string }[] = [
  { id: "status", label: "Status", icon: "◉" },
  { id: "voice", label: "Voice", icon: "🎙" },
  { id: "alerts", label: "Customer alerts", icon: "⚠" },
  { id: "phone", label: "Phone", icon: "☎" },
  { id: "projects", label: "Projects", icon: "⌬" },
  { id: "drafts", label: "Drafts", icon: "✉" },
  { id: "devices", label: "Devices", icon: "⌁" },
  { id: "tools", label: "Tools", icon: "⚙" },
  { id: "audit", label: "Activity log", icon: "☰" },
  { id: "settings", label: "Settings", icon: "✧" },
];

export function Header() {
  const connection = useJarvis((s) => s.connection);
  const status = useJarvis((s) => s.status);
  const reconnectIn = useJarvis((s) => s.reconnectIn);
  const panel = useJarvis((s) => s.panel);
  const setPanel = useJarvis((s) => s.setPanel);
  const emergency = useJarvis((s) => s.emergencyStop);
  const clearEmergency = useJarvis((s) => s.clearEmergency);
  const [stop, stopState] = useAction(emergency);
  const [clear, clearState] = useAction(clearEmergency);
  const [setMode, modeState] = useAction(async (mode: string) => {
    await api.setMode(mode);
    await useJarvis.getState().refreshStatus();
    await useJarvis.getState().refreshSettings();
  });

  const state = connection === "online" ? (status?.emergency ? "emergency" : status?.state ?? "online") : connection;
  const label =
    connection === "connecting"
      ? "Connecting…"
      : connection === "unpaired"
        ? "Not paired"
        : connection === "unauthorized"
          ? "Not authorized"
          : connection === "offline"
            ? reconnectIn !== null
              ? `Offline · retry in ${String(reconnectIn)}s`
              : "Offline"
            : status?.emergency
              ? "Emergency stopped"
              : status?.paused
                ? "Paused"
                : status?.state === "busy"
                  ? "Busy"
                  : "Connected";

  const isOwner = useJarvis((s) => s.creds?.role) === "owner";
  const openAlerts = useJarvis((s) => s.alerts.filter((a) => a.status === "open" || a.status === "acknowledged").length);

  return (
    <header className="header">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true" />
        <span>JARVIS</span>
      </div>
      <div className="header-meta">
        <span className="pill" data-state={state} role="status" aria-live="polite">
          <span className="dot" aria-hidden="true" />
          {label}
        </span>
        {connection === "offline" && (
          <button type="button" className="btn btn-ghost" onClick={reconnectNow}>
            Retry now
          </button>
        )}
        {status && (
          <label className="pill pill-select">
            <span className="sr-only">Permission mode</span>
            <select value={status.mode} disabled={!isOwner || modeState.phase === "loading"} onChange={(e) => void setMode(e.target.value)} title={isOwner ? "Permission mode" : "Only the JARVIS computer can change the mode"}>
              <option value="safe">Safe mode</option>
              <option value="assistant">Assistant mode</option>
              <option value="advanced">Advanced mode</option>
            </select>
          </label>
        )}
        {status?.offline_mode && <span className="pill pill-model">Offline mode</span>}
        {status && !status.offline_mode && <span className="pill pill-model">Local only · 0 external calls</span>}

        <nav className="panel-tabs" aria-label="Panels">
          {PANELS.map((p) => (
            <button
              key={p.id}
              type="button"
              className="icon-btn"
              data-badge={p.id === "alerts" && openAlerts > 0 ? String(openAlerts) : undefined}
              aria-pressed={panel === p.id}
              title={p.label}
              aria-label={p.id === "alerts" && openAlerts > 0 ? `${p.label} (${String(openAlerts)} open)` : p.label}
              onClick={() => { setPanel(panel === p.id ? null : p.id); }}
            >
              <span aria-hidden="true">{p.icon}</span>
            </button>
          ))}
        </nav>

        {status?.emergency ? (
          <button type="button" className="btn btn-primary" onClick={() => void clear()} disabled={clearState.phase === "loading" || !isOwner} title={isOwner ? "Clear the emergency stop" : "Only the JARVIS computer can clear the emergency stop"}>
            {clearState.phase === "loading" ? "Clearing…" : "Clear stop"}
          </button>
        ) : (
          <button type="button" className="btn btn-danger" onClick={() => void stop()} disabled={stopState.phase === "loading" || connection !== "online"} title="Stop everything now (Ctrl+Shift+Escape on the computer)">
            {stopState.phase === "loading" ? "Stopping…" : "STOP"}
          </button>
        )}
      </div>
      {(stopState.error ?? clearState.error ?? modeState.error) && (
        <p className="header-error" role="alert">
          {stopState.error ?? clearState.error ?? modeState.error}
        </p>
      )}
    </header>
  );
}
