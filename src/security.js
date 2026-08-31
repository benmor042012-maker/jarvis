// security.js
// Simple in-memory rate limit + CORS helpers. Free.

// Rate limit: N requests per userId per minute. In-memory (per Worker isolate).
const buckets = new Map();
const WINDOW_MS = 60_000;
const DEFAULT_LIMIT = 30;

export function checkRateLimit(userId, limit = DEFAULT_LIMIT) {
  const now = Date.now();
  const key = userId || "anon";
  const b = buckets.get(key) || { start: now, count: 0 };
  if (now - b.start > WINDOW_MS) {
    b.start = now;
    b.count = 0;
  }
  b.count++;
  buckets.set(key, b);
  if (buckets.size > 5000) {
    // simple LRU-ish cleanup
    for (const [k, v] of buckets) if (now - v.start > WINDOW_MS * 5) buckets.delete(k);
  }
  return { allowed: b.count <= limit, remaining: Math.max(0, limit - b.count) };
}

// Locked CORS: allowed origins are configured via ALLOWED_ORIGINS
// (comma-separated). If unset, allows the user's known GH Pages origin.
const DEFAULT_ALLOWED = [
  "https://benmor042012-maker.github.io",
  "http://localhost:8787",
  "http://127.0.0.1:8787",
];

export function corsHeaders(request, env) {
  const configured = (env?.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const allowed = configured.length ? configured : DEFAULT_ALLOWED;
  const origin = request.headers.get("origin") || "";
  // Electron sends "null" or "file://" as origin; allow desktop app access
  const isDesktop = origin === "null" || origin === "" || origin.startsWith("file://");
  const allowOrigin = allowed.includes(origin) ? origin : isDesktop ? "*" : allowed[0];
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}
