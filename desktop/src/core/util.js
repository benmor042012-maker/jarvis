// Small, dependency-free helpers shared by the agent core.
const crypto = require("crypto");

function canonical(value) {
  // Deterministic JSON: sorted object keys, no whitespace. Used for hashing
  // parameters so an approval can be bound to the exact request.
  if (value === null || typeof value !== "object") return JSON.stringify(value === undefined ? null : value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
}

function sha256(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function hmac(secret, text) {
  return crypto.createHmac("sha256", secret).update(text, "utf8").digest("hex");
}

function paramsHash(params) {
  return sha256(canonical(params === undefined ? {} : params));
}

function uuid() {
  return crypto.randomUUID();
}

function randomHex(bytes = 24) {
  return crypto.randomBytes(bytes).toString("hex");
}

function timingEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

const SECRET_KEYS = /(api[_-]?key|authorization|secret|token|password|passwd|credential|cookie|private[_-]?key)/i;
const SECRET_VALUES = /\b(sk-[A-Za-z0-9_\-]{8,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|Bearer\s+[A-Za-z0-9._\-]{8,}|xox[baprs]-[A-Za-z0-9\-]{10,})/g;

// Recursively mask secret-looking keys and values. Used by the audit log and by
// every error message that leaves the process.
function redact(value, depth = 0) {
  if (depth > 12) return "[depth]";
  if (typeof value === "string") return value.replace(SECRET_VALUES, "***");
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEYS.test(k) ? "***" : redact(v, depth + 1);
    return out;
  }
  return value;
}

function clampInt(v, min, max, name = "value") {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return Math.min(max, Math.max(min, Math.round(n)));
}

function isPrivateHost(hostname) {
  const h = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "::1" || h.endsWith(".local") || h.endsWith(".localhost")) return true;
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

// An error caused by bad input: reported as HTTP 400, never as a server fault.
function userError(message) {
  const e = new Error(message);
  e.status = 400;
  e.code = "bad_request";
  return e;
}

function nowMs() {
  return Date.now();
}

module.exports = { userError, canonical, sha256, hmac, paramsHash, uuid, randomHex, timingEqual, redact, clampInt, isPrivateHost, nowMs };
