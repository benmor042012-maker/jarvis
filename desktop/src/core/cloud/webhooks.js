// Webhooks: how JARVIS hands text to the apps you connect — Google Docs,
// Gmail, Sheets, Spotify — through a free automation account you control
// (Make, n8n, Zapier, Pipedream, or a Google Apps Script of your own).
//
// Outgoing only. JARVIS posts to the address you paste in; nothing on the
// internet can post back to this computer, so no port is opened.
//
// Only ever on your click. Sending is a route the window calls when you press
// "Send", with confirm: true — it is not a tool, so no model, local or Groq,
// can reach it, and the customer desk has no path to it at all.
//
// The address is a secret (anyone holding it can post to your scenario), so it
// is kept in secrets.json and the window only ever sees its host. The audit
// log records which connection, when, and how long the text was — never the
// text and never the address.
const crypto = require("crypto");
const secrets = require("../secrets");
const usage = require("./usage");

// The free automation services, by the host their webhook addresses use.
// Anything else is refused: a typo cannot send your text to a stranger.
const HOSTS = [
  { re: /^hook\.[a-z0-9-]+\.make\.com$/, service: "Make" },
  { re: /^[a-z0-9-]+\.app\.n8n\.cloud$/, service: "n8n" },
  { re: /^hooks\.zapier\.com$/, service: "Zapier" },
  { re: /^[a-z0-9]+\.m\.pipedream\.net$/, service: "Pipedream" },
  { re: /^script\.google\.com$/, service: "Google Apps Script", path: /^\/macros\/s\/[\w-]+\/exec$/ },
];
const APPS = ["google_docs", "gmail", "google_sheets", "google_calendar", "spotify", "whatsapp", "other"];
const MAX_PER_HOUR = 30;
const sentAt = [];
let fetchImpl = (...a) => fetch(...a);

function checkUrl(raw) {
  let u;
  try { u = new URL(String(raw || "").trim()); } catch { throw Object.assign(new Error("That is not a web address."), { status: 400 }); }
  if (u.protocol !== "https:") throw Object.assign(new Error("Webhook addresses must start with https://"), { status: 400 });
  if (u.username || u.password) throw Object.assign(new Error("Webhook addresses must not contain a user name or password."), { status: 400 });
  const host = u.hostname.toLowerCase();
  const match = HOSTS.find((h) => h.re.test(host) && (!h.path || h.path.test(u.pathname)));
  if (!match) throw Object.assign(new Error(`Only webhook addresses from Make, n8n, Zapier, Pipedream or a Google Apps Script web app are accepted — ${host} is none of these.`), { status: 400 });
  return { url: u.toString(), host, service: match.service };
}

function all() {
  const list = secrets.get("webhooks");
  return Array.isArray(list) ? list : [];
}

function view(w) {
  const { host, service } = checkUrl(w.url);
  return { id: w.id, name: w.name, app: w.app, service, host };
}

function list() {
  return all().map((w) => { try { return view(w); } catch { return { id: w.id, name: w.name, app: w.app, service: "invalid", host: "?" }; } });
}

function save({ id, name, app, url }) {
  const cleanName = String(name || "").trim().slice(0, 60);
  if (!cleanName) throw Object.assign(new Error("Give the connection a name, like “Google Doc — notes”."), { status: 400 });
  const cleanApp = APPS.includes(app) ? app : "other";
  const items = all();
  const existing = id ? items.find((w) => w.id === id) : null;
  // Editing a connection without retyping its address keeps the old one.
  const finalUrl = url ? checkUrl(url).url : existing?.url;
  if (!finalUrl) throw Object.assign(new Error("Paste the webhook address from your automation account."), { status: 400 });
  if (!existing && items.length >= 20) throw Object.assign(new Error("Twenty connections is the limit."), { status: 400 });
  const entry = { id: existing?.id || crypto.randomUUID(), name: cleanName, app: cleanApp, url: finalUrl };
  secrets.set("webhooks", existing ? items.map((w) => (w.id === existing.id ? entry : w)) : [...items, entry]);
  return view(entry);
}

function remove(id) {
  const items = all();
  const next = items.filter((w) => w.id !== id);
  secrets.set("webhooks", next);
  return items.length !== next.length;
}

/**
 * Post one piece of text to one connection. Called only from the window's
 * Send button, with confirm: true.
 */
async function send(cfg, { id, confirm, title = "", text = "", kind = "text", to = "", test = false }) {
  if (confirm !== true) throw Object.assign(new Error("Sending needs your confirmation."), { status: 400 });
  if (cfg?.offlineMode) throw Object.assign(new Error("Offline mode is on, so nothing is sent."), { status: 409 });
  const w = all().find((x) => x.id === id);
  if (!w) throw Object.assign(new Error("That connection no longer exists."), { status: 404 });
  const { url, host, service } = checkUrl(w.url);
  const body = test ? "This is a test from JARVIS. If you can read this, the connection works." : String(text);
  if (!body.trim()) throw Object.assign(new Error("There is nothing to send."), { status: 400 });
  if (body.length > 20000) throw Object.assign(new Error("That text is too long to send in one go (20,000 characters)."), { status: 400 });
  const now = Date.now();
  while (sentAt.length && now - sentAt[0] > 3600000) sentAt.shift();
  if (sentAt.length >= MAX_PER_HOUR) throw Object.assign(new Error(`${String(MAX_PER_HOUR)} sends in an hour is the limit — it protects your free automation quota.`), { status: 429 });
  const payload = {
    source: "jarvis",
    test: !!test,
    app: w.app,
    connection: w.name,
    kind: String(kind).slice(0, 30),
    title: String(title).slice(0, 200),
    to: String(to).slice(0, 200),
    text: body,
    sent_at: new Date(now).toISOString(),
  };
  let res;
  try {
    // redirect: manual — a webhook that answers with a redirect (Apps Script
    // does) has already run; following it would only send this text on to
    // whatever host the redirect names.
    res = await fetchImpl(url, { method: "POST", redirect: "manual", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(15000) });
  } catch (e) {
    throw Object.assign(new Error(/timeout|abort/i.test(e.name + e.message) ? `${service} did not answer within 15 seconds.` : `${service} could not be reached — no internet connection?`), { status: 502 });
  }
  const accepted = (res.status >= 200 && res.status < 400) || res.type === "opaqueredirect";
  if (!accepted) throw Object.assign(new Error(`${service} refused it (HTTP ${String(res.status)}). Is the scenario switched on?`), { status: 502 });
  sentAt.push(now);
  usage.webhookSent();
  return { ok: true, service, host, connection: w.name, chars: body.length, status: res.status };
}

function _setFetch(fn) { fetchImpl = fn; }
function _resetRate() { sentAt.length = 0; }

module.exports = { checkUrl, list, save, remove, send, APPS, HOSTS, _setFetch, _resetRate };
