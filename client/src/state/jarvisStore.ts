import { create } from "zustand";

import { agentApi, api } from "../api";
import { AgentError, describeError, loadCreds, loadRelay, saveCreds, saveRelay, type RelayConfig } from "../lib/protocol";
import type { AgentEvent, DeviceCreds, DeviceInfo, HealthResponse, Job, Plan, Settings, Status } from "../types";

export type OrbState = "idle" | "listening" | "thinking" | "speaking" | "busy" | "approval" | "success" | "error" | "offline" | "emergency";
export type Connection = "connecting" | "online" | "offline" | "unpaired" | "unauthorized";

// Reads `#code=...&relay=...&room=...` from a scanned pairing QR.
function readPairingFragment(): { code?: string; relay?: RelayConfig } | null {
  try {
    const hash = window.location.hash.replace(/^#/, "");
    if (!hash) return null;
    const q = new URLSearchParams(hash);
    const code = q.get("code") ?? undefined;
    const url = q.get("relay");
    const room = q.get("room");
    const out: { code?: string; relay?: RelayConfig } = {};
    if (code && /^\d{6,10}$/.test(code)) out.code = code;
    if (url && room && /^[a-f0-9]{32}$/.test(room) && /^https:\/\//.test(url)) out.relay = { url, room };
    // Clear the fragment either way: a pairing code must not survive in history.
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    return out.code || out.relay ? out : null;
  } catch {
    return null;
  }
}

function defaultDeviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone|iPad/.test(ua)) return "iPhone";
  if (/Android/.test(ua)) return "Android phone";
  return "Browser";
}
export type Panel = null | "status" | "devices" | "tools" | "audit" | "projects" | "drafts" | "settings";
export type LogKind = "user" | "assistant" | "action" | "system" | "error" | "warn";

export interface LogEntry {
  id: string;
  kind: LogKind;
  text: string;
  at: number;
  detail?: string;
}

interface DesktopBridge {
  isDesktop: boolean;
  getOwnerDevice: () => Promise<DeviceCreds>;
  getAgentInfo: () => Promise<{ port: number; platform: string; version: string }>;
  openPath: (p: string) => Promise<{ ok: boolean; reason: string | null }>;
}

export function desktopBridge(): DesktopBridge | null {
  const w = window as unknown as { jarvisDesktop?: DesktopBridge };
  return w.jarvisDesktop ?? null;
}

interface JarvisState {
  connection: Connection;
  lastSeen: number | null;
  reconnectIn: number | null;
  creds: DeviceCreds | null;
  // Set when this browser reaches the computer through the relay rather than
  // over the local network. Null means local-only.
  relay: RelayConfig | null;
  health: HealthResponse | null;
  status: Status | null;
  settings: Settings | null;
  devices: DeviceInfo[];
  orb: OrbState;
  statusText: string;
  log: LogEntry[];
  pendingPlans: Plan[];
  lastPlan: Plan | null;
  activeJob: Job | null;
  panel: Panel;
  busy: boolean;
  approvalOpen: string | null;

  addLog: (kind: LogKind, text: string, detail?: string) => void;
  clearLog: () => void;
  setPanel: (p: Panel) => void;
  setOrb: (orb: OrbState, text?: string) => void;
  flash: (orb: "success" | "error", text: string, ms?: number) => void;
  bootstrap: () => Promise<void>;
  setRelay: (relay: RelayConfig | null) => void;
  pair: (code: string, name: string) => Promise<void>;
  unpair: () => Promise<void>;
  refreshStatus: () => Promise<void>;
  refreshSettings: () => Promise<void>;
  submitCommand: (command: string) => Promise<void>;
  runPlan: (plan: Plan) => Promise<void>;
  decidePlan: (plan: Plan, decision: "approve" | "reject", scope: "once" | "task") => Promise<void>;
  cancelCurrent: () => Promise<void>;
  emergencyStop: () => Promise<void>;
  clearEmergency: () => Promise<void>;
  openApproval: (planId: string | null) => void;
}

const STATUS: Record<OrbState, string> = {
  idle: "READY",
  listening: "LISTENING",
  thinking: "THINKING",
  speaking: "SPEAKING",
  busy: "BUSY",
  approval: "APPROVAL REQUIRED",
  success: "SUCCESS",
  error: "ERROR",
  offline: "OFFLINE",
  emergency: "EMERGENCY STOPPED",
};

