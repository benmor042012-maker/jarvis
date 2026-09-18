// Mirrors desktop/src/core (executor, agent, server). Keep in sync.

export type Risk = "low" | "medium" | "high";
export type Mode = "safe" | "assistant" | "advanced";
export type AgentState = "connected" | "listening" | "busy" | "paused" | "emergency_stopped" | "offline";
export type Decision = "allow" | "ask" | "deny";
export type PolicyValue = "allowed" | "ask_every_time" | "allowed_for_task" | "blocked";

export interface DeviceCreds {
  id: string;
  secret: string;
  name: string;
  role: "owner" | "remote";
}

export interface HealthResponse {
  ok: boolean;
  app: string;
  version: string;
  protocol: number;
  state: AgentState;
  mode: Mode;
  lan: boolean;
  offline_mode: boolean;
  requires_pairing: boolean;
  time: number;
}

export interface PlanAction {
  index: number;
  tool: string;
  title: string;
  description: string;
  params: Record<string, unknown>;
  params_redacted: unknown;
  risk: Risk;
  reversible: boolean;
  timeout_ms: number;
  available: boolean;
  unavailable_reason: string | null;
  decision: Decision;
  reason: string;
  second_confirmation: boolean;
  task_approvable: boolean;
}

export type PlanStatus = "pending" | "approved" | "rejected" | "executing" | "done" | "expired" | "awaiting_local";

export interface Plan {
  plan_id: string;
  created_at: number;
  expires_at: number;
  command: string;
  message: string;
  provider: string;
  model: string | null;
  mock: boolean;
  notes: string[];
  suggest: string | null;
  unknown: boolean;
  actions: PlanAction[];
  actions_hash: string;
  highest_risk: Risk;
  requires_approval: boolean;
  denied: string | null;
  status: PlanStatus;
  device_id: string | null;
  device_name: string | null;
  job_id: string | null;
}

export type ResultStatus = "completed" | "failed" | "denied" | "cancelled" | "timeout";

export interface JobResult {
  index: number;
  tool: string;
  status: ResultStatus;
  ok: boolean;
  summary: string;
  data: Record<string, unknown>;
  ms?: number;
}

export type JobStatus = "queued" | "running" | "completed" | "partial" | "failed" | "cancelled" | "denied" | "expired" | "offline";

export interface Job {
  job_id: string;
  plan_id: string;
  status: JobStatus;
  results: JobResult[];
  total: number;
  completed: number;
  current: { tool: string; description: string; risk: Risk } | null;
  started_at: number;
  finished_at: number | null;
  error?: string;
}

export interface HotkeyInfo {
  requested: string;
  active: string | null;
  error: string | null;
}

export interface Status {
  version: string;
  state: AgentState;
  emergency: boolean;
  emergency_source: string | null;
  paused: boolean;
  busy: boolean;
  mode: Mode;
  offline_mode: boolean;
  lan: { enabled: boolean; port: number; addresses: { iface: string; address: string }[] };
  hotkey: HotkeyInfo;
  cost_network: {
    local_ai_only: boolean;
    external_calls: number;
    api_keys_configured: number;
    payment_configured: boolean;
    outgoing_messages: number;
    cloud_providers: string;
    data_leaving_computer: string;
  };
  devices: { connected: number; paired: number };
  voice: { state: VoiceState; enabled: boolean; microphone: boolean; paused: boolean; muted: boolean };
  alerts: { open: number; enabled: boolean };
  phone: { enabled: boolean; can_answer_calls: boolean; open_calls: number };
  pending_plans: number;
  platform: string;
  host: "desktop" | "headless";
  uptime_ms: number;
  time: number;
}

export interface Settings {
  version: number;
  mode: Mode;
  language: "he" | "en";
  autoStart: boolean;
  hotkeys: { emergencyStop: string };
  server: { port: number; lanEnabled: boolean };
  offlineMode: boolean;
  ai: { provider: "auto" | "ollama" | "localai" | "mock"; ollamaUrl: string; localaiUrl: string; model: string; timeoutMs: number };
  approvedFolders: string[];
  extraApps: { id: string; title?: string; path: string }[];
  allowedUrlHosts: string[];
  toolPolicies: Record<string, PolicyValue>;
  tts: { enabled: boolean; lang: string };
  voice: {
    enabled: boolean;
    language: string;
    wakePhrases: string[];
    stopPhrases: string[];
    quietHours: { enabled: boolean; start: string; end: string };
    maxListenMs: number;
    keepAudio: boolean;
    whisperPath: string;
    whisperModel: string;
    voskModel: string;
    transcribeTimeoutMs: number;
    speakReplies: boolean;
  };
  alerts: {
    enabled: boolean;
    scanIntervalMs: number;
    channels: { notification: boolean; sound: boolean; speech: boolean; phone: boolean };
    speakDetails: boolean;
    quietHours: { enabled: boolean; start: string; end: string };
  };
  phone: { enabled: boolean; simulation: boolean; allowDialer: boolean };
  drafts: { senderName: string; businessName: string };
  deviceExpiryDays: number;
  privacy: { keepAuditDays: number };
  hotkeyActive?: HotkeyInfo;
}

