// The Command Center: the side panels around the orb.
//
// Every number here is real and comes from this computer — the agent's own
// status, the speech engine that is actually loaded, the brain that is actually
// answering (or MOCK MODE, said plainly), memory and disk read from Windows.
// Nothing is decorative: a panel with nothing true to show says so.
import { useEffect, useState } from "react";

import { api } from "../api";
import { describeError } from "../lib/protocol";
import { useJarvis } from "../state/jarvisStore";
import type { AiStatus, SystemStatus } from "../types";

function Ring({ value, label, detail }: { value: number | null; label: string; detail: string }) {
  const r = 26;
  const c = 2 * Math.PI * r;
  const pct = value === null ? 0 : Math.max(0, Math.min(100, value));
  return (
    <div className="cc-ring" role="img" aria-label={`${label}: ${value === null ? "unknown" : `${String(Math.round(pct))}%`}`}>
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <circle cx="32" cy="32" r={r} className="cc-ring-track" />
        <circle cx="32" cy="32" r={r} className="cc-ring-fill" strokeDasharray={`${String((pct / 100) * c)} ${String(c)}`} transform="rotate(-90 32 32)" />
        <text x="32" y="36" textAnchor="middle" className="cc-ring-text">{value === null ? "—" : `${String(Math.round(pct))}%`}</text>
      </svg>
      <span className="cc-ring-label">{label}</span>
      <span className="cc-ring-detail">{detail}</span>
    </div>
  );
}

