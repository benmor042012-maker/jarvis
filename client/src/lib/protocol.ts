// Protocol v1 client: canonical JSON, params hash, HMAC signature, request id,
// nonce, expiry. Mirrors desktop/src/core/protocol.js exactly.
import { hmacSha256, randomHex, sha256, uuid } from "./crypto";
import type { DeviceCreds } from "../types";

export const PROTOCOL_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 30000;

export function canonical(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical(obj[k])).join(",") + "}";
}

export function paramsHash(params: unknown): string {
  return sha256(canonical(params ?? {}));
}

export type ErrorKind = "offline" | "timeout" | "cancelled" | "auth" | "denied" | "expired" | "replay" | "rate_limited" | "bad_request" | "server" | "unknown";

export class AgentError extends Error {
  readonly status: number;
  readonly code: string;
  readonly kind: ErrorKind;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.kind = classify(status, code);
  }
}

function classify(status: number, code: string): ErrorKind {
  if (status === 0) return code === "timeout" ? "timeout" : code === "cancelled" ? "cancelled" : "offline";
  if (code === "unauthorized" || code === "revoked" || code === "device_expired" || code === "unknown_device") return "auth";
  if (status === 403 || code === "forbidden" || code === "local_confirmation_denied" || code === "emergency_stopped") return "denied";
  if (code === "expired") return "expired";
  if (code === "replayed" || code === "duplicated") return "replay";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server";
  if (status >= 400) return "bad_request";
  return "unknown";
}

export function describeError(err: unknown): string {
  if (err instanceof AgentError) {
    switch (err.kind) {
      case "offline":
        return "The JARVIS agent is not reachable. If the computer is off, asleep, disconnected, or the agent is stopped, it cannot be controlled.";
      case "timeout":
        return "The request timed out. The agent may be busy or the computer may be asleep.";
      case "cancelled":
        return "Cancelled.";
      case "auth":
        return `This device is not authorized (${err.code}). Pair it again from the JARVIS computer.`;
      case "denied":
        return `Denied: ${err.message}`;
      case "expired":
        return "That request or plan expired. Ask again.";
      case "replay":
        return "Duplicate request rejected (replay protection).";
      case "rate_limited":
        return "Too many requests. Wait a moment.";
      default:
        return err.message;
    }
  }
  if (err instanceof Error) return err.message;
  return "Unexpected error.";
}

interface Envelope {
  v: number;
  id: string;
  device_id: string;
  ts: number;
  expires: number;
  nonce: string;
  params: Record<string, unknown>;
  params_hash: string;
  signature: string;
  session: string;
  user: string;
}

export const SESSION_ID = uuid();

export class AgentApi {
  baseUrl: string;
  creds: DeviceCreds | null;
  clockOffset = 0;

  constructor(baseUrl = "", creds: DeviceCreds | null = null) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.creds = creds;
  }

  envelope(name: string, params: Record<string, unknown>, ttlMs: number): Envelope {
    if (!this.creds) throw new AgentError(401, "unauthorized", "This device is not paired.");
    const path = `/api/${name}`;
    const now = Date.now() + this.clockOffset;
    const base = { v: PROTOCOL_VERSION, id: uuid(), device_id: this.creds.id, ts: now, expires: now + ttlMs, nonce: randomHex(12), params, session: SESSION_ID, user: this.creds.name };
    const hash = paramsHash(params);
    const signing = [base.v, base.id, base.device_id, base.ts, base.expires, base.nonce, "POST", path, hash].join("\n");
    return { ...base, params_hash: hash, signature: hmacSha256(this.creds.secret, signing) };
  }

  async health(signal?: AbortSignal): Promise<import("../types").HealthResponse> {
    const res = await this.fetch(`${this.baseUrl}/api/health`, { method: "GET", ...(signal ? { signal } : {}) }, 8000);
    const body = (await res.json()) as import("../types").HealthResponse;
    if (typeof body.time === "number") this.clockOffset = body.time - Date.now();
    return body;
  }

  async call<T>(name: string, params: Record<string, unknown> = {}, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const env = this.envelope(name, params, Math.min(timeoutMs + 60000, 5 * 60000));
    const res = await this.fetch(`${this.baseUrl}/api/${name}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(env), ...(opts.signal ? { signal: opts.signal } : {}) }, timeoutMs);
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? (JSON.parse(text) as unknown) : null;
    } catch {
      body = null;
    }
    if (!res.ok) {
      const b = (body ?? {}) as { error?: string; detail?: string };
      throw new AgentError(res.status, b.error ?? "http", b.detail ?? b.error ?? `Request failed (${String(res.status)})`);
    }
    return body as T;
  }

  async pair(code: string, name: string): Promise<DeviceCreds> {
    const res = await this.fetch(`${this.baseUrl}/api/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name }) }, 15000);
    const body = (await res.json()) as { device_id?: string; secret?: string; name?: string; role?: "owner" | "remote"; error?: string };
    if (!res.ok || !body.device_id || !body.secret) throw new AgentError(res.status, body.error ?? "pair_failed", body.error === "rate_limited" ? "Too many attempts. Wait 10 minutes." : "The pairing code is wrong or expired.");
    return { id: body.device_id, secret: body.secret, name: body.name ?? name, role: body.role ?? "remote" };
  }

  private async fetch(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => {
      ctrl.abort(new DOMException("timeout", "TimeoutError"));
    }, timeoutMs);
    const outer = init.signal;
    const onAbort = () => {
      ctrl.abort(new DOMException("cancelled", "AbortError"));
    };
    if (outer) {
      if (outer.aborted) onAbort();
      else outer.addEventListener("abort", onAbort, { once: true });
    }
    try {
      return await fetch(url, { ...init, signal: ctrl.signal, cache: "no-store" });
    } catch (err) {
      if (err instanceof DOMException && err.name === "TimeoutError") throw new AgentError(0, "timeout", "timeout");
      if (ctrl.signal.aborted) {
        const reason: unknown = ctrl.signal.reason;
        if (reason instanceof DOMException && reason.name === "TimeoutError") throw new AgentError(0, "timeout", "timeout");
        throw new AgentError(0, "cancelled", "cancelled");
      }
      throw new AgentError(0, "network", "network");
    } finally {
      window.clearTimeout(timer);
      outer?.removeEventListener("abort", onAbort);
    }
  }
}

const STORAGE_KEY = "jarvis.device.v1";

export function loadCreds(): DeviceCreds | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as Partial<DeviceCreds>;
    if (typeof c.id === "string" && typeof c.secret === "string") return { id: c.id, secret: c.secret, name: c.name ?? "device", role: c.role === "owner" ? "owner" : "remote" };
  } catch {
    /* storage unavailable */
  }
  return null;
}

export function saveCreds(creds: DeviceCreds | null): void {
  try {
    if (creds) localStorage.setItem(STORAGE_KEY, JSON.stringify(creds));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage unavailable */
  }
}
