import { create } from "zustand";

import { ApiError, api } from "../api";
import type { Action, JobView, PlanResponse, SettingsView } from "../types";

export type OrbState = "idle" | "listening" | "thinking" | "speaking" | "success" | "error";

export type LogKind = "user" | "assistant" | "action" | "system" | "error";

export interface LogEntry {
  id: string;
  kind: LogKind;
  text: string;
  at: number;
  detail?: string;
}

interface JarvisState {
  orb: OrbState;
  statusText: string;
  log: LogEntry[];
  pendingPlan: PlanResponse | null;
  job: JobView | null;
  settings: SettingsView | null;
  serverOnline: boolean | null;
  settingsOpen: boolean;
  speechEnabled: boolean;
  busy: boolean;

  // ui
  setOrb: (orb: OrbState, statusText?: string) => void;
  flash: (orb: "success" | "error", text: string, ms?: number) => void;
  addLog: (kind: LogKind, text: string, detail?: string) => void;
  clearLog: () => void;
  openSettings: (open: boolean) => void;
  setSpeechEnabled: (on: boolean) => void;

  // data
  bootstrap: () => Promise<void>;
  refreshSettings: () => Promise<void>;
  submitCommand: (command: string) => Promise<void>;
  confirmPlan: () => Promise<void>;
  rejectPlan: () => void;
  cancelCurrent: () => Promise<void>;
}

const STATUS: Record<OrbState, string> = {
  idle: "READY",
  listening: "LISTENING",
  thinking: "THINKING",
  speaking: "SPEAKING",
  success: "DONE",
  error: "ERROR",
};

let idCounter = 0;
const nextId = () => `${String(Date.now())}-${String(++idCounter)}`;

let flashTimer: number | undefined;
let inflight: AbortController | null = null;
let pollTimer: number | undefined;

function describe(action: Action): string {
  switch (action.type) {
    case "open_url":
      return `Open ${action.payload.url}`;
    case "open_app":
      return `Launch ${action.payload.app}`;
    case "search_files":
      return `Search workspace for "${action.payload.query}"`;
    case "read_text_file":
      return `Read ${action.payload.path}`;
    case "create_text_file":
      return `Create ${action.payload.path}`;
  }
}

export const describeAction = describe;

export const useJarvis = create<JarvisState>((set, get) => ({
  orb: "idle",
  statusText: STATUS.idle,
  log: [],
  pendingPlan: null,
  job: null,
  settings: null,
  serverOnline: null,
  settingsOpen: false,
  speechEnabled: false,
  busy: false,

  setOrb: (orb, statusText) => {
    window.clearTimeout(flashTimer);
    set({ orb, statusText: statusText ?? STATUS[orb] });
  },

  flash: (orb, text, ms = 1600) => {
    window.clearTimeout(flashTimer);
    set({ orb, statusText: text });
    flashTimer = window.setTimeout(() => {
      if (get().orb === orb) set({ orb: "idle", statusText: STATUS.idle });
    }, ms);
  },

  addLog: (kind, text, detail) => {
    set((s) => ({ log: [...s.log.slice(-199), { id: nextId(), kind, text, at: Date.now(), ...(detail ? { detail } : {}) }] }));
  },

  clearLog: () => {
    set({ log: [] });
  },
  openSettings: (open) => {
    set({ settingsOpen: open });
  },
  setSpeechEnabled: (on) => {
    set({ speechEnabled: on });
  },

  bootstrap: async () => {
    try {
      const [health, settings] = await Promise.all([api.health(), api.settings()]);
      set({ serverOnline: health.ok, settings });
      get().addLog("system", health.mock_mode ? "Online. Mock mode: no API key set, rule-based planner active." : `Online. Provider: ${settings.provider}, model ${settings.model}.`);
    } catch (err) {
      set({ serverOnline: false });
      get().addLog("error", err instanceof Error ? err.message : "Server unreachable.");
    }
  },

  refreshSettings: async () => {
    try {
      set({ settings: await api.settings(), serverOnline: true });
    } catch {
      set({ serverOnline: false });
    }
  },

  submitCommand: async (command) => {
    const { addLog, setOrb, flash } = get();
    const text = command.trim();
    if (!text || get().busy) return;
    inflight?.abort();
    inflight = new AbortController();
    set({ busy: true, pendingPlan: null, job: null });
    addLog("user", text);
    setOrb("thinking");
    try {
      const plan = await api.command(text, inflight.signal);
      set({ serverOnline: true });
      addLog("assistant", plan.message);
      if (plan.actions.length === 0) {
        set({ busy: false });
        setOrb("speaking");
        window.setTimeout(() => {
          if (get().orb === "speaking") setOrb("idle");
        }, Math.min(4000, 800 + plan.message.length * 25));
        return;
      }
      if (plan.requires_confirmation) {
        set({ pendingPlan: plan, busy: false });
        setOrb("idle", "AWAITING CONFIRMATION");
        return;
      }
      await runActions(plan.actions, false);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        set({ busy: false });
        setOrb("idle");
        addLog("system", "Cancelled.");
        return;
      }
      const msg = err instanceof Error ? err.message : "Something went wrong.";
      if (err instanceof ApiError && err.status === 0) set({ serverOnline: false });
      set({ busy: false });
      addLog("error", msg);
      flash("error", "ERROR", 2200);
    }
  },

  confirmPlan: async () => {
    const plan = get().pendingPlan;
    if (!plan) return;
    set({ pendingPlan: null });
    await runActions(plan.actions, true);
  },

  rejectPlan: () => {
    set({ pendingPlan: null });
    get().addLog("system", "Plan dismissed. Nothing was run.");
    get().setOrb("idle");
  },

  cancelCurrent: async () => {
    inflight?.abort();
    const job = get().job;
    if (job && (job.status === "running" || job.status === "queued")) {
      try {
        const view = await api.cancelJob(job.job_id);
        set({ job: view });
      } catch {
        /* job may already be finished */
      }
    }
  },
}));

async function runActions(actions: Action[], confirmed: boolean): Promise<void> {
  const { addLog, setOrb, flash } = useJarvis.getState();
  useJarvis.setState({ busy: true });
  setOrb("thinking", "EXECUTING");
  try {
    let job = await api.execute(actions, confirmed);
    useJarvis.setState({ job });
    while (job.status === "queued" || job.status === "running") {
      await new Promise<void>((r) => {
        pollTimer = window.setTimeout(r, 250);
      });
      job = await api.job(job.job_id);
      useJarvis.setState({ job });
    }
    for (const r of job.results) {
      const detail = typeof r.data.content === "string" ? r.data.content : Array.isArray(r.data.matches) ? (r.data.matches as string[]).join("\n") : undefined;
      addLog(r.ok ? "action" : "error", r.summary, detail);
    }
    if (job.status === "done") {
      const allOk = job.results.every((r) => r.ok);
      flash(allOk ? "success" : "error", allOk ? "DONE" : "PARTIAL");
    } else if (job.status === "cancelled") {
      addLog("system", `Stopped after ${String(job.completed)} of ${String(job.total)} action(s).`);
      setOrb("idle");
    } else {
      addLog("error", job.error ?? "Execution failed.");
      flash("error", "ERROR", 2200);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Execution failed.";
    addLog("error", msg);
    flash("error", "ERROR", 2200);
  } finally {
    window.clearTimeout(pollTimer);
    useJarvis.setState({ busy: false });
  }
}
