import { create } from "zustand";

import { agentApi, api } from "../api";
import { MicCapture, micSupport } from "../lib/mic";
import { enroll, loadWakeModel, saveWakeModel, WakeDetector, type WakeModel } from "../lib/wake";
import { AgentError, describeError, loadCreds, saveCreds } from "../lib/protocol";
import { alertSound, sleepSound, stopSound, unlockAudio, wakeSound } from "../lib/sound";
import { speak, stopSpeaking, warmVoices } from "../lib/speech";
import type { AgentEvent, CallRequest, CustomerAlert, DeviceCreds, DeviceInfo, HealthResponse, Job, PhoneCapabilities, Plan, Settings, SpeechEngineInstall, Status, UtteranceResult, VoiceState, VoiceStatus } from "../types";

export type OrbState = "idle" | "listening" | "thinking" | "speaking" | "busy" | "approval" | "success" | "error" | "offline" | "emergency";
export type Connection = "connecting" | "online" | "offline" | "unpaired" | "unauthorized";
export type Panel = null | "status" | "devices" | "tools" | "audit" | "projects" | "drafts" | "settings" | "voice" | "alerts" | "phone";
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
  /** The desktop agent asks the window to play the alert sound. */
  onAlertSound?: (cb: () => void) => () => void;
  /** The desktop agent asks the window to speak, using local Windows voices. */
  onSpeak?: (cb: (text: string) => void) => () => void;
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

  // --- voice ---------------------------------------------------------------
  voice: VoiceStatus | null;
  /** The microphone is open in this page right now. */
  listening: boolean;
  /** 0..1 input meter, so "always listening" is never invisible. */
  level: number;
  // What the last utterance came back as when it was not for JARVIS. Without
  // this, saying the wake phrase and having it misheard looks identical to a
  // dead microphone: the screen says nothing either way.
  heard: { text: string; at: number } | null;
  /**
   * An utterance is with the speech engine right now. Without this the window
   * shows nothing at all while a large model spends ten, twenty, forty seconds
   * on one sentence — and silence is exactly how a working program looks broken.
   */
  transcribing: { since: number } | null;
  /** The last engine run that was slow enough to be the reason nothing happens. */
  slow: { ms: number; model: string | null } | null;
  /** Utterances dropped because the one before was still being transcribed. */
  skipped: number;
  /**
   * The wake word this computer was taught, if it was. With one, waking takes a
   * millisecond in the page instead of a full transcription; without one,
   * everything still works exactly as before, just at the engine's speed.
   */
  wakeModel: WakeModel | null;
  /** How the enrolment is going: which recording, out of how many. */
  wakeTeaching: { step: number; of: number } | null;
  /** The microphone stayed open and delivered nothing but silence. */
  micSilent: { device: string } | null;
  /** The inputs this browser can offer, and the one JARVIS is told to use. */
  micDevices: { id: string; label: string }[];
  micDeviceId: string | null;
  micError: string | null;
  micInstall: SpeechEngineInstall | null;
  /** Why this browser/page cannot open a microphone at all, if it cannot. */
  micBlocked: { reason: string; fix: string | null } | null;
  ttsNote: string | null;
  /** The typed fallback, hidden unless it is deliberately opened. */
  keyboard: boolean;

  // --- alerts and phone ----------------------------------------------------
  alerts: CustomerAlert[];
  alertLabel: string;
  alertOpen: string | null;
  calls: CallRequest[];
  callOpen: string | null;
  phone: PhoneCapabilities | null;

  addLog: (kind: LogKind, text: string, detail?: string) => void;
  clearLog: () => void;
  setPanel: (p: Panel) => void;
  setOrb: (orb: OrbState, text?: string) => void;
  flash: (orb: "success" | "error", text: string, ms?: number) => void;
  bootstrap: () => Promise<void>;
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

  refreshVoice: (force?: boolean) => Promise<void>;
  startListening: () => Promise<void>;
  stopListening: (tellAgent?: boolean) => Promise<void>;
  setVoicePaused: (paused: boolean) => Promise<void>;
  setVoiceMuted: (muted: boolean) => Promise<void>;
  setKeyboard: (on: boolean) => void;
  setVoiceMode: (mode: "fast" | "accurate") => Promise<void>;
  teachWakeWord: () => Promise<void>;
  forgetWakeWord: () => void;
  refreshMicDevices: () => Promise<void>;
  setMicDevice: (id: string | null) => Promise<void>;
  say: (text: string) => Promise<void>;

  refreshAlerts: () => Promise<void>;
  openAlert: (id: string | null) => void;
  refreshPhone: () => Promise<void>;
  openCall: (id: string | null) => void;
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

  voice: null,
  listening: false,
  level: 0,
  heard: null,
  transcribing: null,
  slow: null,
  skipped: 0,
  wakeModel: loadWakeModel(),
  wakeTeaching: null,
  micSilent: null,
  micDevices: [],
  micDeviceId: loadMicDevice(),
  micError: null,
  micInstall: null,
  micBlocked: null,
  ttsNote: null,
  keyboard: false,

  alerts: [],
  alertLabel: "LOCAL WI-FI ALERTS — NO EXTERNAL MESSAGES",
  alertOpen: null,
  calls: [],
  callOpen: null,
  phone: null,

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
    set({ creds });
    await connectLoop();
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
    agentApi.creds = null;
    set({ creds: null, connection: "unpaired", status: null, pendingPlans: [], activeJob: null });
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

  // --- voice -----------------------------------------------------------------
  refreshVoice: async (force = false) => {
    const voice = await api.voiceStatus(force);
    set({ voice });
    applyVoiceState(voice.state);
  },

  startListening: async () => {
    const support = micSupport();
    if (!support.supported) {
      set({ micBlocked: { reason: support.reason ?? "The microphone is not available here.", fix: support.fix } });
      get().addLog("warn", support.reason ?? "The microphone is not available here.", support.fix ?? undefined);
      return;
    }
    set({ micBlocked: null, micError: null });
    unlockAudio();
    warmVoices();
    try {
      await capture().start();
    } catch (err) {
      const message = err instanceof Error ? err.message : "The microphone could not be opened.";
      set({ micError: message, listening: false });
      get().addLog("error", message);
      // The agent must not claim to be listening when the browser refused.
      try {
        if (get().creds?.role === "owner") set({ voice: await api.voiceMicrophone(false) });
      } catch {
        /* the agent will report its own state on the next poll */
      }
      return;
    }
    set({ listening: true, micSilent: null, skipped: 0 });
    void get().refreshMicDevices();
    try {
      // Only the JARVIS computer itself can grant the microphone; a paired
      // phone can speak, but it cannot switch listening on for the computer.
      if (get().creds?.role === "owner") set({ voice: await api.voiceMicrophone(true) });
      else set({ voice: await api.voiceStatus() });
    } catch (err) {
      get().addLog("error", describeError(err));
    }
    applyVoiceState(get().voice?.state ?? "standby");
  },

  stopListening: async (tellAgent = true) => {
    capture().stop();
    stopSpeaking();
    set({ listening: false, level: 0 });
    if (!tellAgent) return;
    try {
      if (get().creds?.role === "owner") set({ voice: await api.voiceMicrophone(false) });
    } catch (err) {
      get().addLog("error", describeError(err));
    }
    applyVoiceState(get().voice?.state ?? "off");
  },

  setVoicePaused: async (paused) => {
    const voice = await api.voicePause(paused);
    set({ voice });
    get().addLog("system", paused ? "Microphone paused. JARVIS is not listening." : "Microphone resumed.");
    applyVoiceState(voice.state);
  },

  setVoiceMuted: async (muted) => {
    const voice = await api.voiceMute(muted);
    set({ voice });
    if (muted) stopSpeaking();
    get().addLog("system", muted ? "Muted: JARVIS will not speak or listen." : "Unmuted.");
    applyVoiceState(voice.state);
  },

  setKeyboard: (on) => {
    set({ keyboard: on });
  },

  setVoiceMode: async (mode) => {
    // Owner-only, like every other setting: this changes how the computer
    // itself listens, and a paired phone does not get to decide that.
    try {
      // Send only what changed, on top of what the agent last reported: the
      // update takes a whole voice block, and a partial one would blank the
      // rest of it.
      const current = get().settings?.voice;
      if (!current) {
        await get().refreshSettings();
      }
      const voice = get().settings?.voice;
      if (!voice) throw new Error("The settings are not loaded yet.");
      const r = await api.updateSettings({ voice: { ...voice, mode } });
      set({ settings: r.settings });
      await get().refreshVoice(true);
      get().addLog("system", mode === "fast" ? "Fast mode: the quickest model installed, one pass. Answers in about a second." : "Accurate mode: the model you chose, full search. Slower, and it mishears less.");
    } catch (err) {
      get().addLog("error", describeError(err));
    }
  },

  teachWakeWord: async () => {
    // Three recordings: enough for the detector to know how much this person's
    // own voice varies, which is what sets its tolerance. Fewer, and the
    // tolerance would be a guess.
    const of = 3;
    const takes: Float32Array[] = [];
    const wasListening = get().listening;
    try {
      for (let step = 1; step <= of; step++) {
        set({ wakeTeaching: { step, of } });
        const sample = await nextUtterance(12000);
        takes.push(sample);
      }
      const model = enroll(takes);
      if (!model) {
        set({ wakeTeaching: null });
        get().addLog("warn", "That was not enough to go on — say the wake phrase clearly, one word at a time, and try again.");
        return;
      }
      saveWakeModel(model);
      detector = new WakeDetector(model);
      set({ wakeModel: model, wakeTeaching: null });
      get().addLog("system", "Wake word taught. JARVIS now wakes in the window itself, without transcribing anything.");
    } catch (err) {
      set({ wakeTeaching: null });
      get().addLog("error", err instanceof Error ? err.message : "The wake word could not be recorded.");
    } finally {
      if (!wasListening) capture().stop();
    }
  },

  forgetWakeWord: () => {
    saveWakeModel(null);
    detector = null;
    set({ wakeModel: null });
    get().addLog("system", "Wake word forgotten. JARVIS is back to listening for it through the speech engine.");
  },

  refreshMicDevices: async () => {
    // Labels are only revealed once the microphone has been granted, so this is
    // called after permission rather than on load.
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      const inputs = all.filter((d) => d.kind === "audioinput").map((d, i) => ({ id: d.deviceId, label: d.label || `Microphone ${String(i + 1)}` }));
      set({ micDevices: inputs });
    } catch {
      set({ micDevices: [] });
    }
  },

  setMicDevice: async (id) => {
    saveMicDevice(id);
    set({ micDeviceId: id, micSilent: null });
    capture().update({ deviceId: id });
    if (!get().listening) return;
    // Reopen on the chosen input: a running stream keeps the old device.
    capture().stop();
    set({ listening: false });
    await get().startListening();
  },

  say: async (text) => {
    const s = get();
    const speakReplies = (s.settings?.tts.enabled ?? true) && (s.settings?.voice.speakReplies ?? true);
    if (!speakReplies || s.voice?.muted) {
      await api.voiceDoneSpeaking().catch(() => undefined);
      return;
    }
    const lang = s.settings?.tts.lang ?? (s.settings?.language === "en" ? "en-US" : "he-IL");
    const res = await speak(text, lang);
    if (!res.spoken && res.reason && get().ttsNote !== res.reason) {
      set({ ttsNote: res.reason });
      get().addLog("warn", res.reason, res.fix ?? undefined);
    }
    try {
      set({ voice: await api.voiceDoneSpeaking() });
    } catch {
      /* the next status poll corrects this */
    }
  },

  // --- alerts and phone ------------------------------------------------------
  refreshAlerts: async () => {
    const r = await api.alerts();
    set({ alerts: r.alerts, alertLabel: r.label });
    const open = r.alerts.find((a) => a.status === "open");
    if (open && !get().alertOpen) set({ alertOpen: open.id });
  },

  openAlert: (id) => {
    set({ alertOpen: id });
  },

  refreshPhone: async () => {
    const [caps, list] = await Promise.all([api.phoneCapabilities(), api.calls()]);
    set({ phone: caps, calls: list.calls });
    const waiting = list.calls.find((c) => c.status === "pending_approval");
    if (waiting && !get().callOpen) set({ callOpen: waiting.id });
  },

  openCall: (id) => {
    set({ callOpen: id });
  },
}));