let idCounter = 0;
const nextId = () => `${String(Date.now())}-${String(++idCounter)}`;
let flashTimer: number | undefined;
let inflight: AbortController | null = null;
let events: EventSource | null = null;
let backoff = 1000;
let reconnectTimer: number | undefined;
let countdownTimer: number | undefined;

export const useJarvis = create<JarvisState>((set, get) => ({
  connection: "connecting",
  lastSeen: null,
  reconnectIn: null,
  creds: null,
  relay: null,
  health: null,
  status: null,
  settings: null,
  devices: [],
  orb: "idle",
  statusText: "CONNECTING",
  log: [],
  pendingPlans: [],
  lastPlan: null,
  activeJob: null,
  panel: null,
  busy: false,
  approvalOpen: null,

  addLog: (kind, text, detail) => {
    set((s) => ({ log: [...s.log.slice(-299), { id: nextId(), kind, text, at: Date.now(), ...(detail ? { detail } : {}) }] }));
  },
  clearLog: () => {
    set({ log: [] });
  },
  setPanel: (panel) => {
    set({ panel });
  },
  setOrb: (orb, text) => {
    window.clearTimeout(flashTimer);
    set({ orb, statusText: text ?? STATUS[orb] });
  },
  flash: (orb, text, ms = 1800) => {
    window.clearTimeout(flashTimer);
    set({ orb, statusText: text });
    flashTimer = window.setTimeout(() => {
      if (get().orb === orb) deriveOrb();
    }, ms);
  },
  openApproval: (planId) => {
    set({ approvalOpen: planId });
  },

  bootstrap: async () => {
    // A pairing QR opens this page with everything the phone needs in the URL
    // fragment, which never leaves the browser. Consume it, then scrub it from
    // the address bar so the one-time code is not left in history.
    const scanned = readPairingFragment();
    if (scanned?.relay) {
      saveRelay(scanned.relay);
      agentApi.relay = scanned.relay;
    } else {
      agentApi.relay = loadRelay();
    }

    let creds = loadCreds();
    const bridge = desktopBridge();
    if (bridge) {
      try {
        creds = await bridge.getOwnerDevice();
        saveCreds(creds);
      } catch {
        /* fall back to stored creds */
      }
    }
    agentApi.creds = creds;
    set({ creds, relay: agentApi.relay });

    // Scanned a code while not yet paired: finish the pairing without making
    // the user retype anything.
    if (!creds && scanned?.code) {
      try {
        await get().pair(scanned.code, defaultDeviceName());
        return;
      } catch (e) {
        get().addLog("error", describeError(e));
      }
    }
    await connectLoop();
  },

  setRelay: (relay) => {
    saveRelay(relay);
    agentApi.relay = relay;
    set({ relay });
  },

  pair: async (code, name) => {
    const creds = await agentApi.pair(code.replace(/\D/g, ""), name);
    saveCreds(creds);
    agentApi.creds = creds;
    set({ creds, connection: "connecting" });
    get().addLog("system", `Paired as "${creds.name}".`);
    await connectLoop();
  },

  unpair: async () => {
    const creds = get().creds;
    if (creds) {
      try {
        await api.revokeDevice(creds.id);
      } catch {
        /* may already be revoked or offline */
      }
    }
    stopEvents();
    saveCreds(null);
    saveRelay(null);
    agentApi.creds = null;
    agentApi.relay = null;
    set({ creds: null, relay: null, connection: "unpaired", status: null, pendingPlans: [], activeJob: null });
    deriveOrb();
  },

  refreshStatus: async () => {
    const s = await api.status();
    set({ status: s, lastSeen: Date.now(), connection: "online" });
    deriveOrb();
  },

  refreshSettings: async () => {
    const r = await api.settings();
    set({ settings: r.settings });
  },

  submitCommand: async (command) => {
    const { addLog, setOrb, flash } = get();
    const text = command.trim();
    if (!text || get().busy) return;
    if (get().connection !== "online") {
      addLog("error", describeError(new AgentError(0, "network", "offline")));
      flash("error", "OFFLINE", 2000);
      return;
    }
    inflight?.abort();
    inflight = new AbortController();
    set({ busy: true });
    addLog("user", text);
    setOrb("thinking");
    try {
      const { plan } = await api.command(text, inflight.signal);
      set({ lastPlan: plan, lastSeen: Date.now() });
      const provider = plan.mock ? "rule planner · MOCK MODE" : `${plan.provider}${plan.model ? " · " + plan.model : ""}`;
      addLog("assistant", plan.message, plan.notes.length ? plan.notes.join("\n") : undefined);
      // Notices like "no local model installed" are true every time; say them once.
      for (const note of plan.notes) {
        if (!get().log.some((l) => l.kind === "warn" && l.text === note)) addLog("warn", note);
      }
      if (plan.suggest === "drafts" || plan.suggest === "projects") set({ panel: plan.suggest });
      if (plan.denied === "emergency_stopped") {
        set({ busy: false });
        deriveOrb();
        return;
      }
      if (plan.actions.length === 0) {
        set({ busy: false });
        setOrb("speaking", `SPEAKING · ${provider.toUpperCase()}`);
        window.setTimeout(() => {
          if (get().orb === "speaking") deriveOrb();
        }, Math.min(4000, 800 + plan.message.length * 25));
        return;
      }
      if (plan.requires_approval) {
        set({ busy: false, pendingPlans: upsert(get().pendingPlans, plan), approvalOpen: plan.plan_id });
        deriveOrb();
        return;
      }
      await get().runPlan(plan);
    } catch (err) {
      set({ busy: false });
      if (err instanceof AgentError && err.kind === "cancelled") {
        addLog("system", "Cancelled.");
        deriveOrb();
        return;
      }
      if (err instanceof AgentError && (err.kind === "offline" || err.kind === "timeout")) set({ connection: "offline" });
      if (err instanceof AgentError && err.kind === "auth") set({ connection: "unauthorized" });
      addLog("error", describeError(err));
      flash("error", "ERROR", 2200);
    }
  },

  runPlan: async (plan) => {
    const { addLog, flash } = get();
    set({ busy: true });
    try {
      const { job } = await api.executePlan(plan.plan_id);
      await followJob(job);
    } catch (err) {
      addLog("error", describeError(err));
      flash("error", "ERROR", 2200);
    } finally {
      set({ busy: false });
    }
  },

  decidePlan: async (plan, decision, scope) => {
    const { addLog, flash } = get();
    set({ approvalOpen: null, pendingPlans: get().pendingPlans.filter((p) => p.plan_id !== plan.plan_id) });
    deriveOrb();
    if (decision === "reject") {
      try {
        await api.approvePlan(plan.plan_id, plan.actions_hash, "reject", "once");
        addLog("system", "Plan rejected. Nothing ran.");
      } catch (err) {
        addLog("error", describeError(err));
      }
      return;
    }
    set({ busy: true });
    try {
      if (plan.actions.some((a) => a.second_confirmation && a.decision === "ask") && get().creds?.role !== "owner") addLog("system", "High-risk plan: waiting for a second confirmation on the computer itself…");
      const res = await api.approvePlan(plan.plan_id, plan.actions_hash, "approve", scope);
      if (res.job) await followJob(res.job);
      else addLog("system", "Approved.");
    } catch (err) {
      addLog("error", describeError(err));
      flash("error", err instanceof AgentError && err.kind === "denied" ? "DENIED" : "ERROR", 2200);
    } finally {
      set({ busy: false });
    }
  },

  cancelCurrent: async () => {
    inflight?.abort();
    const job = get().activeJob;
    if (job && (job.status === "running" || job.status === "queued")) {
      try {
        const r = await api.cancelJob(job.job_id);
        set({ activeJob: r.job });
      } catch {
        /* finished already */
      }
    }
  },

  emergencyStop: async () => {
    const { addLog } = get();
    inflight?.abort();
    try {
      const r = await api.emergencyStop();
      addLog("warn", `EMERGENCY STOP: ${String(r.stopped.cancelled_jobs)} job(s) cancelled, ${String(r.stopped.killed_processes)} process(es) killed.`);
    } catch (err) {
      addLog("error", describeError(err));
    }
    await get().refreshStatus().catch(() => undefined);
  },

  clearEmergency: async () => {
    const s = await api.emergencyClear();
    set({ status: s });
    get().addLog("system", "Emergency stop cleared.");
    deriveOrb();
  },
}));

