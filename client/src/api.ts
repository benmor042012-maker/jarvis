import type {
  Action,
  ConnectionTestResult,
  ErrorResponse,
  HealthResponse,
  JobView,
  PlanResponse,
  SettingsUpdate,
  SettingsView,
} from "./types";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function isErrorResponse(v: unknown): v is ErrorResponse {
  return typeof v === "object" && v !== null && "error" in v;
}

async function request<T>(path: string, init?: RequestInit & { signal?: AbortSignal }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers as Record<string, string> | undefined) },
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ApiError(0, "network", "The local JARVIS server is not reachable. Start it with `uvicorn server.main:app --port 8000`.");
  }
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = null;
    }
  }
  if (!res.ok) {
    if (isErrorResponse(body)) throw new ApiError(res.status, body.error, body.detail ?? body.error);
    // FastAPI validation errors come as { detail: [...] } or { detail: "..." }
    if (typeof body === "object" && body !== null && "detail" in body) {
      const d = body.detail;
      const msg =
        typeof d === "string"
          ? d
          : Array.isArray(d)
            ? d.map((e: unknown) => (typeof e === "object" && e !== null && "msg" in e ? String(e.msg) : "")).join("; ")
            : `Request failed (${String(res.status)})`;
      throw new ApiError(res.status, "validation", msg);
    }
    throw new ApiError(res.status, "http", `Request failed (${String(res.status)})`);
  }
  return body as T;
}

export const api = {
  health: () => request<HealthResponse>("/api/health"),
  command: (command: string, signal?: AbortSignal) =>
    request<PlanResponse>("/api/command", { method: "POST", body: JSON.stringify({ command }), ...(signal ? { signal } : {}) }),
  execute: (actions: Action[], confirmed: boolean) =>
    request<JobView>("/api/execute", { method: "POST", body: JSON.stringify({ actions, confirmed }) }),
  job: (id: string) => request<JobView>(`/api/jobs/${encodeURIComponent(id)}`),
  cancelJob: (id: string) => request<JobView>(`/api/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST" }),
  settings: () => request<SettingsView>("/api/settings"),
  updateSettings: (update: SettingsUpdate) => request<SettingsView>("/api/settings", { method: "PUT", body: JSON.stringify(update) }),
  testConnection: () => request<ConnectionTestResult>("/api/settings/test", { method: "POST" }),
};