// Jobs already announced or timed, so a stream of updates for one job does not
// repeat itself in the log.
const announced = new Set<string>();
const timed = new Set<string>();

/**
 * Where the time went, in the words of someone waiting: heard (the speech
 * engine), thought (the planner), did (running the actions). Stages that did
 * not happen are left out rather than shown as zero.
 */
function stageTimes(job: Job): string {
  const s = useJarvis.getState();
  const secs = (ms: number) => `${String(Math.round(ms / 100) / 10)}s`;
  const parts: string[] = [];
  const heard = s.voice?.last_heard?.took_ms ?? null;
  if (heard) parts.push(`heard ${secs(heard)}`);
  const plan = s.lastPlan?.plan_ms ?? null;
  if (plan) parts.push(`thought ${secs(plan)}`);
  if (job.ms) parts.push(`did ${secs(job.ms)}`);
  return parts.length ? parts.join(" · ") : "";
}

// --- microphone ---------------------------------------------------------------
const MIC_DEVICE_KEY = "jarvis.mic.device";

function loadMicDevice(): string | null {
  try {
    return window.localStorage.getItem(MIC_DEVICE_KEY);
  } catch {
    return null;
  }
}

function saveMicDevice(id: string | null): void {
  try {
    if (id) window.localStorage.setItem(MIC_DEVICE_KEY, id);
    else window.localStorage.removeItem(MIC_DEVICE_KEY);
  } catch {
    /* a browser with storage blocked still works, it just forgets the choice */
  }
}

