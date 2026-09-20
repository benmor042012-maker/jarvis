// The main screen: a command centre around the core.
//
// Every figure on it is read from this computer — the agent's own status, the
// speech engine that is actually loaded, the model that is actually answering
// (or MOCK MODE, said plainly), the notes and reminders JARVIS really holds,
// memory and disk from the operating system. Nothing is decorative: a panel
// with nothing true to show says so, and a feature JARVIS does not have is
// marked unavailable with the reason rather than drawn as if it worked.
import { useEffect, useState } from "react";

import { api } from "../api";
import { describeError } from "../lib/protocol";
import { useAction } from "../lib/useAction";
import { reconnectNow, useJarvis } from "../state/jarvisStore";
import type { Panel } from "../state/jarvisStore";
import type { AiStatus, AuditEntry, MemorySummary, SystemStatus } from "../types";
import { ActivityLog } from "./ActivityLog";
import { JarvisOrb } from "./JarvisOrb";
import { VoiceBar } from "./VoiceBar";

type Section = "agents" | "timeline" | "memory";

/**
 * The left navigation. Each entry opens either one of the existing panels or
 * scrolls to a section of this screen; none of them is a placeholder.
 */
const NAV: { label: string; icon: string; panel?: Exclude<Panel, null>; section?: Section; home?: boolean }[] = [
  { label: "Command Center", icon: "◈", home: true },
  { label: "AI Core", icon: "◉", panel: "status" },
  { label: "Agents", icon: "⬡", section: "agents" },
  { label: "Tasks", icon: "☑", panel: "projects" },
  { label: "Calendar", icon: "▦", section: "timeline" },
  { label: "Memory", icon: "◍", section: "memory" },
  { label: "Conversations", icon: "☰", panel: "audit" },
  { label: "Knowledge Base", icon: "▤", section: "memory" },
  { label: "Tools & Skills", icon: "⚙", panel: "tools" },
  { label: "Workflows", icon: "⇶", panel: "projects" },
];
const MORE: { label: string; icon: string; panel: Exclude<Panel, null> }[] = [
  { label: "Voice", icon: "🎙", panel: "voice" },
  { label: "Customer alerts", icon: "⚠", panel: "alerts" },
  { label: "Phone", icon: "☎", panel: "phone" },
  { label: "Drafts", icon: "✉", panel: "drafts" },
  { label: "Devices", icon: "⌁", panel: "devices" },
  { label: "Settings", icon: "✧", panel: "settings" },
];

