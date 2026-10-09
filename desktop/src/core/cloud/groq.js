// Groq: the optional fast brain, on its free plan.
//
// Off until a key is added in Connections. With no key — or in offline mode —
// nothing here runs and JARVIS stays entirely on this computer. With a key,
// two kinds of text go to Groq and nothing else: the sentence you ask JARVIS
// (with the list of safe tools it may plan), and text you ask the writing
// agent or the customer-reply desk to produce. Files, screenshots, the
// clipboard, audio and device secrets never do.
//
// The free plan has no card and no bill: past the free limit Groq answers 429
// and JARVIS says so and falls back to the rule planner. Nothing here can
// spend money.
//
// The address is fixed in this file. It cannot be pointed elsewhere from
// Settings, so the key can only ever be sent to Groq. JARVIS_GROQ_URL exists
// for the test suite's stand-in server; environment variables are set by
// whoever runs the program, not by anything a model says.
const secrets = require("../secrets");
const usage = require("./usage");

const BASE = process.env.JARVIS_GROQ_URL || "https://api.groq.com/openai/v1";
const DEFAULT_MODEL = "llama-3.1-8b-instant";
const KEY_RE = /^gsk_[A-Za-z0-9]{20,200}$/;

function key() {
  return secrets.get("groq_api_key") || process.env.GROQ_API_KEY || null;
}

function configured() {
  return !!key();
}

function setKey(value) {
  // Only an explicit null removes the key; anything else must be a key.
  if (value === null) {
    secrets.set("groq_api_key", null);
    return;
  }
  const k = typeof value === "string" ? value.trim() : "";
  if (!KEY_RE.test(k)) throw Object.assign(new Error("That does not look like a Groq key — they start with gsk_. Create one free at console.groq.com/keys."), { status: 400 });
  secrets.set("groq_api_key", k);
}

function modelFor(cfg) {
  const m = String(cfg?.groq?.model || "").trim();
  return /^[\w.:/-]{2,80}$/.test(m) ? m : DEFAULT_MODEL;
}

/** Why Groq cannot be used right now, or null when it can. */
function unusable(cfg) {
  if (cfg?.offlineMode) return "offline mode is on, so nothing is sent to Groq";
  if (cfg?.groq?.enabled === false) return "Groq is switched off in Connections";
  if (!configured()) return "no Groq key has been added";
  return null;
}

function explain(status, body) {
  const said = body?.error?.message || "";
  if (status === 401) return "Groq rejected the key (401). Add a new one in Connections.";
  if (status === 429) return "Groq's free limit is used up for now (429). Nothing is charged; it resets by itself.";
  if (status === 404 || /decommission|does not exist|not found/i.test(said)) return `Groq does not have that model (${said.slice(0, 120)}). Pick another in Connections.`;
  return `Groq returned HTTP ${String(status)}${said ? `: ${said.slice(0, 160)}` : ""}`;
}

/**
 * One chat completion, streamed. onToken(chunk, all) is called as text arrives.
 * Resolves with the full text; rejects with a sentence a person can act on.
 */
async function chat(cfg, { system, user, json = false, maxTokens = 700, temperature = 0.2, timeoutMs = 30000, signal, onToken } = {}) {
  const why = unusable(cfg);
  if (why) throw new Error(why);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error("timeout")), timeoutMs);
  const onAbort = () => ctrl.abort(new Error("cancelled"));
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      redirect: "error",
      signal: ctrl.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${key()}` },
      body: JSON.stringify({
        model: modelFor(cfg),
        stream: true,
        temperature,
        max_tokens: maxTokens,
        ...(json ? { response_format: { type: "json_object" } } : {}),
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
      }),
    });
    if (!res.ok) {
      let body = null;
      try { body = await res.json(); } catch { /* not json */ }
      const msg = explain(res.status, body);
      usage.groqCall(msg);
      throw new Error(msg);
    }
    let all = "";
    let buf = "";
    const decoder = new TextDecoder();
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        let evt;
        try { evt = JSON.parse(data); } catch { continue; }
        const piece = evt?.choices?.[0]?.delta?.content;
        if (typeof piece === "string" && piece) {
          all += piece;
          try { onToken?.(piece, all); } catch { /* a listener never breaks the answer */ }
        }
      }
    }
    usage.groqCall(null);
    return all;
  } catch (e) {
    if (ctrl.signal.aborted) {
      const why2 = ctrl.signal.reason?.message === "cancelled" ? "cancelled" : `Groq did not answer within ${String(Math.round(timeoutMs / 1000))}s`;
      usage.groqCall(why2);
      throw new Error(why2);
    }
    if (/fetch failed|ENOTFOUND|ECONNREFUSED|EAI_AGAIN/i.test(e.message)) {
      const msg = "Groq could not be reached — no internet connection?";
      usage.groqCall(msg);
      throw new Error(msg);
    }
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** Check the key by listing the models it can use. Sends no prompt. */
async function models(cfg) {
  const why = unusable(cfg);
  if (why) return { ok: false, models: [], error: why };
  try {
    const res = await fetch(`${BASE}/models`, { redirect: "error", headers: { authorization: `Bearer ${key()}` }, signal: AbortSignal.timeout(10000) });
    let body = null;
    try { body = await res.json(); } catch { /* not json */ }
    usage.groqCall(res.ok ? null : explain(res.status, body));
    if (!res.ok) return { ok: false, models: [], error: explain(res.status, body) };
    const list = Array.isArray(body?.data) ? body.data.map((m) => m.id).filter((id) => typeof id === "string").sort() : [];
    return { ok: true, models: list, error: null };
  } catch (e) {
    return { ok: false, models: [], error: /fetch failed|ENOTFOUND|EAI_AGAIN/i.test(e.message) ? "Groq could not be reached — no internet connection?" : e.message };
  }
}

function status(cfg) {
  const u = usage.snapshot();
  return { configured: configured(), enabled: cfg?.groq?.enabled !== false, usable: !unusable(cfg), reason: unusable(cfg), model: modelFor(cfg), calls: u.groqCalls, last_error: u.groqLastError, from_env: !secrets.get("groq_api_key") && !!process.env.GROQ_API_KEY };
}

module.exports = { chat, models, status, setKey, configured, unusable, modelFor, DEFAULT_MODEL };