// Over this, and the wait itself is the problem, whatever the words were.
const SLOW_MS = 8000;
let quickRuns = 0;
let mic: MicCapture | null = null;
let detector: WakeDetector | null = null;
// While the wake word is being taught, the next utterance goes here instead of
// to the agent.
let enrolling: ((samples: Float32Array) => void) | null = null;

function wakeDetector(): WakeDetector | null {
  if (detector) return detector;
  const model = useJarvis.getState().wakeModel;
  if (model) detector = new WakeDetector(model);
  return detector;
}

/** The next thing the microphone hears, for teaching the wake word. */
async function nextUtterance(timeoutMs: number): Promise<Float32Array> {
  await useJarvis.getState().startListening();
  return await new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      enrolling = null;
      reject(new Error("Nothing was heard. Check the microphone and try again."));
    }, timeoutMs);
    enrolling = (samples) => {
      window.clearTimeout(timer);
      enrolling = null;
      resolve(samples);
    };
  });
}
let uploading = false;
let queued: { wav: Blob; ms: number } | null = null;
let levelAt = 0;

function capture(): MicCapture {
  mic ??= new MicCapture({
    maxSegmentMs: 15000,
    // How long a pause ends a sentence. Every millisecond here is a millisecond
    // of waiting after you stop talking, before anything at all begins — so it
    // is as short as it can be without cutting people off mid-thought.
    silenceMs: 550,
    minSpeechMs: 260,
    onSegment: (wav, ms, samples) => {
      if (enrolling) {
        enrolling(samples);
        return;
      }
      // The wake word, if this computer was taught one, is decided here — in
      // about a millisecond, against recordings of this person saying it. The
      // speech engine never sees it, which is the whole difference between
      // waking now and waking in ten seconds.
      const s = useJarvis.getState();
      const d = wakeDetector();
      if (d && !s.voice?.listening_until && s.voice?.state === "standby") {
        const hit = d.test(samples);
        if (hit.hit) {
          void localWake(ms, hit.distance);
          return; // nothing to transcribe: the phrase itself is not a command
        }
      }
      // One upload at a time; a newer utterance replaces a waiting one so a
      // stop phrase is never stuck behind an old recording. Losing the older
      // one is the right trade and a bad surprise, so it is counted and shown:
      // on a slow model this is why the second and third try went nowhere.
      if (queued) useJarvis.setState((st) => ({ skipped: st.skipped + 1 }));
      queued = { wav, ms };
      void drainUploads();
    },
    onLevel: (level) => {
      const now = Date.now();
      if (now - levelAt < 120) return;
      levelAt = now;
      const rounded = Math.round(level * 20) / 20;
      if (useJarvis.getState().level !== rounded) useJarvis.setState({ level: rounded });
    },
    onError: (message) => {
      useJarvis.setState({ micError: message });
    },
    onSilent: (device) => {
      useJarvis.setState({ micSilent: { device } });
      void useJarvis.getState().refreshMicDevices();
    },
    deviceId: useJarvis.getState().micDeviceId,
  });
  return mic;
}