function Clock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = window.setInterval(() => { setNow(new Date()); }, 1000);
    return () => { window.clearInterval(t); };
  }, []);
  return (
    <div className="cc-clock">
      <span className="cc-time">{now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
      <span className="cc-date">{now.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long", year: "numeric" })}</span>
    </div>
  );
}

export function CommandCenterLeft() {
  const status = useJarvis((s) => s.status);
  const voice = useJarvis((s) => s.voice);
  const connection = useJarvis((s) => s.connection);
  const job = useJarvis((s) => s.activeJob);
  const pending = useJarvis((s) => s.pendingPlans);
  const [ai, setAi] = useState<AiStatus | null>(null);
  const [tools, setTools] = useState<number | null>(null);
  const [sys, setSys] = useState<SystemStatus | null>(null);
  const [sysError, setSysError] = useState<string | null>(null);

  useEffect(() => {
    if (connection !== "online") return;
    let stop = false;
    const load = async () => {
      try {
        const [a, t] = await Promise.all([api.aiDetect(false), api.tools()]);
        if (stop) return;
        setAi(a);
        setTools(t.tools.length);
      } catch {
        /* shown as unknown below */
      }
    };
    void load();
    const t = window.setInterval(() => { void load(); }, 60000);
    return () => { stop = true; window.clearInterval(t); };
  }, [connection]);

  useEffect(() => {
    if (connection !== "online") return;
    let stop = false;
    const load = async () => {
      try {
        const s = await api.systemStatus();
        if (stop) return;
        setSys(s);
        setSysError(null);
      } catch (err) {
        if (!stop) setSysError(describeError(err));
      }
    };
    void load();
    const t = window.setInterval(() => { void load(); }, 30000);
    return () => { stop = true; window.clearInterval(t); };
  }, [connection]);

  const engine = voice?.engine;
  const memUsed = sys ? Math.round(((sys.memory_total_gb - sys.memory_free_gb) / Math.max(0.1, sys.memory_total_gb)) * 100) : null;
  const disk = sys?.disks[0] ?? null;
  const diskUsed = disk && disk.total_gb > 0 ? Math.round(((disk.total_gb - disk.free_gb) / disk.total_gb) * 100) : null;
  const brain = ai ? (ai.mock_mode ? "MOCK MODE — rules only" : `${ai.active.provider} · ${ai.active.model ?? "?"}`) : "checking…";

  const rows: { k: string; v: string; state: "ok" | "warn" | "off" }[] = [
    { k: "AI Core", v: status ? `v${status.version} · ${status.state}${status.emergency ? " · EMERGENCY" : ""}` : "offline", state: status ? (status.emergency ? "warn" : "ok") : "off" },
    { k: "Brain", v: brain, state: ai ? (ai.mock_mode ? "warn" : "ok") : "off" },
    { k: "Voice", v: voice ? `${voice.state}${engine?.model ? ` · ${engine.model}` : ""}` : "—", state: voice?.engine.available ? "ok" : "warn" },
    { k: "Model in memory", v: engine?.speed?.server?.running ? `yes · ${engine.speed.server.model ?? ""}` : "no", state: engine?.speed?.server?.running ? "ok" : "warn" },
    { k: "Tools", v: tools === null ? "—" : `${String(tools)} available`, state: tools ? "ok" : "off" },
    { k: "Agents", v: job && (job.status === "running" || job.status === "queued") ? `1 running · ${String(job.completed)}/${String(job.total)}` : `idle${pending.length ? ` · ${String(pending.length)} awaiting approval` : ""}`, state: pending.length ? "warn" : "ok" },
    { k: "Devices", v: status ? `${String(status.devices.connected)} connected · ${String(status.devices.paired)} paired` : "—", state: "ok" },
    { k: "Network", v: status ? (status.offline_mode ? "offline mode" : `local only · ${String(status.cost_network.external_calls)} external calls`) : "—", state: "ok" },
  ];

  return (
    <aside className="cc-col cc-left" aria-label="AI core overview">
      <section className="cc-panel">
        <h3>AI Core Overview</h3>
        <ul className="cc-rows">
          {rows.map((r) => (
            <li key={r.k} data-state={r.state}>
              <span className="cc-dot" aria-hidden="true" />
              <span className="cc-k">{r.k}</span>
              <span className="cc-v">{r.v}</span>
            </li>
          ))}
        </ul>
      </section>
      <section className="cc-panel">
        <h3>System Monitor</h3>
        {sysError ? (
          <p className="help">{sysError}</p>
        ) : (
          <div className="cc-rings">
            <Ring value={memUsed} label="RAM" detail={sys ? `${String(Math.round((sys.memory_total_gb - sys.memory_free_gb) * 10) / 10)} / ${String(sys.memory_total_gb)} GB` : "reading…"} />
            <Ring value={diskUsed} label={disk ? `Disk ${disk.drive}` : "Disk"} detail={disk ? `${String(disk.free_gb)} GB free` : sys ? "no disk reported" : "reading…"} />
            <Ring value={sys?.battery ? sys.battery.percent : null} label="Battery" detail={sys ? (sys.battery ? (sys.battery.charging ? "charging" : "on battery") : "no battery") : "reading…"} />
          </div>
        )}
        {sys && <p className="cc-foot">{sys.computer} · up {String(sys.uptime_hours)} h · refreshed every 30 s</p>}
      </section>
    </aside>
  );
}

const QUICK: { label: string; command?: string; panel?: "projects" | "voice" | "drafts" | "settings" }[] = [
  { label: "מה השעה", command: "מה השעה" },
  { label: "מצב המחשב", command: "מצב המחשב" },
  { label: "הפתקים שלי", command: "הפתקים שלי" },
  { label: "אנשי קשר", command: "אנשי קשר" },
  { label: "Project builder", panel: "projects" },
  { label: "Draft messages", panel: "drafts" },
  { label: "Voice panel", panel: "voice" },
  { label: "Settings panel", panel: "settings" },
];

export function CommandCenterRight({ onFocus }: { onFocus: () => void }) {
  const submit = useJarvis((s) => s.submitCommand);
  const setPanel = useJarvis((s) => s.setPanel);
  const busy = useJarvis((s) => s.busy);
  const connection = useJarvis((s) => s.connection);
  const alerts = useJarvis((s) => s.alerts);
  const openAlerts = alerts.filter((a) => a.status === "open" || a.status === "acknowledged");
  const heard = useJarvis((s) => s.voice?.last_heard ?? null);
  const stats = useJarvis((s) => s.voice?.stats ?? null);

  return (
    <aside className="cc-col cc-right" aria-label="Quick commands">
      <Clock />
      <section className="cc-panel">
        <h3>Quick Commands</h3>
        <div className="cc-quick">
          {QUICK.map((qc) => (
            <button
              key={qc.label}
              type="button"
              className="btn btn-ghost"
              disabled={qc.command ? busy || connection !== "online" : false}
              onClick={() => {
                if (qc.command) void submit(qc.command);
                else if (qc.panel) setPanel(qc.panel);
              }}
            >
              {qc.label}
            </button>
          ))}
        </div>
      </section>
      <section className="cc-panel">
        <h3>Live Intelligence</h3>
        <ul className="cc-rows">
          <li data-state={openAlerts.length ? "warn" : "ok"}>
            <span className="cc-dot" aria-hidden="true" />
            <span className="cc-k">Customer alerts</span>
            <span className="cc-v">{openAlerts.length ? `${String(openAlerts.length)} need you` : "none open"}</span>
          </li>
          <li data-state="ok">
            <span className="cc-dot" aria-hidden="true" />
            <span className="cc-k">Last heard</span>
            <span className="cc-v">{heard ? `“${heard.text}”${heard.took_ms ? ` · ${String(Math.round(heard.took_ms / 100) / 10)}s` : ""}` : "nothing yet"}</span>
          </li>
          <li data-state="ok">
            <span className="cc-dot" aria-hidden="true" />
            <span className="cc-k">This session</span>
            <span className="cc-v">{stats ? `${String(stats.wakes)} wakes · ${String(stats.commands)} commands · ${String(stats.stops)} stops` : "—"}</span>
          </li>
        </ul>
      </section>
      <button type="button" className="btn btn-ghost cc-focus" onClick={onFocus} title="Hide the side panels and keep only the orb">
        Focus mode
      </button>
    </aside>
  );
}