function scrollTo(section: Section) {
  document.getElementById(`dash-${section}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function Sidebar() {
  const panel = useJarvis((s) => s.panel);
  const setPanel = useJarvis((s) => s.setPanel);
  const openAlerts = useJarvis((s) => s.alerts.filter((a) => a.status === "open" || a.status === "acknowledged").length);
  const status = useJarvis((s) => s.status);
  return (
    <nav className="side" aria-label="Sections">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true" />
        <span>JARVIS</span>
      </div>
      <ul className="side-list">
        {NAV.map((n) => (
          <li key={n.label}>
            <button
              type="button"
              className="side-item"
              aria-pressed={n.home ? panel === null : n.panel ? panel === n.panel : false}
              onClick={() => {
                if (n.home) { setPanel(null); window.scrollTo({ top: 0 }); }
                else if (n.panel) setPanel(panel === n.panel ? null : n.panel);
                else if (n.section) { setPanel(null); scrollTo(n.section); }
              }}
            >
              <span className="side-icon" aria-hidden="true">{n.icon}</span>
              {n.label}
            </button>
          </li>
        ))}
      </ul>
      <p className="side-group">Also</p>
      <ul className="side-list">
        {MORE.map((n) => (
          <li key={n.label}>
            <button
              type="button"
              className="side-item"
              aria-pressed={panel === n.panel}
              aria-label={n.panel === "alerts" && openAlerts > 0 ? `${n.label} (${String(openAlerts)} open)` : n.label}
              data-badge={n.panel === "alerts" && openAlerts > 0 ? String(openAlerts) : undefined}
              onClick={() => { setPanel(panel === n.panel ? null : n.panel); }}
            >
              <span className="side-icon" aria-hidden="true">{n.icon}</span>
              {n.label}
            </button>
          </li>
        ))}
      </ul>
      <p className="side-foot">
        {status ? `v${status.version} · ${status.host}` : "—"}
        <br />
        Local only · no cloud · no keys
      </p>
    </nav>
  );
}

function Clock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = window.setInterval(() => { setNow(new Date()); }, 1000);
    return () => { window.clearInterval(t); };
  }, []);
  return (
    <div className="top-clock">
      <span className="top-time">{now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
      <span className="top-date">{now.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short", year: "numeric" })}</span>
    </div>
  );
}

function TopBar({ computer }: { computer: string | null }) {
  const connection = useJarvis((s) => s.connection);
  const status = useJarvis((s) => s.status);
  const reconnectIn = useJarvis((s) => s.reconnectIn);
  const busy = useJarvis((s) => s.busy);
  const submit = useJarvis((s) => s.submitCommand);
  const emergency = useJarvis((s) => s.emergencyStop);
  const clearEmergency = useJarvis((s) => s.clearEmergency);
  const isOwner = useJarvis((s) => s.creds?.role) === "owner";
  const [stop, stopState] = useAction(emergency);
  const [clear, clearState] = useAction(clearEmergency);
  const [setMode, modeState] = useAction(async (mode: string) => {
    await api.setMode(mode);
    await useJarvis.getState().refreshStatus();
    await useJarvis.getState().refreshSettings();
  });
  const [ask, setAsk] = useState("");

  const state = connection === "online" ? (status?.emergency ? "emergency" : status?.state ?? "online") : connection;
  const label =
    connection === "connecting" ? "Connecting…"
      : connection === "offline" ? (reconnectIn !== null ? `Offline · retry in ${String(reconnectIn)}s` : "Offline")
        : status?.emergency ? "Emergency stopped"
          : status?.paused ? "Paused"
            : status?.state === "busy" ? "Busy"
              : "Connected";

  return (
    <header className="top">
      <div className="top-title">
        <h1>Command Center</h1>
        <span>{computer ?? "this computer"}</span>
      </div>
      <form
        className="top-search"
        onSubmit={(e) => {
          e.preventDefault();
          const text = ask.trim();
          if (!text || busy || connection !== "online") return;
          setAsk("");
          void submit(text);
        }}
      >
        <label htmlFor="top-ask" className="sr-only">Ask JARVIS</label>
        <input id="top-ask" value={ask} onChange={(e) => { setAsk(e.target.value); }} placeholder="Ask JARVIS…" disabled={connection !== "online" || busy} autoComplete="off" />
      </form>
      <Clock />
      <div className="top-status">
        <span className="pill" data-state={state} role="status" aria-live="polite">
          <span className="dot" aria-hidden="true" />
          {label}
        </span>
        {connection === "offline" && (
          <button type="button" className="btn btn-ghost" onClick={reconnectNow}>Retry now</button>
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
        <p className="header-error" role="alert">{stopState.error ?? clearState.error ?? modeState.error}</p>
      )}
    </header>
  );
}

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

/** Poll a read-only endpoint while the agent is online; errors are shown, not swallowed. */
function usePolled<T>(load: () => Promise<T>, everyMs: number): { data: T | null; error: string | null } {
  const connection = useJarvis((s) => s.connection);
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (connection !== "online") return;
    let stop = false;
    const tick = async () => {
      try {
        const d = await load();
        if (stop) return;
        setData(d);
        setError(null);
      } catch (err) {
        if (!stop) setError(describeError(err));
      }
    };
    void tick();
    const t = window.setInterval(() => { void tick(); }, everyMs);
    return () => { stop = true; window.clearInterval(t); };
    // load is a stable module-level call; only the connection should retrigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, everyMs]);
  return { data, error };
}

const QUICK: { label: string; command?: string; panel?: Exclude<Panel, null> }[] = [
  { label: "מה השעה", command: "מה השעה" },
  { label: "מצב המחשב", command: "מצב המחשב" },
  { label: "הפתקים שלי", command: "הפתקים שלי" },
  { label: "אנשי קשר", command: "אנשי קשר" },
  { label: "צלם מסך", command: "צלם מסך" },
  { label: "פתח פנקס רשימות", command: "פתח פנקס רשימות" },
  { label: "Build a project", panel: "projects" },
  { label: "Draft a message", panel: "drafts" },
];

function when(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : d.toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

const EVENT_LABEL: Record<string, string> = {
  plan_created: "Planned",
  plan_approved: "Approved",
  plan_rejected: "Rejected",
  action_completed: "Done",
  action_failed: "Failed",
  action_denied: "Denied",
  job_completed: "Job finished",
  job_failed: "Job failed",
  emergency_stop: "EMERGENCY STOP",
  emergency_cleared: "Stop cleared",
  pair_code_created: "Pair code",
  device_paired: "Device paired",
  device_revoked: "Device revoked",
  voice_wake: "Woke",
  voice_command: "Heard",
};

export function Dashboard() {
  const status = useJarvis((s) => s.status);
  const voice = useJarvis((s) => s.voice);
  const connection = useJarvis((s) => s.connection);
  const orb = useJarvis((s) => s.orb);
  const statusText = useJarvis((s) => s.statusText);
  const log = useJarvis((s) => s.log);
  const job = useJarvis((s) => s.activeJob);
  const pending = useJarvis((s) => s.pendingPlans);
  const approvalOpen = useJarvis((s) => s.approvalOpen);
  const openApproval = useJarvis((s) => s.openApproval);
  const reconnectIn = useJarvis((s) => s.reconnectIn);
  const alerts = useJarvis((s) => s.alerts);
  const submit = useJarvis((s) => s.submitCommand);
  const setPanel = useJarvis((s) => s.setPanel);
  const busy = useJarvis((s) => s.busy);
  const heard = useJarvis((s) => s.voice?.last_heard ?? null);
  const stats = useJarvis((s) => s.voice?.stats ?? null);

  const ai = usePolled<AiStatus>(() => api.aiDetect(false), 60000);
  const sys = usePolled<SystemStatus>(() => api.systemStatus(), 30000);
  const mem = usePolled<MemorySummary>(() => api.memorySummary(), 20000);
  const audit = usePolled<AuditEntry[]>(async () => (await api.audit(12, 2)).entries, 20000);
  const tools = usePolled<number>(async () => (await api.tools()).tools.length, 120000);

  const lastMessage = [...log].reverse().find((e) => e.kind === "assistant" || e.kind === "error" || e.kind === "warn");
  const subtext =
    connection === "offline"
      ? `The JARVIS agent is not reachable. It cannot control the computer while it is off, asleep, disconnected or stopped.${reconnectIn !== null ? ` Retrying in ${String(reconnectIn)}s.` : ""}`
      : connection === "connecting"
        ? "Contacting the agent on this computer…"
        : status?.emergency
          ? `Emergency stop is active (${status.emergency_source ?? "unknown source"}). Nothing will run until it is cleared on the computer.`
          : pending.length
            ? `${String(pending.length)} plan(s) waiting for your approval.`
            : lastMessage?.text;

  const openAlerts = alerts.filter((a) => a.status === "open" || a.status === "acknowledged");
  const running = job && (job.status === "running" || job.status === "queued");
  const engine = voice?.engine;
  const s = sys.data;
  const memUsed = s ? Math.round(((s.memory_total_gb - s.memory_free_gb) / Math.max(0.1, s.memory_total_gb)) * 100) : null;
  const disk = s?.disks[0] ?? null;
  const diskUsed = disk && disk.total_gb > 0 ? Math.round(((disk.total_gb - disk.free_gb) / disk.total_gb) * 100) : null;

  const a = ai.data;
  const cli = a?.detected.cli;
  const brainLine = !a ? (ai.error ?? "checking…") : a.mock_mode ? "MOCK MODE — rule planner only, no model" : `${a.active.model ?? "?"} · ${a.active.provider === "cli" ? "run as a program" : a.active.provider}`;

  // The workers JARVIS really has. Each card is one part of the agent with a
  // live state; there is no agent here that is not one of these.
  const agents: { name: string; role: string; state: string; tone: "ok" | "warn" | "off" }[] = [
    { name: "Planner", role: "turns what you say into a plan", state: brainLine, tone: !a ? "off" : a.mock_mode ? "warn" : "ok" },
    { name: "Voice", role: engine?.model ? `speech engine · ${engine.model}` : "speech engine", state: voice ? `${voice.state}${engine?.speed?.server?.running ? " · model in memory" : ""}` : "—", tone: engine?.available ? "ok" : "warn" },
    { name: "Executor", role: "runs the approved actions", state: running ? `running · ${String(job.completed)}/${String(job.total)}${job.current ? ` · ${job.current.description}` : ""}` : pending.length ? `${String(pending.length)} plan(s) awaiting approval` : "idle", tone: running ? "ok" : pending.length ? "warn" : "off" },
    { name: "Alert watcher", role: "watches customer records locally", state: status ? (status.alerts.enabled ? (openAlerts.length ? `${String(openAlerts.length)} open` : "watching · none open") : "off") : "—", tone: openAlerts.length ? "warn" : status?.alerts.enabled ? "ok" : "off" },
  ];

  return (
    <div className="dash">
      <Sidebar />
      <TopBar computer={s?.computer ?? null} />
      <main className="dash-main" aria-label="Command Center">
        <section className="dash-col dash-left">
          <div className="cc-panel dash-feed">
            <h3>Live Intelligence Feed</h3>
            <ActivityLog />
          </div>
          <div className="cc-panel" id="dash-agents">
            <h3>Active Agents</h3>
            <ul className="agent-cards">
              {agents.map((ag) => (
                <li key={ag.name} className="agent-card" data-state={ag.tone}>
                  <span className="cc-dot" aria-hidden="true" />
                  <strong>{ag.name}</strong>
                  <span className="agent-role">{ag.role}</span>
                  <span className="agent-state">{ag.state}</span>
                </li>
              ))}
            </ul>
            {running && (
              <button type="button" className="btn btn-ghost" onClick={() => { void api.cancelJob(job.job_id).catch(() => { /* the job may already have ended */ }); }}>Cancel the running job</button>
            )}
          </div>
        </section>

        <section className="dash-col dash-center">
          <div className="core">
            <JarvisOrb state={orb} statusText={statusText} {...(subtext ? { subtext } : {})} />
            <p className="core-label">JARVIS AI CORE</p>
            {pending.length > 0 && !approvalOpen && (
              <button type="button" className="btn btn-primary" onClick={() => { openApproval(pending[0]?.plan_id ?? null); }}>
                Review {pending.length} pending approval{pending.length === 1 ? "" : "s"}
              </button>
            )}
          </div>
          <div className="cc-panel" id="dash-timeline">
            <h3>Mission Timeline</h3>
            {mem.error ? <p className="help">{mem.error}</p> : null}
            {mem.data && mem.data.reminders.count > 0 ? (
              <ol className="timeline">
                {mem.data.reminders.next.map((r) => (
                  <li key={r.id} className="timeline-item" data-kind="reminder">
                    <time dateTime={r.at}>{when(r.at)}</time>
                    <span>{r.text}</span>
                  </li>
                ))}
              </ol>
            ) : mem.data ? (
              <p className="help">No reminders set. Say “תזכיר לי בעוד 10 דקות …” to add one.</p>
            ) : null}
            {audit.error ? <p className="help">{audit.error}</p> : null}
            {audit.data && audit.data.length > 0 && (
              <ol className="timeline timeline-past">
                {audit.data.slice(0, 8).map((e, i) => (
                  <li key={`${e.time}-${String(i)}`} className="timeline-item" data-kind={/fail|denied|emergency/.test(e.event) ? "warn" : "done"}>
                    <time dateTime={e.time}>{when(e.time)}</time>
                    <span>{EVENT_LABEL[e.event] ?? e.event.replace(/_/g, " ")}{e.tool ? ` · ${e.tool}` : ""}</span>
                  </li>
                ))}
              </ol>
            )}
            {audit.data && audit.data.length === 0 && <p className="help">Nothing has happened yet today.</p>}
          </div>
        </section>

        <section className="dash-col dash-right">
          <div className="cc-panel">
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
          </div>
          <div className="cc-panel">
            <h3>System Monitor</h3>
            {sys.error ? (
              <p className="help">{sys.error}</p>
            ) : (
              <div className="cc-rings">
                <Ring value={memUsed} label="RAM" detail={s ? `${String(Math.round((s.memory_total_gb - s.memory_free_gb) * 10) / 10)} / ${String(s.memory_total_gb)} GB` : "reading…"} />
                <Ring value={diskUsed} label={disk ? `Disk ${disk.drive}` : "Disk"} detail={disk ? `${String(disk.free_gb)} GB free` : s ? "no disk reported" : "reading…"} />
                <Ring value={s?.battery ? s.battery.percent : null} label="Battery" detail={s ? (s.battery ? (s.battery.charging ? "charging" : "on battery") : "no battery") : "reading…"} />
              </div>
            )}
            <p className="cc-foot">
              {s ? `${s.computer} · up ${String(s.uptime_hours)} h` : "—"}
              {status ? ` · ${String(status.devices.connected)} device(s) connected` : ""}
              {tools.data !== null ? ` · ${String(tools.data)} tools` : ""}
            </p>
          </div>
          <div className="cc-panel" id="dash-memory">
            <h3>Memory Insights</h3>
            {mem.error ? <p className="help">{mem.error}</p> : null}
            {mem.data && (
              <>
                <ul className="cc-rows">
                  <li data-state={mem.data.notes.count ? "ok" : "off"}><span className="cc-dot" aria-hidden="true" /><span className="cc-k">Notes</span><span className="cc-v">{String(mem.data.notes.count)} saved with “זכור …”</span></li>
                  <li data-state={mem.data.reminders.count ? "ok" : "off"}><span className="cc-dot" aria-hidden="true" /><span className="cc-k">Reminders</span><span className="cc-v">{String(mem.data.reminders.count)} pending</span></li>
                  <li data-state="ok"><span className="cc-dot" aria-hidden="true" /><span className="cc-k">Last heard</span><span className="cc-v">{heard ? `“${heard.text}”${heard.took_ms ? ` · ${String(Math.round(heard.took_ms / 100) / 10)}s` : ""}` : "nothing yet"}</span></li>
                  <li data-state="ok"><span className="cc-dot" aria-hidden="true" /><span className="cc-k">This session</span><span className="cc-v">{stats ? `${String(stats.wakes)} wakes · ${String(stats.commands)} commands · ${String(stats.stops)} stops` : "—"}</span></li>
                </ul>
                {mem.data.notes.recent.length > 0 && (
                  <ul className="notes">
                    {mem.data.notes.recent.slice(0, 5).map((n) => (
                      <li key={n.id}><time dateTime={n.at}>{when(n.at)}</time> {n.text}</li>
                    ))}
                  </ul>
                )}
                <p className="cc-foot">Knowledge base: unavailable — JARVIS has no document index yet; it knows only these notes and what it is told.</p>
              </>
            )}
          </div>
          <div className="cc-panel">
            <h3>LLM Status</h3>
            {ai.error ? <p className="help">{ai.error}</p> : null}
            {a && (
              <ul className="cc-rows">
                <li data-state={a.mock_mode ? "warn" : "ok"}><span className="cc-dot" aria-hidden="true" /><span className="cc-k">Answering</span><span className="cc-v">{brainLine}</span></li>
                <li data-state={cli?.available ? "ok" : "off"}><span className="cc-dot" aria-hidden="true" /><span className="cc-k">Ollama program</span><span className="cc-v">{cli?.available ? `${String(cli.models.length)} model(s): ${cli.models.join(", ")}` : `not available — ${cli?.error ?? "unknown"}`}</span></li>
                <li data-state={a.detected.ollama.available ? "ok" : "off"}><span className="cc-dot" aria-hidden="true" /><span className="cc-k">Ollama server</span><span className="cc-v">{a.detected.ollama.available ? `${String(a.detected.ollama.models.length)} model(s)` : "not answering (not needed when the program is found)"}</span></li>
                <li data-state="ok"><span className="cc-dot" aria-hidden="true" /><span className="cc-k">Cloud</span><span className="cc-v">{status ? `none · ${String(status.cost_network.external_calls)} external calls · ${String(status.cost_network.api_keys_configured)} API keys` : "none"}</span></li>
              </ul>
            )}
            {a && a.mock_mode && <p className="cc-foot">{a.active.reason}</p>}
          </div>
        </section>
      </main>
      <div className="talk">
        <p className="talk-label">TALK TO JARVIS</p>
        <VoiceBar />
      </div>
    </div>
  );
}