export function micCapture(): MicCapture {
  return capture();
}

/**
 * Tell the agent the page heard the wake word. The sound is immediate and local
 * — the point of the whole thing is that nothing waits — but the agent still
 * decides: quiet hours, muted, paused and the cool-down are all its call, and
 * the window only shows LISTENING once it says so.
 */
async function localWake(ms: number, distance: number): Promise<void> {
  const s = useJarvis.getState();
  try {
    const res = await api.voiceWake(ms, distance);
    if (res.action === "woke") {
      wakeSound();
      useJarvis.setState({ voice: res.status, heard: null });
      s.setOrb("listening");
      return;
    }
    // Refused, and the reason is the agent's to give.
    useJarvis.setState({ voice: res.status });
    if (res.detail && !s.log.some((l) => l.text === res.detail)) s.addLog("system", res.detail);
  } catch (err) {
    s.addLog("error", describeError(err));
  }
}

async function drainUploads(): Promise<void> {
  if (uploading) return;
  uploading = true;
  try {
    while (queued) {
      const item = queued;
      queued = null;
      useJarvis.setState({ transcribing: { since: Date.now() } });
      try {
        const res = await api.uploadUtterance(item.wav, item.ms);
        useJarvis.setState({ transcribing: null });
        // Anything over this and the wait itself is the problem, whatever the
        // words were. The threshold is generous: a second or two is normal.
        const took = res.took_ms ?? 0;
        const model = useJarvis.getState().voice?.engine.model ?? null;
        if (took >= SLOW_MS) {
          quickRuns = 0;
          useJarvis.setState({ slow: { ms: took, model } });
        } else if (useJarvis.getState().slow) {
          // One quick run is not proof the machine keeps up — a short "mm" is
          // quick on any model. Clearing the warning the instant it happens
          // takes it off the screen exactly while it is being read.
          quickRuns += 1;
          if (quickRuns >= 3) useJarvis.setState({ slow: null });
        }
        await handleUtterance(res);
      } catch (err) {
        useJarvis.setState({ transcribing: null });
        const install = (err as AgentError & { install?: SpeechEngineInstall | null }).install ?? null;
        const s = useJarvis.getState();
        const message = err instanceof AgentError ? err.message : describeError(err);
        if (s.micError !== message) {
          useJarvis.setState({ micError: message, micInstall: install });
          s.addLog("error", message);
        }
        if (install) {
          // Nothing will ever be transcribed until the engine is installed;
          // stop recording instead of uploading audio that cannot be read.
          capture().stop();
          useJarvis.setState({ listening: false, level: 0 });
          void s.refreshVoice(true).catch(() => undefined);
          return;
        }
      }
    }
  } finally {
    uploading = false;
    useJarvis.setState({ transcribing: null });
  }
}

