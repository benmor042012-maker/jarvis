// src/google.js
// Google OAuth (Gmail + Calendar) — FREE. One-time browser consent, then the
// refresh token lives in D1 and access tokens are minted on demand.
//
// Setup (see SETUP-GOOGLE.md):
//   wrangler secret put GOOGLE_CLIENT_ID
//   wrangler secret put GOOGLE_CLIENT_SECRET
//   open https://<worker>/google/auth?userId=effi  → consent → done.

const SCOPES = [
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.compose",
].join(" ");

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

// In-isolate cache of access tokens: { userId: { token, exp } }
import { hasDB, safeDB } from "./env_guard.js";

const accessCache = new Map();

export function redirectUri(request) {
  const u = new URL(request.url);
  return `${u.origin}/google/callback`;
}

export function isConfigured(env) {
  // Google needs its own credentials AND D1 to keep the refresh token.
  return !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && hasDB(env));
}

// Step 1: send the browser to Google's consent screen.
export function authUrl(env, request, userId) {
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(request),
    response_type: "code",
    scope: SCOPES,
    access_type: "offline", // gives us a refresh token
    prompt: "consent",      // force refresh token even on re-consent
    state: userId,
  });
  return `${AUTH_URL}?${params}`;
}

// Step 2: exchange the code for tokens and persist the refresh token.
export async function handleCallback(env, request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const userId = String(url.searchParams.get("state") || "effi").slice(0, 64);
  if (!code) throw new Error("missing code");

  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri(request),
      grant_type: "authorization_code",
    }),
  });
  const data = await r.json();
  if (!r.ok || !data.refresh_token) {
    throw new Error(`token exchange failed: ${data.error_description || data.error || r.status}`);
  }

  // Which Google account is this?
  let email = null;
  try {
    const p = await fetch("https://www.googleapis.com/gmail/v1/users/me/profile", {
      headers: { authorization: `Bearer ${data.access_token}` },
    }).then((x) => x.json());
    email = p.emailAddress || null;
  } catch {}

  await env.DB.prepare(
    `INSERT INTO google_tokens (user_id, refresh_token, email, scopes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       refresh_token = excluded.refresh_token,
       email = excluded.email,
       scopes = excluded.scopes,
       updated_at = excluded.updated_at`
  ).bind(userId, data.refresh_token, email, SCOPES, Date.now(), Date.now()).run();

  accessCache.set(userId, { token: data.access_token, exp: Date.now() + (data.expires_in - 60) * 1000 });
  return { userId, email };
}

export async function status(env, userId) {
  if (!isConfigured(env)) return { configured: false, connected: false };
  const row = await safeDB(
    env,
    () => env.DB.prepare(`SELECT email, updated_at FROM google_tokens WHERE user_id = ?`).bind(userId).first(),
    null,
    "google status"
  );
  return { configured: true, connected: !!row, email: row?.email || null, updated_at: row?.updated_at || null };
}

export async function disconnect(env, userId) {
  await safeDB(env, () => env.DB.prepare(`DELETE FROM google_tokens WHERE user_id = ?`).bind(userId).run(), null, "google disconnect");
  accessCache.delete(userId);
}

async function refreshToken(env, userId) {
  let refresh = env.GOOGLE_REFRESH_TOKEN || null; // optional manual override
  const row = await safeDB(
    env,
    () => env.DB.prepare(`SELECT refresh_token FROM google_tokens WHERE user_id = ?`).bind(userId).first(),
    null,
    "google refresh"
  );
  if (row?.refresh_token) refresh = row.refresh_token;
  return refresh;
}

// Returns a valid access token, or null when Google is not connected.
export async function accessToken(env, userId) {
  if (!isConfigured(env)) return null;
  const cached = accessCache.get(userId);
  if (cached && cached.exp > Date.now()) return cached.token;

  const refresh = await refreshToken(env, userId);
  if (!refresh) return null;

  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refresh,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      grant_type: "refresh_token",
    }),
  });
  const data = await r.json();
  if (!r.ok) {
    console.error("google refresh failed", data);
    if (data.error === "invalid_grant") await disconnect(env, userId);
    return null;
  }
  accessCache.set(userId, { token: data.access_token, exp: Date.now() + (data.expires_in - 60) * 1000 });
  return data.access_token;
}

export const NOT_CONNECTED = {
  error: "Google לא מחובר. פתח את הכתובת /google/auth של ה-Worker בדפדפן ואשר גישה ל-Gmail וליומן (חינם, פעם אחת).",
  not_connected: true,
};

// Authenticated JSON call to any Google API.
export async function googleFetch(env, userId, url, init = {}) {
  const token = await accessToken(env, userId);
  if (!token) return { ok: false, status: 401, data: NOT_CONNECTED };
  const r = await fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers || {}),
    },
  });
  if (r.status === 204) return { ok: true, status: 204, data: {} };
  let data = null;
  try { data = await r.json(); } catch {}
  if (!r.ok) {
    const msg = data?.error?.message || `Google API ${r.status}`;
    return { ok: false, status: r.status, data: { error: msg } };
  }
  return { ok: true, status: r.status, data };
}
