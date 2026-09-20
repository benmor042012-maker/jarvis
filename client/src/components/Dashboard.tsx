// The main screen: a command centre around the core.
//
// Every figure on it is read from this computer — the agent's own status, the
// speech engine that is actually loaded, the model that is actually answering
// (or MOCK MODE, said plainly), the notes and reminders JARVIS really holds,
// processor, memory and disk from the operating system. Nothing is decorative:
// a panel with nothing true to show says so, and a feature JARVIS does not
// have is marked unavailable with the reason rather than drawn as if it worked.
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

type Section = "agents" | "timeline" | "memory" | "voice";

function scrollTo(section: Section) {
  document.getElementById(`dash-${section}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

/** The one way the microphone is opened from anywhere on this screen: the voice bar's own button, behind its permission screen. */
function openMicrophone() {
  scrollTo("voice");
  const orb = document.querySelector<HTMLButtonElement>(".mic-orb");
  if (orb && !orb.disabled && orb.getAttribute("aria-pressed") !== "true") orb.click();
}

/**
 * The left navigation. Each entry opens one of the existing panels or scrolls
 * to a section of this screen; the badges are live counts, not decoration.
 */
function Sidebar({ tools }: { tools: number | null }) {
  const panel = useJarvis((s) => s.panel);
  const setPanel = useJarvis((s) => s.setPanel);
  const openAlerts = useJarvis((s) => s.alerts.filter((a) => a.status === "open" || a.status === "acknowledged").length);
  const pending = useJarvis((s) => s.pendingPlans.length);
  const turns = useJarvis((s) => s.log.filter((l) => l.kind === "user").length);
  const status = useJarvis((s) => s.status);

  const nav: { label: string; icon: string; panel?: Exclude<Panel, null>; section?: Section; home?: boolean; badge?: number }[] = [
    { label: "Command Center", icon: "◈", home: true },
    { label: "AI Core", icon: "◉", panel: "status" },
    { label: "Agents", icon: "⬡", section: "agents" },
    { label: "Tasks", icon: "☑", panel: "projects", badge: pending },
    { label: "Calendar", icon: "▦", section: "timeline" },
    { label: "Memory", icon: "◍", section: "memory" },
    { label: "Conversations", icon: "☰", panel: "audit", badge: turns },
    { label: "Knowledge Base", icon: "▤", section: "memory" },
    { label: "Tools & Skills", icon: "⚙", panel: "tools", badge: tools ?? 0 },
    { label: "Workflows", icon: "⇶", panel: "projects" },
  ];
  const more: { label: string; icon: string; panel: Exclude<Panel, null>; badge?: number }[] = [
    { label: "Voice", icon: "🎙", panel: "voice" },
    { label: "Customer alerts", icon: "⚠", panel: "alerts", badge: openAlerts },
    { label: "Phone", icon: "☎", panel: "phone" },
    { label: "Drafts", icon: "✉", panel: "drafts" },
    { label: "Devices", icon: "⌁", panel: "devices" },
    { label: "Settings", icon: "✧", panel: "settings" },
  ];
  const item = (n: (typeof nav)[number]) => (
    <li key={n.label}>
      <button
        type="button"
        className="side-item"
        aria-pressed={n.home ? panel === null : n.panel ? panel === n.panel : false}
        aria-label={n.badge ? `${n.label} (${String(n.badge)})` : n.label}
        data-badge={n.badge ? String(n.badge) : undefined}
        onClick={() => {
          if (n.home) { setPanel(null); document.querySelector(".dash-main")?.scrollTo({ top: 0 }); }
          else if (n.panel) setPanel(panel === n.panel ? null : n.panel);
          else if (n.section) { setPanel(null); scrollTo(n.section); }
        }}
      >
        <span className="side-icon" aria-hidden="true">{n.icon}</span>
        <span className="side-label">{n.label}</span>
      </button>
    </li>
  );
  return (
    <nav className="side" aria-label="Sections">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true" />
        <span>JARVIS<small>Command Center</small></span>
      </div>
      <ul className="side-list">{nav.map(item)}</ul>
      <p className="side-group">Also</p>
      <ul className="side-list">{more.map(item)}</ul>
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
      <span className="top-date">{now.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long", year: "numeric" })}</span>
      <span className="top-time">{now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
    </div>
  );
}

function TopBar() {
  const connection = useJarvis((s) => s.connection);
  const status = useJarvis((s) => s.status);
  const reconnectIn = useJarvis((s) => s.reconnectIn);
  const busy = useJarvis((s) => s.busy);
  const submit = useJarvis((s) => s.submitCommand);
  const emergency = useJarvis((s) => s.emergencyStop);
  const clearEmergency = useJarvis((s) => s.clearEmergency);
  const creds = useJarvis((s) => s.creds);
  const isOwner = creds?.role === "owner";
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
              : "Optimal";

  return (
    <header className="top">
      <div className="top-left">
        <span className="pill pill-status" data-state={state} role="status" aria-live="polite">
          <span className="pill-k">System status</span>
          <span className="dot" aria-hidden="true" />
          {label}
        </span>
        {connection === "offline" && (
          <button type="button" className="btn btn-ghost" onClick={reconnectNow}>Retry now</button>
        )}
      </div>
      <Clock />
      <div className="top-right">
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
        <span className="operator" title={creds ? `${creds.name} · ${creds.role}` : ""}>
          <span className="operator-avatar" aria-hidden="true">{(creds?.name ?? "?").slice(0, 1).toUpperCase()}</span>
          <span className="operator-name">{creds?.role === "owner" ? "Operator" : creds?.name ?? "—"}<small>{creds?.name ?? ""}</small></span>
        </span>
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

/**
 * The memory map: one point per note, joined to its neighbours in time. The
 * count is the real one; the positions are a stable spread of it, so the
 * picture grows as JARVIS is told more and is empty when it knows nothing.
 */
function MemoryMap({ count }: { count: number }) {
  const n = Math.min(28, count);
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i < n; i++) {
    const a = i * 2.399963; // the golden angle, so points never line up
    const rr = 6 + 40 * Math.sqrt((i + 0.5) / Math.max(1, n));
    pts.push({ x: 60 + Math.cos(a) * rr * 1.1, y: 32 + Math.sin(a) * rr * 0.55 });
  }
  return (
    <svg className="mem-map" viewBox="0 0 120 64" aria-hidden="true">
      {pts.map((p, i) => i > 0 && <line key={`l${String(i)}`} x1={pts[i - 1]?.x ?? 0} y1={pts[i - 1]?.y ?? 0} x2={p.x} y2={p.y} />)}
      {pts.map((p, i) => <circle key={`c${String(i)}`} cx={p.x} cy={p.y} r={i === n - 1 ? 2.2 : 1.4} />)}
    </svg>
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
  agent_started: "Agent started",
};

type Tone = "ok" | "warn" | "off";

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
  const listening = useJarvis((s) => s.listening);
  const level = useJarvis((s) => s.level);
  const heard = useJarvis((s) => s.voice?.last_heard ?? null);
  const stats = useJarvis((s) => s.voice?.stats ?? null);

  const ai = usePolled<AiStatus>(() => api.aiDetect(false), 60000);
  const sys = usePolled<SystemStatus>(() => api.systemStatus(), 20000);
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
  const localModels = cli?.models.length ?? a?.detected.ollama.models.length ?? 0;
  const brainLine = !a ? (ai.error ?? "checking…") : a.mock_mode ? "MOCK MODE — rule planner, no model" : `${a.active.model ?? "?"} · ${a.active.provider === "cli" ? "run as a program" : a.active.provider}`;
  const voiceLine = !voice ? "—" : !engine?.available ? "offline — no speech engine" : status?.voice.microphone === false && !listening ? "ready · microphone off" : voice.state;

  // AI Core Overview: the same six rows as the reference screen, each a real figure.
  const overview: { k: string; v: string; sub: string; tone: Tone }[] = [
    { k: "AI Core", v: status ? (status.emergency ? "Stopped" : status.paused ? "Paused" : "Active") : "Offline", sub: status ? `v${status.version} · ${status.mode} mode` : "not reachable", tone: status ? (status.emergency ? "warn" : "ok") : "off" },
    { k: "Memory", v: mem.data ? `${String(mem.data.notes.count)} stored` : "—", sub: mem.data ? `${String(mem.data.reminders.count)} reminder(s) pending` : (mem.error ?? "reading…"), tone: mem.data?.notes.count ? "ok" : "off" },
    { k: "Voice", v: engine?.available ? (listening ? "Online" : "Ready") : "Offline", sub: engine?.model ? engine.model : (engine?.reason ?? "no speech engine"), tone: engine?.available ? "ok" : "warn" },
    { k: "Agents", v: running ? "1 running" : pending.length ? `${String(pending.length)} waiting` : "Idle", sub: running ? `${String(job.completed)}/${String(job.total)} steps` : pending.length ? "awaiting your approval" : "nothing queued", tone: running ? "ok" : pending.length ? "warn" : "off" },
    { k: "LLMs", v: a ? (a.mock_mode ? "None" : `${String(localModels)} local`) : "—", sub: brainLine, tone: a ? (a.mock_mode ? "warn" : "ok") : "off" },
    { k: "System", v: s ? (s.cpu_percent !== null && s.cpu_percent > 85 ? "Busy" : "Optimal") : "—", sub: s ? `${s.computer} · up ${String(s.uptime_hours)} h` : (sys.error ?? "reading…"), tone: s ? "ok" : "off" },
  ];

  // The workers JARVIS really has. Each card is one part of the agent with a
  // live state; there is no agent here that is not one of these.
  const agents: { name: string; role: string; state: string; tone: Tone; check?: boolean }[] = [
    { name: "Planner", role: "turns what you say into a plan", state: brainLine, tone: !a ? "off" : a.mock_mode ? "warn" : "ok" },
    { name: "Voice agent", role: "wake word, speech to text", state: voiceLine, tone: engine?.available ? "ok" : "warn" },
    { name: "Executor", role: "runs the approved actions", state: running ? `running · ${String(job.completed)}/${String(job.total)}${job.current ? ` · ${job.current.description}` : ""}` : pending.length ? `${String(pending.length)} plan(s) awaiting approval` : "standby", tone: running ? "ok" : pending.length ? "warn" : "off" },
    { name: "Project builder", role: "builds sites and files from a brief", state: "ready · opens from Tasks", tone: "ok" },
    { name: "Alert watcher", role: "watches customer records locally", state: status ? (status.alerts.enabled ? (openAlerts.length ? `${String(openAlerts.length)} open` : "watching · none open") : "off") : "—", tone: openAlerts.length ? "warn" : status?.alerts.enabled ? "ok" : "off" },
    { name: "System agent", role: "processor, memory, disk, battery", state: s ? `${s.cpu_percent === null ? "—" : `${String(s.cpu_percent)}%`} cpu · ${String(memUsed ?? 0)}% ram` : (sys.error ?? "reading…"), tone: s ? "ok" : "off", check: !!s && (s.cpu_percent ?? 0) < 85 },
  ];

  // The provider grid from the reference screen, with the truth in each tile.
  // The local ones report what was found; the hosted ones are named so nobody
  // wonders where they went, and each says the exact reason it is not
  // connected: it needs an account, a key and a bill, and this JARVIS runs
  // without any of those by design.
  const CLOUD_REASON = "not connected — needs an account, an API key and per-use billing; this JARVIS is local-only by design";
  const providers: { name: string; state: string; tone: Tone; hint?: string }[] = a
    ? [
        { name: "Ollama", state: cli?.available ? `Connected · ${String(cli.models.length)} model(s)` : a.detected.ollama.available ? `Connected (server) · ${String(a.detected.ollama.models.length)} model(s)` : `Not connected — ${cli?.error ?? "not installed"}`, tone: cli?.available || a.detected.ollama.available ? "ok" : "warn" },
        { name: "LocalAI", state: a.detected.localai.available ? `Connected · ${String(a.detected.localai.models.length)} model(s)` : "Not connected — not installed", tone: a.detected.localai.available ? "ok" : "off" },
        { name: "Rule planner", state: a.mock_mode ? "Answering (MOCK MODE)" : "Fallback · ready", tone: a.mock_mode ? "warn" : "ok" },
        { name: "Claude", state: "Not connected", tone: "off", hint: CLOUD_REASON },
        { name: "OpenAI", state: "Not connected", tone: "off", hint: CLOUD_REASON },
        { name: "Gemini", state: "Not connected", tone: "off", hint: CLOUD_REASON },
        { name: "Groq", state: "Not connected", tone: "off", hint: CLOUD_REASON },
        { name: "OpenRouter", state: "Not connected", tone: "off", hint: CLOUD_REASON },
        { name: "Copilot", state: "Not connected", tone: "off", hint: CLOUD_REASON },
      ]
    : [];

  const quick: { label: string; icon: string; onClick: () => void; disabled?: boolean }[] = [
    { label: "Start New Task", icon: "＋", onClick: () => { setPanel("projects"); } },
    { label: "Open Calendar", icon: "▦", onClick: () => { scrollTo("timeline"); } },
    { label: "Start Voice Chat", icon: "🎙", onClick: openMicrophone, disabled: connection !== "online" || listening },
    { label: "Run Workflow", icon: "⇶", onClick: () => { setPanel("projects"); } },
    { label: "מה השעה", icon: "◔", onClick: () => { void submit("מה השעה"); }, disabled: busy || connection !== "online" },
    { label: "מצב המחשב", icon: "▣", onClick: () => { void submit("מצב המחשב"); }, disabled: busy || connection !== "online" },
    { label: "הפתקים שלי", icon: "◍", onClick: () => { void submit("הפתקים שלי"); }, disabled: busy || connection !== "online" },
    { label: "צלם מסך", icon: "▢", onClick: () => { void submit("צלם מסך"); }, disabled: busy || connection !== "online" },
  ];

  const talkLine = status?.emergency
    ? "Emergency stop is active."
    : !engine?.available
      ? "No local speech engine — speech is unavailable on this computer."
      : listening
        ? voice?.state === "listening" ? "I am listening…" : voice?.state === "thinking" ? "Working out what you said…" : `Say “${voice?.wakePhrases[0] ?? "תתעורר"}” to wake me.`
        : "Microphone off — tap to talk.";

  return (
    <div className="dash">
      <Sidebar tools={tools.data} />
      <TopBar />
      <main className="dash-main" aria-label="Command Center">
        <section className="dash-col dash-left">
          <div className="cc-panel">
            <h3>AI Core Overview</h3>
            <ul className="overview">
              {overview.map((r) => (
                <li key={r.k} data-state={r.tone}>
                  <span className="cc-dot" aria-hidden="true" />
                  <span className="ov-k">{r.k}</span>
                  <span className="ov-v">{r.v}</span>
                  <span className="ov-sub">{r.sub}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="cc-panel dash-voice" id="dash-voice">
            <h3>Voice Status</h3>
            <VoiceBar />
          </div>
        </section>

        <section className="dash-col dash-center">
          <div className="core">
            <JarvisOrb state={orb} statusText={statusText} {...(subtext ? { subtext } : {})} />
            <p className="core-label">JARVIS AI CORE{status ? <small>v{status.version}</small> : null}</p>
            {pending.length > 0 && !approvalOpen && (
              <button type="button" className="btn btn-primary" onClick={() => { openApproval(pending[0]?.plan_id ?? null); }}>
                Review {pending.length} pending approval{pending.length === 1 ? "" : "s"}
              </button>
            )}
          </div>
          <div className="cc-panel" id="dash-agents">
            <h3>Active Agents<button type="button" className="link" onClick={() => { setPanel("status"); }}>View All ›</button></h3>
            <ul className="agent-cards">
              {agents.map((ag) => (
                <li key={ag.name} className="agent-card" data-state={ag.tone}>
                  <span className="cc-dot" aria-hidden="true" />
                  <strong>{ag.name}</strong>
                  <span className="agent-role">{ag.role}</span>
                  <span className="agent-state">{ag.state}</span>
                  {ag.check && <span className="agent-check" aria-hidden="true">✓</span>}
                </li>
              ))}
            </ul>
            {running && (
              <button type="button" className="btn btn-ghost" onClick={() => { void api.cancelJob(job.job_id).catch(() => { /* the job may already have ended */ }); }}>Cancel the running job</button>
            )}
          </div>
          <div className="dash-row">
            <div className="cc-panel">
              <h3>System Monitor</h3>
              {sys.error ? (
                <p className="help">{sys.error}</p>
              ) : (
                <div className="cc-rings">
                  <Ring value={s?.cpu_percent ?? null} label="CPU" detail={s ? `${String(s.cpu_cores)} cores` : "reading…"} />
                  <Ring value={memUsed} label="RAM" detail={s ? `${String(Math.round((s.memory_total_gb - s.memory_free_gb) * 10) / 10)} / ${String(s.memory_total_gb)} GB` : "reading…"} />
                  <Ring value={diskUsed} label={disk ? `Disk ${disk.drive}` : "Disk"} detail={disk ? `${String(disk.free_gb)} GB free` : s ? "no disk reported" : "reading…"} />
                </div>
              )}
              <p className="cc-foot">{s ? `${s.battery ? `battery ${String(s.battery.percent)}%${s.battery.charging ? " · charging" : ""} · ` : ""}${String(status?.devices.connected ?? 0)} device(s) connected` : "—"}</p>
            </div>
            <div className="cc-panel" id="dash-memory">
              <h3>Memory Insights</h3>
              {mem.error ? <p className="help">{mem.error}</p> : null}
              {mem.data && (
                <div className="mem">
                  <MemoryMap count={mem.data.notes.count} />
                  <dl className="mem-stats">
                    <div><dt>Memories</dt><dd>{String(mem.data.notes.count)}</dd></div>
                    <div><dt>Session turns</dt><dd>{String(stats?.commands ?? log.filter((l) => l.kind === "user").length)}</dd></div>
                    <div><dt>Reminders</dt><dd>{String(mem.data.reminders.count)}</dd></div>
                  </dl>
                </div>
              )}
              {mem.data && mem.data.notes.recent.length > 0 && (
                <ul className="notes">
                  {mem.data.notes.recent.slice(0, 3).map((n) => (
                    <li key={n.id}><time dateTime={n.at}>{when(n.at)}</time> {n.text}</li>
                  ))}
                </ul>
              )}
              <p className="cc-foot">{heard ? `Last heard: “${heard.text}”` : "Knowledge base: unavailable — no document index yet; JARVIS knows its notes and what it is told."}</p>
            </div>
            <div className="cc-panel">
              <h3>LLM Status<span className="h3-sub">{a ? `${String(providers.filter((p) => p.tone === "ok").length)} connected` : ""}</span></h3>
              {ai.error ? <p className="help">{ai.error}</p> : null}
              {a && (
                <>
                <ul className="providers">
                  {providers.map((p) => (
                    <li key={p.name} data-state={p.tone} title={p.hint ?? p.state}>
                      <span className="cc-dot" aria-hidden="true" />
                      <strong>{p.name}</strong>
                      <span>{p.state}</span>
                    </li>
                  ))}
                </ul>
                <button type="button" className="link link-block" onClick={() => { setPanel("settings"); }}>Manage Providers › (local: Ollama, LocalAI, model)</button>
                <p className="cc-foot">Hosted providers are listed so nothing is hidden: each needs an account, a key and billing, and this JARVIS runs without them.</p>
                </>
              )}
              {a && a.mock_mode && <p className="cc-foot">{a.active.reason}</p>}
            </div>
          </div>
        </section>

        <section className="dash-col dash-right">
          <div className="cc-panel dash-feed">
            <h3>Live Intelligence Feed<span className="live" aria-hidden="true">● LIVE</span></h3>
            <ActivityLog />
          </div>
          <div className="cc-panel" id="dash-timeline">
            <h3>Mission Timeline<span className="h3-sub">Today</span></h3>
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
                {audit.data.slice(0, 6).map((e, i) => (
                  <li key={`${e.time}-${String(i)}`} className="timeline-item" data-kind={/fail|denied|emergency/.test(e.event) ? "warn" : "done"}>
                    <time dateTime={e.time}>{when(e.time)}</time>
                    <span>{EVENT_LABEL[e.event] ?? e.event.replace(/_/g, " ")}{e.tool ? ` · ${e.tool}` : ""}</span>
                  </li>
                ))}
              </ol>
            )}
            {audit.data && audit.data.length === 0 && <p className="help">Nothing has happened yet today.</p>}
            <button type="button" className="link link-block" onClick={() => { setPanel("audit"); }}>View Full Schedule ›</button>
          </div>
          <div className="cc-panel">
            <h3>Quick Commands</h3>
            <ul className="quick">
              {quick.map((q) => (
                <li key={q.label}>
                  <button type="button" className="quick-btn" onClick={q.onClick} disabled={q.disabled}>
                    <span className="quick-icon" aria-hidden="true">{q.icon}</span>
                    {q.label}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </section>
      </main>
      <button type="button" className="talk" data-live={listening ? "on" : "off"} onClick={openMicrophone} disabled={connection !== "online" || !!status?.emergency}>
        <span className="talk-wave" aria-hidden="true">
          {Array.from({ length: 24 }, (_, i) => (
            <i key={i} style={{ height: `${String(listening ? 4 + Math.round(level * 22 * (0.4 + 0.6 * Math.abs(Math.sin(i * 1.7)))) : 3)}px` }} />
          ))}
        </span>
        <span className="talk-text">
          <strong>TALK TO JARVIS</strong>
          <span>{talkLine}</span>
        </span>
        <span className="talk-wave talk-wave-r" aria-hidden="true">
          {Array.from({ length: 24 }, (_, i) => (
            <i key={i} style={{ height: `${String(listening ? 4 + Math.round(level * 22 * (0.4 + 0.6 * Math.abs(Math.cos(i * 1.3)))) : 3)}px` }} />
          ))}
        </span>
      </button>
    </div>
  );
}