async function handleUtterance(res: UtteranceResult): Promise<void> {
  const s = useJarvis.getState();
  useJarvis.setState({ micError: null, micSilent: null });
  switch (res.action) {
    case "ignored":
      // Silence, background talk, a false wake or quiet hours. Never logged as
      // a transcript: only the agent keeps that, and only as text. It is still
      // shown on the voice bar for a few seconds, because "I said the wake
      // phrase and nothing happened" has to be answerable: either the words
      // came back wrong, or nothing was heard at all.
      if (res.reason === "quiet_hours" && res.detail && !s.log.some((l) => l.text === res.detail)) s.addLog("system", res.detail);
      useJarvis.setState({ heard: { text: (res.text ?? "").trim(), at: Date.now() } });
      return;
    case "stopped": {
      stopSound();
      stopSpeaking();
      capture().discard();
      s.addLog("warn", `Stopped by voice ("${res.phrase ?? ""}"). No model was used — the word alone stops everything.`);
      await s.refreshStatus().catch(() => undefined);
      return;
    }
    case "woke": {
      useJarvis.setState({ heard: null });
      wakeSound();
      s.setOrb("listening");
      return;
    }
    case "command": {
      if (res.text) s.addLog("user", res.text);
      const plan = res.plan;
      if (!plan) return;
      useJarvis.setState({ lastPlan: plan });
      s.addLog("assistant", plan.message, plan.notes.length ? plan.notes.join("\n") : undefined);
      for (const note of plan.notes) {
        if (!useJarvis.getState().log.some((l) => l.kind === "warn" && l.text === note)) s.addLog("warn", note);
      }
      if (plan.suggest === "drafts" || plan.suggest === "projects") useJarvis.setState({ panel: plan.suggest });
      if (needsApproval(plan)) {
        useJarvis.setState({ pendingPlans: upsert(useJarvis.getState().pendingPlans, plan), approvalOpen: plan.plan_id });
        deriveOrb();
        await s.say(plan.message);
        return;
      }
      s.setOrb("speaking");
      const speaking = s.say(plan.message);
      if (res.job) await followJob(res.job);
      await speaking;
      sleepSound();
      deriveOrb();
      return;
    }
  }
}

