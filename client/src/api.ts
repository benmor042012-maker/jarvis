import { AgentApi } from "./lib/protocol";
import type { AiStatus, AppInfo, AuditEntry, DeviceInfo, Draft, DraftTemplate, Job, PairCode, Plan, PolicyValue, ProjectInfo, ProjectTask, ProjectTemplate, RelayPairLink, RelayStatus, Settings, SettingsUpdate, Status, ToolInfo } from "./types";

export const agentApi = new AgentApi("");

type Ok<T> = { ok: true; request_id: string } & T;

export const api = {
  status: () => agentApi.call<Ok<Status>>("status"),
  command: (command: string, signal?: AbortSignal) => agentApi.call<Ok<{ plan: Plan }>>("command", { command }, { timeoutMs: 180000, ...(signal ? { signal } : {}) }),
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
  aiDetect: (force = false) => agentApi.call<Ok<AiStatus>>("ai/detect", { force }, { timeoutMs: 20000 }),
  devices: () => agentApi.call<Ok<{ devices: DeviceInfo[] }>>("devices/list"),
  pairCode: () => agentApi.call<Ok<PairCode>>("devices/pair-code"),
  revokeDevice: (device_id: string) => agentApi.call<Ok<{ devices: DeviceInfo[] }>>("devices/revoke", { device_id }),
  renameDevice: (device_id: string, name: string) => agentApi.call<Ok<{ devices: DeviceInfo[] }>>("devices/rename", { device_id, name }),
  relayStatus: () => agentApi.call<Ok<{ relay: RelayStatus }>>("relay/status"),
  configureRelay: (params: { url?: string; enabled?: boolean; rotate_room?: boolean }) =>
    agentApi.call<Ok<{ relay: RelayStatus; status: Status }>>("relay/configure", params, { timeoutMs: 20000 }),
  relayPairLink: () => agentApi.call<Ok<RelayPairLink>>("relay/pair-link"),
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
};
