// Mirrors server/schemas.py. Keep in sync.

export type Risk = "low" | "medium" | "high";
export type PermissionMode = "manual" | "ask" | "auto";
export type ActionType = "open_url" | "open_app" | "search_files" | "read_text_file" | "create_text_file";

export interface OpenUrlAction {
  type: "open_url";
  payload: { url: string };
  risk: Risk;
}
export interface OpenAppAction {
  type: "open_app";
  payload: { app: string };
  risk: Risk;
}
export interface SearchFilesAction {
  type: "search_files";
  payload: { query: string; max_results?: number };
  risk: Risk;
}
export interface ReadTextFileAction {
  type: "read_text_file";
  payload: { path: string };
  risk: Risk;
}
export interface CreateTextFileAction {
  type: "create_text_file";
  payload: { path: string; content: string };
  risk: Risk;
}
export type Action = OpenUrlAction | OpenAppAction | SearchFilesAction | ReadTextFileAction | CreateTextFileAction;

export interface PlanResponse {
  message: string;
  requires_confirmation: boolean;
  actions: Action[];
  plan_id: string | null;
  provider: string | null;
}

export interface ActionResult {
  type: ActionType;
  ok: boolean;
  summary: string;
  data: Record<string, unknown>;
}

export type JobStatus = "queued" | "running" | "done" | "cancelled" | "failed";

export interface JobView {
  job_id: string;
  status: JobStatus;
  results: ActionResult[];
  error: string | null;
  total: number;
  completed: number;
}

export interface SettingsView {
  provider: string;
  model: string;
  base_url: string;
  workspace_dir: string;
  permission_mode: PermissionMode;
  has_api_key: boolean;
  api_key_hint: string;
  mock_mode: boolean;
  allowed_url_hosts: string[];
  allowed_apps: string[];
}

export interface SettingsUpdate {
  provider?: string;
  model?: string;
  base_url?: string;
  workspace_dir?: string;
  permission_mode?: PermissionMode;
  api_key?: string;
}

export type ConnectionStatus = "connected" | "missing_key" | "invalid_key" | "error" | "mock";

export interface ConnectionTestResult {
  status: ConnectionStatus;
  detail: string;
}

export interface HealthResponse {
  ok: boolean;
  version: string;
  mock_mode: boolean;
}

export interface ErrorResponse {
  error: string;
  detail: string | null;
}