/** Mirror the agent's voice state onto the orb without fighting deriveOrb(). */
function applyVoiceState(state: VoiceState): void {
  const s = useJarvis.getState();
  if (s.status?.emergency || s.pendingPlans.length) {
    deriveOrb();
    return;
  }
  if (state === "listening") s.setOrb("listening");
  else if (state === "thinking") s.setOrb("thinking");
  else if (state === "speaking") s.setOrb("speaking");
  else deriveOrb();
}

function needsApproval(plan: Plan): boolean {
  // Every command produces a plan event, including ones with nothing to run
  // ("I didn't understand that"). Only a plan that actually has an action
  // waiting on the user is an approval — otherwise the orb would sit on
  // APPROVAL REQUIRED and the command bar would lock for no reason.
  return (plan.status === "pending" || plan.status === "awaiting_local") && plan.requires_approval && plan.actions.some((a) => a.decision === "ask");
}

function upsert(list: Plan[], plan: Plan): Plan[] {
  const others = list.filter((p) => p.plan_id !== plan.plan_id);
  return needsApproval(plan) ? [...others, plan] : others;
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
    const st = useJarvis.getState();
    await Promise.all([
      st.refreshVoice().catch(() => undefined),
      st.refreshAlerts().catch(() => undefined),
      st.refreshPhone().catch(() => undefined),
    ]);
    const support = micSupport();
    useJarvis.setState(support.supported ? { micBlocked: null } : { micBlocked: { reason: support.reason ?? "", fix: support.fix } });
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
  for (const type of ["status", "plan", "job", "reminder", "devices", "project", "progress", "voice_state", "voice", "alert", "call"]) es.addEventListener(type, handle as EventListener);
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
      if (needsApproval(ev.plan) && !mine && !s.pendingPlans.some((p) => p.plan_id === ev.plan.plan_id)) {
        s.addLog("warn", `Approval requested by "${ev.plan.device_name ?? "another device"}": ${ev.plan.command}`);
      }
      if (ev.plan.status === "awaiting_local" && s.creds?.role === "owner") s.addLog("warn", "A remote device approved a high-risk plan. Confirm it in the dialog on this computer.");
      deriveOrb();
      break;
    }
    case "job": {
      if (s.activeJob?.job_id === ev.job.job_id || !s.activeJob || s.activeJob.status !== "running") useJarvis.setState({ activeJob: ev.job });
      // Say something the moment work starts. A job with several steps can run
      // for a while, and an assistant that goes quiet the second you ask it for
      // something looks like one that did not hear you.
      if (ev.job.status === "running" && !announced.has(ev.job.job_id)) {
        announced.add(ev.job.job_id);
        if (announced.size > 50) announced.delete([...announced][0] as string);
        const steps = ev.job.total;
        s.addLog("system", steps > 1 ? `Starting — ${String(steps)} steps.` : "Starting.");
      }
      if ((ev.job.status === "completed" || ev.job.status === "failed" || ev.job.status === "cancelled") && !timed.has(ev.job.job_id)) {
        timed.add(ev.job.job_id);
        if (timed.size > 50) timed.delete([...timed][0] as string);
        const line = stageTimes(ev.job);
        if (line) s.addLog("system", line);
      }
      break;
    }
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
    case "voice_state": {
      const voice = s.voice;
      if (voice) useJarvis.setState({ voice: { ...voice, state: ev.state } });
      applyVoiceState(ev.state);
      break;
    }
    case "voice":
      // The transcript itself is logged by the utterance handler on the device
      // that spoke; other devices only learn that JARVIS woke or was stopped.
      if (ev.event === "stopped" && !s.listening) s.addLog("warn", "JARVIS was stopped by voice on another device.");
      break;
    case "alert":
      onAlert(ev.alert);
      break;
    case "call": {
      const calls = [ev.call, ...s.calls.filter((c) => c.id !== ev.call.id)].slice(0, 50);
      useJarvis.setState({ calls });
      if (ev.call.status === "pending_approval" && !s.callOpen) useJarvis.setState({ callOpen: ev.call.id });
      if (s.callOpen === ev.call.id && (ev.call.status === "rejected" || ev.call.status === "stopped" || ev.call.status === "expired" || ev.call.status === "closed")) useJarvis.setState({ callOpen: null });
      break;
    }
  }
}