export type SettingsUpdate = Partial<Omit<Settings, "version" | "hotkeyActive">>;

export interface ToolInfo {
  name: string;
  title: string;
  description: string;
  category: string;
  risk: Risk;
  reversible: boolean;
  timeout_ms: number;
  schema: unknown;
  availability: { ok: boolean; reason?: string };
  policy: PolicyValue | null;
}

export interface DeviceInfo {
  id: string;
  name: string;
  role: "owner" | "remote";
  user: string;
  created_at: number;
  expires_at: number | null;
  last_seen: number | null;
  last_ip: string;
  revoked: boolean;
  online: boolean;
}

export interface PairCode {
  code: string;
  expires_at: number;
  urls: string[];
}

export interface AuditEntry {
  time: string;
  event: string;
  tool: string | null;
  risk: string | null;
  device: string | null;
  request_id: string | null;
  plan_id: string | null;
  status: string | null;
  params: unknown;
  detail: unknown;
}

export interface AiProvider {
  url: string;
  available: boolean;
  models: string[];
  error: string | null;
}

export interface AiStatus {
  detected: { ollama: AiProvider; localai: AiProvider };
  active: { provider: "ollama" | "localai" | "mock"; model: string | null; reason: string };
  mock_mode: boolean;
  capability_warning: string;
  settings: Settings["ai"];
}

export interface AppInfo {
  id: string;
  title: string;
  builtin: boolean;
  available: boolean;
  path?: string;
}

export interface DraftWarning {
  code: "opted_out" | "duplicate" | "rate_limit";
  text: string;
}

export interface Draft {
  id: string;
  created_at: number;
  recipient: string;
  purpose: string;
  language: string;
  text: string;
  timing: string;
  attachments: string[];
  style: string;
  model: string | null;
  warnings: DraftWarning[];
  notes: string[];
  reviewed: boolean;
  exported_path: string | null;
  label: string;
  device: string | null;
}

export interface DraftTemplate {
  id: string;
  title: string;
}

export interface ProjectTemplate {
  id: string;
  title: { he: string; en: string };
  description: string;
  needs_network_install: boolean;
}

export interface ProjectCommand {
  step: string;
  argv: string[];
  needs_network: boolean;
  offline_blocked?: boolean;
}

export interface ProjectProgress {
  at: number;
  text: string;
  step?: string;
  code?: number;
}

export interface ProjectScan {
  secrets: { file: string; type: string }[];
  dependencies: { name: string; version: string; license: string | null }[];
  dangerous: string[];
  unknown_license: string[];
}

export type ProjectStatus = "planned" | "running" | "cancelling" | "completed" | "failed" | "cancelled" | "expired";

export interface ProjectTask {
  task_id: string;
  created_at: number;
  expires_at: number;
  status: ProjectStatus;
  name: string;
  template: string;
  description: string;
  workspace: string;
  existing: boolean;
  prompt: string;
  model: string | null;
  mock: boolean;
  model_note: string;
  files: { path: string; bytes: number }[];
  commands: ProjectCommand[];
  git: string;
  tools: string[];
  permissions: string[];
  expected_changes: string;
  publish: string;
  progress: ProjectProgress[];
  changed_files: string[];
  scan: ProjectScan | null;
  checkpoints: { label: string; commit: string }[];
  hash: string;
  preview?: { file: string; url: string } | null;
  error?: string;
  finished_at?: number;
}

export interface ProjectInfo {
  name: string;
  template: string;
  created_at: number | null;
  path: string;
}

export interface Reminder {
  id: string;
  text: string;
  at: string;
  fired: boolean;
}

export type AgentEvent =
  | { type: "status"; at: number; status: Status; reason?: string }
  | { type: "plan"; at: number; plan: Plan }
  | { type: "job"; at: number; job: Job }
  | { type: "progress"; at: number; job_id: string; [k: string]: unknown }
  | { type: "reminder"; at: number; reminder: Reminder }
  | { type: "devices"; at: number; devices: DeviceInfo[] }
  | { type: "project"; at: number; task_id: string; status: ProjectStatus; entry?: ProjectProgress; done?: boolean }
  | { type: "voice_state"; at: number; state: VoiceState; reason: string | null }
  | { type: "voice"; at: number; event: "woke" | "stopped" | "command"; phrase?: string; text?: string; until?: number; plan_id?: string | null }
  | { type: "alert"; at: number; alert: CustomerAlert }
  | { type: "call"; at: number; call: CallRequest };