function upsert(list: Plan[], plan: Plan): Plan[] {
  const others = list.filter((p) => p.plan_id !== plan.plan_id);
  if (plan.status === "pending" || plan.status === "awaiting_local") return [...others, plan];
  return others;
}

export function deriveOrb(): void {
  const s = useJarvis.getState();
  let orb: OrbState = "idle";
  if (s.connection === "offline" || s.connection === "connecting") orb = "offline";
  else if (s.connection === "unpaired" || s.connection === "unauthorized") orb = "offline";
  else if (s.status?.emergency) orb = "emergency";
  else if (s.pendingPlans.length) orb = "approval";
  else if (s.activeJob && (s.activeJob.status === "running" || s.activeJob.status === "queued")) orb = "busy";
  else if (s.status?.state === "busy") orb = "busy";
  else if (s.status?.state === "paused") orb = "idle";
  const text = orb === "idle" && s.status?.paused ? "PAUSED" : orb === "offline" && s.connection === "connecting" ? "CONNECTING" : orb === "offline" && s.connection === "unpaired" ? "NOT PAIRED" : orb === "offline" && s.connection === "unauthorized" ? "NOT AUTHORIZED" : STATUS[orb];
  useJarvis.setState({ orb, statusText: text });
}

async function followJob(initial: Job): Promise<void> {
  const { addLog, flash, setOrb } = useJarvis.getState();
  let job = initial;
  useJarvis.setState({ activeJob: job });
  setOrb("busy", `BUSY · ${job.current?.description ?? "executing"}`.toUpperCase().slice(0, 60));
  while (job.status === "queued" || job.status === "running") {
    await new Promise<void>((r) => window.setTimeout(r, 300));
    const latest = useJarvis.getState().activeJob;
    if (latest && latest.job_id === job.job_id && latest !== job) job = latest;
    if (job.status === "queued" || job.status === "running") {
      try {
        job = (await api.job(job.job_id)).job;
        useJarvis.setState({ activeJob: job });
      } catch (err) {
        if (err instanceof AgentError && err.kind === "offline") {
          useJarvis.setState({ connection: "offline" });
          addLog("error", "Lost the agent while a job was running. It may still be running on the computer; check the activity log when it is back.");
          deriveOrb();
          return;
        }
      }
    }
    if (job.current) useJarvis.setState({ statusText: `BUSY · ${job.current.description}`.toUpperCase().slice(0, 60) });
  }
  for (const r of job.results) {
    const data = r.data;
    const detail = typeof data.content === "string" ? data.content : Array.isArray(data.matches) ? (data.matches as string[]).join("\n") : typeof data.output === "string" ? data.output : Array.isArray(data.entries) ? (data.entries as { name: string; type: string }[]).map((e) => `${e.type === "dir" ? "📁" : "📄"} ${e.name}`).join("\n") : Array.isArray(data.windows) ? (data.windows as { title: string; name: string }[]).map((w) => `${w.name}: ${w.title}`).join("\n") : Array.isArray(data.notes) ? (data.notes as { text: string }[]).map((n) => `• ${n.text}`).join("\n") : undefined;
    const kind: LogKind = r.status === "completed" ? "action" : r.status === "denied" ? "warn" : "error";
    addLog(kind, `${r.status === "completed" ? "" : r.status.toUpperCase() + ": "}${r.summary}`, detail);
  }
  useJarvis.setState({ activeJob: job });
  const label = { completed: "SUCCESS", partial: "PARTIAL", failed: "FAILED", cancelled: "CANCELLED", denied: "DENIED", expired: "EXPIRED", offline: "OFFLINE", queued: "QUEUED", running: "RUNNING" }[job.status];
  if (job.status === "completed") flash("success", label);
  else if (job.status === "cancelled") {
    addLog("system", `Stopped after ${String(job.completed)} of ${String(job.total)} action(s).`);
    deriveOrb();
  } else flash("error", label, 2400);
}