function onAlert(alert: CustomerAlert): void {
  const s = useJarvis.getState();
  const alerts = [alert, ...s.alerts.filter((a) => a.id !== alert.id)];
  useJarvis.setState({ alerts, alertLabel: alert.label });
  if (alert.status !== "open") {
    if (s.alertOpen === alert.id) useJarvis.setState({ alertOpen: null });
    return;
  }
  useJarvis.setState({ alertOpen: alert.id });
  s.addLog("warn", `⚠ ${alert.customer_name} — ${alert.headline}`, alert.label);
  // On the JARVIS computer the desktop agent itself owns the notification, the
  // sound and the speech, so the page would only duplicate them. Everywhere
  // else — a paired phone, or a browser talking to a headless agent — the page
  // is the only thing that can deliver them.
  if (desktopBridge() || alert.quiet_hours) return;
  const channels = s.settings?.alerts.channels;
  if (channels?.sound !== false) alertSound();
  if (channels?.notification !== false) showNotification(alert);
  if (channels?.speech) void speakAlert(alert);
}

export function speakAlert(alert: CustomerAlert): Promise<unknown> {
  const s = useJarvis.getState();
  const he = (s.settings?.language ?? "he") === "he";
  // Names only. The reason, the note and the contact details stay on screen
  // unless "speak details" was deliberately switched on.
  const full = s.settings?.alerts.speakDetails === true;
  const text = full
    ? he ? `שים לב: ${alert.customer_name}. ${alert.headline}.` : `Attention: ${alert.customer_name}. ${alert.headline}.`
    : he ? `שים לב, לקוח דורש תשומת לב: ${alert.customer_name}.` : `Attention: a customer needs you — ${alert.customer_name}.`;
  return speak(text, s.settings?.tts.lang ?? (he ? "he-IL" : "en-US"));
}

export function showNotification(alert: CustomerAlert): void {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  try {
    // Local only: this is the browser's own notification, shown by the phone
    // or the browser that is already connected over your Wi-Fi. Nothing is
    // sent to any messaging service, and no push server is involved.
    new Notification(`JARVIS — ${alert.customer_name}`, {
      body: useJarvis.getState().settings?.alerts.speakDetails === true ? alert.headline : "A customer needs your attention. Open JARVIS to see why.",
      tag: alert.id,
      icon: "./favicon.svg",
    });
  } catch {
    /* some browsers require a service-worker registration for notifications */
  }
}

export function describePlanAction(a: Plan["actions"][number]): string {
  return a.description;
}