// Remote access through the relay. `configured` means an address and a room id
// exist; `connected` means the computer is actually reaching the relay right now.
export interface RelayStatus {
  enabled: boolean;
  configured: boolean;
  running: boolean;
  connected: boolean;
  url: string | null;
  last_poll: number | null;
  last_error: string | null;
}

export interface RelayPairLink {
  relay_url: string;
  room: string;
  code: string;
  expires_at: number;
  protocol: number;
}

// --- voice -----------------------------------------------------------------

export type VoiceState = "unavailable" | "permission_required" | "off" | "standby" | "listening" | "thinking" | "speaking" | "paused" | "muted" | "quiet_hours";

export interface SpeechEngineInstall {
  what: string;
  windows: string[];
  other: string[];
  note?: string;
}

export interface VoiceStatus {
  state: VoiceState;
  enabled: boolean;
  engine: {
    available: boolean;
    name: string | null;
    model: string | null;
    hebrew: boolean;
    reason: string | null;
    install: SpeechEngineInstall | null;
    checked: { whisperBinaries: string[]; whisperModels: string[]; vosk: unknown };
  };
  microphone: { granted: boolean; required: boolean };
  wakePhrases: string[];
  stopPhrases: string[];
  quietHours: { enabled?: boolean; start?: string; end?: string; active: boolean };
  maxListenMs: number;
  keepAudio: boolean;
  paused: boolean;
  muted: boolean;
  listening_until: number | null;
  last_heard: { text: string; at: number; engine: string; source: string } | null;
  last_error: { message: string; code: string | null; install: SpeechEngineInstall | null; at: number } | null;
  stats: { wakes: number; falseWakes: number; commands: number; stops: number; utterances: number };
}

export interface VoiceHistoryEntry {
  at: number;
  kind: "stop" | "ignored" | "false_wake" | "quiet_hours" | "wake" | "empty" | "command";
  text?: string;
  phrase?: string;
  why?: string;
}

export interface UtteranceResult {
  ok: boolean;
  action: "ignored" | "woke" | "stopped" | "command";
  reason?: string;
  detail?: string;
  text?: string;
  phrase?: string;
  listening_until?: number;
  model_used?: boolean;
  /** How long the speech engine took on this utterance, in milliseconds. */
  took_ms?: number | null;
  plan?: Plan;
  job?: Job | null;
}

// --- customers and alerts ---------------------------------------------------

export interface CustomerSignal {
  code: string;
  weight: number;
  why: string;
  hours?: number;
}

export interface Customer {
  id: string;
  name: string;
  contact: string;
  phone: string;
  subject: string;
  note: string;
  lastMessage: string;
  priority: "normal" | "high";
  deadline: string;
  waitingSince: string;
  answered: boolean;
  created_at: number;
  updated_at: number;
  score: number;
  urgent: boolean;
  signals: CustomerSignal[];
}

export type AlertStatus = "open" | "acknowledged" | "snoozed" | "resolved";

export interface CustomerAlert {
  id: string;
  created_at: number;
  customer_id: string;
  customer_name: string;
  headline: string;
  score: number;
  signals: CustomerSignal[];
  status: AlertStatus;
  acknowledged_at: number | null;
  snooze_until: number;
  attempts: number;
  last_attempt_at: number | null;
  delivered: { window: boolean; notification: boolean; sound: boolean; speech: boolean; phone: number };
  quiet_hours: boolean;
  label: string;
}

// --- phone ------------------------------------------------------------------

export interface PhoneCapability {
  available: boolean;
  why: string;
  one_time_step: string | null;
  requires?: string;
  blocked_because?: string;
}

export type PhoneCapabilityKey = "place_call_from_computer" | "open_dialer_on_phone" | "auto_dial_without_pressing" | "answer_incoming_call" | "answer_from_computer_over_bluetooth" | "record_call_audio";

export interface PhoneCapabilities {
  capabilities: Record<PhoneCapabilityKey, PhoneCapability>;
  phones: { id: string; name: string; online: boolean; last_seen: number | null }[];
  simulation_enabled: boolean;
  answering_enabled: boolean;
  summary: string;
}

export type CallStatus = "pending_approval" | "approved" | "simulated" | "dialer_opened" | "closed" | "rejected" | "stopped" | "expired";

export interface CallRequest {
  id: string;
  created_at: number;
  expires_at: number;
  number: string;
  number_masked: string;
  reason: string;
  customer_id: string | null;
  simulation: boolean;
  simulation_because: string | null;
  status: CallStatus;
  approved_by: string | null;
  approved_at: number | null;
  dialer_opened_at: number | null;
  dialer_device: string | null;
  outcome: string | null;
  outcome_note: string;
  transcript: { at: number; speaker: "me" | "them"; text: string }[];
  draft: string;
  requested_by: string;
  hash: string;
}