// --- connection: health polling with exponential backoff + SSE -----------------
async function connectLoop(): Promise<void> {
  window.clearTimeout(reconnectTimer);
  window.clearInterval(countdownTimer);
  const st = useJarvis.getState();
  if (!st.creds) {
    useJarvis.setState({ connection: "unpaired", reconnectIn: null });
    deriveOrb();
    return;
  }
  try {
    const health = await agentApi.health();
    useJarvis.setState({ health, lastSeen: Date.now() });
    const status = await api.status();
    useJarvis.setState({ status, connection: "online", reconnectIn: null });
    backoff = 1000;
    deriveOrb();
    try {
      const r = await api.settings();
      useJarvis.setState({ settings: r.settings });
    } catch {
      /* remote devices cannot read settings? they can; ignore transient */
    }
    try {
      const p = await api.pendingPlans();
      useJarvis.setState({ pendingPlans: p.plans });
      deriveOrb();
    } catch {
      /* ignore */
    }
    if (!useJarvis.getState().log.some((l) => l.kind === "system" && l.text.startsWith("Connected"))) {
      useJarvis.getState().addLog("system", `Connected to JARVIS ${status.version} on this ${status.host === "desktop" ? "computer's desktop agent" : "headless agent"} · mode ${status.mode.toUpperCase()}${status.offline_mode ? " · OFFLINE MODE" : ""}.`);
    }
    await openEvents();
  } catch (err) {
    stopEvents();
    if (err instanceof AgentError && err.kind === "auth") {
      useJarvis.setState({ connection: "unauthorized", reconnectIn: null });
      useJarvis.getState().addLog("error", describeError(err));
      deriveOrb();
      return;
    }
    useJarvis.setState({ connection: "offline" });
    deriveOrb();
    scheduleReconnect();
  }
}

