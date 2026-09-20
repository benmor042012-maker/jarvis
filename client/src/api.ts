import { AgentApi } from "./lib/protocol";
import { AgentError } from "./lib/protocol";
import type { AiStatus, AppInfo, AuditEntry, CallRequest, Customer, CustomerAlert, DeviceInfo, Draft, DraftTemplate, Job, PairCode, PhoneCapabilities, Plan, PolicyValue, ProjectInfo, ProjectTask, ProjectTemplate, Settings, SettingsUpdate, SpeechEngineInstall, Status, ToolInfo, UtteranceResult, VoiceHistoryEntry, VoiceStatus, SystemStatus, MemorySummary } from "./types";

export const agentApi = new AgentApi("");

type Ok<T> = { ok: true; request_id: string } & T;

export const api = {
  status: () => agentApi.call<Ok<Status>>("status"),
  command: (command: string, signal?: AbortSignal, requestId?: string) =>
    agentApi.call<Ok<{ plan: Plan }>>("command", { command, ...(requestId ? { request_id: requestId } : {}) }, { timeoutMs: 180000, ...(signal ? { signal } : {}) }),
  pendingPlans: () => agentApi.call<Ok<{ plans: Plan[] }>>("plans/pending"),
  approvePlan: (plan_id: string, actions_hash: string, decision: "approve" | "reject", scope: "once" | "task") =>
    agentApi.call<Ok<{ plan: Plan; job?: Job }>>("plans/approve", { plan_id, actions_hash, decision, scope }, { timeoutMs: 180000 }),
  executePlan: (plan_id: string) => agentApi.call<Ok<{ job: Job }>>("plans/execute", { plan_id }),
  job: (job_id: string) => agentApi.call<Ok<{ job: Job }>>("jobs/get", { job_id }),
  cancelJob: (job_id: string) => agentApi.call<Ok<{ job: Job }>>("jobs/cancel", { job_id }),
  emergencyStop: () => agentApi.call<Ok<{ stopped: { cancelled_jobs: number; killed_processes: number } }>>("emergency-stop"),
  emergencyClear: () => agentApi.call<Ok<Status>>("emergency-clear"),
  pause: (paused: boolean) => agentApi.call<Ok<Status>>("pause", { paused }),
  setMode: (mode: string) => agentApi.call<Ok<Status>>("mode", { mode }),
  settings: () => agentApi.call<Ok<{ settings: Settings }>>("settings/get"),
  updateSettings: (settings: SettingsUpdate) => agentApi.call<Ok<{ settings: Settings }>>("settings/update", { settings }),
  tools: () => agentApi.call<Ok<{ tools: ToolInfo[] }>>("tools/list"),
  setToolPolicy: (tool: string, policy: PolicyValue | "default") => agentApi.call<Ok<{ tools: ToolInfo[] }>>("tools/policy", { tool, policy }),
  apps: () => agentApi.call<Ok<{ apps: AppInfo[] }>>("apps/list"),
  systemStatus: () => agentApi.call<Ok<SystemStatus>>("system/status", {}, { timeoutMs: 25000 }),
  memorySummary: () => agentApi.call<Ok<MemorySummary>>("memory/summary"),
  aiDetect: (force = false) => agentApi.call<Ok<AiStatus>>("ai/detect", { force }, { timeoutMs: 20000 }),
  devices: () => agentApi.call<Ok<{ devices: DeviceInfo[] }>>("devices/list"),
  pairCode: () => agentApi.call<Ok<PairCode>>("devices/pair-code"),
  revokeDevice: (device_id: string) => agentApi.call<Ok<{ devices: DeviceInfo[] }>>("devices/revoke", { device_id }),
  renameDevice: (device_id: string, name: string) => agentApi.call<Ok<{ devices: DeviceInfo[] }>>("devices/rename", { device_id, name }),
  audit: (limit = 200, days = 7) => agentApi.call<Ok<{ entries: AuditEntry[] }>>("audit/read", { limit, days }),
  exportData: () => agentApi.call<Ok<Record<string, unknown>>>("data/export", {}, { timeoutMs: 60000 }),
  deleteData: (what: Record<string, boolean>) => agentApi.call<Ok<{ deleted: Record<string, unknown> }>>("data/delete", what),
  eventsToken: () => agentApi.call<Ok<{ token: string }>>("events/token"),
  previewToken: () => agentApi.call<Ok<{ token: string }>>("preview/token"),
  draftTemplates: (language: string) => agentApi.call<Ok<{ templates: DraftTemplate[]; label: string }>>("drafts/templates", { language }),
  createDraft: (params: Record<string, unknown>) => agentApi.call<Ok<{ draft: Draft }>>("drafts/create", params, { timeoutMs: 180000 }),
  drafts: () => agentApi.call<Ok<{ drafts: Draft[]; optout: string[] }>>("drafts/list"),
  updateDraft: (id: string, patch: { text?: string; reviewed?: boolean; timing?: string }) => agentApi.call<Ok<{ draft: Draft }>>("drafts/update", { id, ...patch }),
  deleteDraft: (id: string) => agentApi.call<Ok<{ deleted: boolean }>>("drafts/delete", { id }),
  exportDraft: (id: string) => agentApi.call<Ok<{ path: string }>>("drafts/export", { id }),
  optOut: (recipient: string, remove = false) => agentApi.call<Ok<{ optout: string[] }>>("drafts/optout", { recipient, remove }),
  projectTemplates: () => agentApi.call<Ok<{ templates: ProjectTemplate[] }>>("projects/templates"),
  projects: () => agentApi.call<Ok<{ projects: ProjectInfo[] }>>("projects/list"),
  planProject: (params: Record<string, unknown>) => agentApi.call<Ok<{ task: ProjectTask }>>("projects/plan", params, { timeoutMs: 60000 }),
  project: (task_id: string) => agentApi.call<Ok<{ task: ProjectTask }>>("projects/get", { task_id }),
  runProject: (task_id: string, hash: string) => agentApi.call<Ok<{ task: ProjectTask }>>("projects/run", { task_id, hash }),
  cancelProject: (task_id: string) => agentApi.call<Ok<{ task: ProjectTask }>>("projects/cancel", { task_id }),

  // --- voice ---------------------------------------------------------------
  voiceStatus: (force = false) => agentApi.call<Ok<VoiceStatus>>("voice/status", { force }, { timeoutMs: 20000 }),
  voiceMicrophone: (granted: boolean) => agentApi.call<Ok<VoiceStatus>>("voice/microphone", { granted }),
  /** The page's own wake-word detector heard the phrase. Nothing was transcribed. */
  voiceWake: (durationMs: number, distance: number) =>
    agentApi.call<{ action: string; reason?: string; detail?: string; status: VoiceStatus }>("voice/wake", { ms: Math.round(durationMs), distance }),
  voicePause: (paused: boolean) => agentApi.call<Ok<VoiceStatus>>("voice/pause", { paused }),
  voiceMute: (muted: boolean) => agentApi.call<Ok<VoiceStatus>>("voice/mute", { muted }),
  voiceDoneSpeaking: () => agentApi.call<Ok<VoiceStatus>>("voice/done-speaking"),
  voiceHistory: (limit = 50) => agentApi.call<Ok<{ history: VoiceHistoryEntry[] }>>("voice/history", { limit }),
  voiceUploadToken: () => agentApi.call<Ok<{ token: string }>>("voice/upload-token"),
  /**
   * The recording itself cannot travel inside the signed JSON envelope, so it
   * is posted raw to a short-lived, single-purpose token endpoint. The audio
   * never leaves this computer: the agent transcribes it locally and deletes
   * the temporary file unless "keep audio" was explicitly turned on.
   */
  uploadUtterance: async (wav: Blob, durationMs: number, signal?: AbortSignal): Promise<UtteranceResult> => {
    const { token } = await api.voiceUploadToken();
    const res = await fetch(`/api/voice/utterance?token=${encodeURIComponent(token)}&ms=${String(Math.round(durationMs))}`, {
      method: "POST",
      headers: { "content-type": "audio/wav" },
      body: wav,
      cache: "no-store",
      ...(signal ? { signal } : {}),
    });
    const body = (await res.json().catch(() => ({}))) as UtteranceResult & { error?: string; detail?: string; install?: SpeechEngineInstall | null };
    if (!res.ok) {
      const err = new AgentError(res.status, body.error ?? "voice_error", body.detail ?? "The recording could not be transcribed.");
      (err as AgentError & { install?: SpeechEngineInstall | null }).install = body.install ?? null;
      throw err;
    }
    return body;
  },

  // --- customer alerts -----------------------------------------------------
  alerts: (all = false) => agentApi.call<Ok<{ alerts: CustomerAlert[]; label: string }>>("alerts/list", { all }),
  alertHistory: (limit = 100) => agentApi.call<Ok<{ alerts: CustomerAlert[] }>>("alerts/history", { limit }),
  scanAlerts: () => agentApi.call<Ok<{ raised: CustomerAlert[]; scanned: number; at: number }>>("alerts/scan", {}, { timeoutMs: 60000 }),
  acknowledgeAlert: (id: string) => agentApi.call<Ok<{ alert: CustomerAlert }>>("alerts/acknowledge", { id }),
  snoozeAlert: (id: string, minutes: number) => agentApi.call<Ok<{ alert: CustomerAlert }>>("alerts/snooze", { id, minutes }),
  resolveAlert: (id: string) => agentApi.call<Ok<{ alert: CustomerAlert }>>("alerts/resolve", { id }),
  retryAlert: (id: string) => agentApi.call<Ok<{ alert: CustomerAlert }>>("alerts/retry", { id }),
  raiseAlert: (customer_id: string, headline?: string) => agentApi.call<Ok<{ alert: CustomerAlert }>>("alerts/raise", { customer_id, ...(headline ? { headline } : {}) }),
  customers: () => agentApi.call<Ok<{ customers: Customer[] }>>("customers/list"),
  saveCustomer: (customer: Partial<Customer>) => agentApi.call<Ok<{ customer: Customer }>>("customers/save", { customer }),
  deleteCustomer: (id: string) => agentApi.call<Ok<{ deleted: boolean }>>("customers/delete", { id }),

  // --- phone ---------------------------------------------------------------
  phoneCapabilities: () => agentApi.call<Ok<PhoneCapabilities>>("phone/capabilities"),
  requestCall: (params: { to: string; reason: string; customer_id?: string | null; simulate?: boolean }) => agentApi.call<Ok<{ call: CallRequest }>>("phone/request", { ...params }),
  decideCall: (id: string, decision: "approve" | "reject", hash: string) => agentApi.call<Ok<{ call: CallRequest }>>("phone/decide", { id, decision, hash }),
  dialerOpened: (id: string) => agentApi.call<Ok<{ call: CallRequest }>>("phone/dialer-opened", { id }),
  callOutcome: (id: string, outcome: string, note?: string) => agentApi.call<Ok<{ call: CallRequest }>>("phone/outcome", { id, outcome, ...(note ? { note } : {}) }),
  stopCall: (id: string) => agentApi.call<Ok<{ call: CallRequest }>>("phone/stop", { id }),
  callNote: (id: string, text: string, speaker: "me" | "them") => agentApi.call<Ok<{ call: CallRequest }>>("phone/note", { id, text, speaker }),
  callDraft: (id: string, text: string) => agentApi.call<Ok<{ call: CallRequest }>>("phone/draft", { id, text }),
  calls: () => agentApi.call<Ok<{ calls: CallRequest[] }>>("phone/list"),
};