function scheduleReconnect(): void {
  const wait = Math.min(backoff, 30000);
  backoff = Math.min(backoff * 2, 30000);
  const until = Date.now() + wait;
  useJarvis.setState({ reconnectIn: Math.ceil(wait / 1000) });
  window.clearInterval(countdownTimer);
  countdownTimer = window.setInterval(() => {
    useJarvis.setState({ reconnectIn: Math.max(0, Math.ceil((until - Date.now()) / 1000)) });
  }, 500);
  reconnectTimer = window.setTimeout(() => {
    window.clearInterval(countdownTimer);
    void connectLoop();
  }, wait);
}

export function reconnectNow(): void {
  backoff = 1000;
  void connectLoop();
}

function stopEvents(): void {
  events?.close();
  events = null;
}

async function openEvents(): Promise<void> {
  stopEvents();
  const { token } = await api.eventsToken();
  const es = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
  events = es;
  const handle = (e: MessageEvent<string>) => {
    useJarvis.setState({ lastSeen: Date.now() });
    let ev: AgentEvent;
    try {
      ev = JSON.parse(e.data) as AgentEvent;
    } catch {
      return;
    }
    onEvent(ev);
  };
  for (const type of ["status", "plan", "job", "reminder", "devices", "project", "progress"]) es.addEventListener(type, handle as EventListener);
  es.addEventListener("ping", () => {
    useJarvis.setState({ lastSeen: Date.now() });
  });
  es.onerror = () => {
    if (events !== es) return;
    stopEvents();
    useJarvis.setState({ connection: "offline" });
    deriveOrb();
    scheduleReconnect();
  };
}

function onEvent(ev: AgentEvent): void {
  const s = useJarvis.getState();
  switch (ev.type) {
    case "status": {
      const wasEmergency = s.status?.emergency;
      useJarvis.setState({ status: ev.status, connection: "online" });
      if (ev.status.emergency && !wasEmergency) s.addLog("warn", `EMERGENCY STOP active (source: ${ev.status.emergency_source ?? "unknown"}). No actions will run until it is cleared on the computer.`);
      deriveOrb();
      break;
    }
    case "plan": {
      const mine = ev.plan.device_id === s.creds?.id;
      const pending = upsert(s.pendingPlans, ev.plan);
      useJarvis.setState({ pendingPlans: pending });
      if ((ev.plan.status === "pending" || ev.plan.status === "awaiting_local") && ev.plan.requires_approval && !mine && !s.pendingPlans.some((p) => p.plan_id === ev.plan.plan_id)) {
        s.addLog("warn", `Approval requested by "${ev.plan.device_name ?? "another device"}": ${ev.plan.command}`);
      }
      if (ev.plan.status === "awaiting_local" && s.creds?.role === "owner") s.addLog("warn", "A remote device approved a high-risk plan. Confirm it in the dialog on this computer.");
      deriveOrb();
      break;
    }
    case "job":
      if (s.activeJob?.job_id === ev.job.job_id || !s.activeJob || s.activeJob.status !== "running") useJarvis.setState({ activeJob: ev.job });
      break;
    case "reminder":
      s.addLog("warn", `⏰ Reminder: ${ev.reminder.text}`);
      break;
    case "devices":
      useJarvis.setState({ devices: ev.devices });
      break;
    case "project":
    case "progress":
      window.dispatchEvent(new CustomEvent("jarvis-event", { detail: ev }));
      break;
  }
}

export function describePlanAction(a: Plan["actions"][number]): string {
  return a.description;
}
