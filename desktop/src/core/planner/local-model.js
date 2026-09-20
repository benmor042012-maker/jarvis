// Local model adapter: Ollama or LocalAI on this computer / LAN only. No API
// keys, no cloud. Detection is cached briefly; planning asks for a JSON plan
// that is then validated against the tool registry like any other plan.
const { isPrivateHost } = require("../util");
const cli = require("./ollama-cli");

const CAPABILITY_WARNING = "Local models are smaller than hosted assistants: they can misunderstand, hallucinate tool arguments and are slower. Every plan is validated and shown before anything runs; if the model misbehaves, switch to the rule planner (MOCK MODE) or a different model.";

let cache = { at: 0, result: null };

async function fetchJson(url, { method = "GET", body, timeoutMs = 4000, signal } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await fetch(url, { method, body: body ? JSON.stringify(body) : undefined, headers: body ? { "content-type": "application/json" } : {}, signal: ctrl.signal });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { ok: res.ok, status: res.status, json, text };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

function assertPrivate(url) {
  const u = new URL(url);
  if (!isPrivateHost(u.hostname)) throw new Error(`Refusing to talk to ${u.hostname}: only local/LAN model servers are allowed.`);
  return u.toString().replace(/\/$/, "");
}

async function detect(cfg, { force = false } = {}) {
  if (!force && cache.result && Date.now() - cache.at < 20000) return cache.result;
  const out = {
    // The program on this computer, asked with `ollama list`. Preferred over
    // the socket below: it needs no port, cannot be pointed anywhere else, and
    // is found even when PATH in this window has not caught up with the
    // installer.
    cli: { binary: null, available: false, models: [], error: null },
    ollama: { url: cfg.ai.ollamaUrl, available: false, models: [], error: null },
    localai: { url: cfg.ai.localaiUrl, available: false, models: [], error: null },
  };
  try {
    const binary = cli.findOllama();
    out.cli.binary = binary;
    if (!binary) out.cli.error = "not installed";
    else {
      const l = await cli.list({ binary });
      out.cli.available = l.ok && l.models.length > 0;
      out.cli.models = l.models;
      out.cli.error = l.error;
    }
  } catch (e) { out.cli.error = e.message; }
  if (cfg.offlineMode) {
    // Offline mode still allows loopback model servers: they are on this machine.
  }
  try {
    const base = assertPrivate(cfg.ai.ollamaUrl);
    const r = await fetchJson(`${base}/api/tags`);
    if (r.ok && r.json && Array.isArray(r.json.models)) { out.ollama.available = true; out.ollama.models = r.json.models.map((m) => m.name); }
    else out.ollama.error = `HTTP ${r.status}`;
  } catch (e) { out.ollama.error = e.name === "AbortError" ? "not reachable (timeout)" : e.message.replace(/^fetch failed$/, "not running"); }
  try {
    const base = assertPrivate(cfg.ai.localaiUrl);
    const r = await fetchJson(`${base}/v1/models`);
    if (r.ok && r.json && Array.isArray(r.json.data)) { out.localai.available = true; out.localai.models = r.json.data.map((m) => m.id); }
    else out.localai.error = `HTTP ${r.status}`;
  } catch (e) { out.localai.error = e.name === "AbortError" ? "not reachable (timeout)" : e.message.replace(/^fetch failed$/, "not running"); }
  cache = { at: Date.now(), result: out };
  return out;
}

// Which provider/model will actually plan: { provider: "ollama"|"localai"|"mock", model, reason }
async function resolve(cfg) {
  const d = await detect(cfg);
  const pref = cfg.ai.provider;
  const pick = (name) => {
    const p = d[name];
    if (!p.available || !p.models.length) return null;
    const model = cfg.ai.model && p.models.includes(cfg.ai.model) ? cfg.ai.model : p.models[0];
    const out = { provider: name, model, reason: cfg.ai.model && model !== cfg.ai.model ? `selected model '${cfg.ai.model}' is not installed; using ${model}` : "ready" };
    if (name === "cli") out.binary = p.binary;
    return out;
  };
  if (pref === "mock") return { provider: "mock", model: null, reason: "rule planner selected in settings" };
  // "ollama" means the local Ollama either way: the program first, the socket
  // it also listens on as the fallback for an installation this cannot find.
  if (pref === "ollama") return pick("cli") || pick("ollama") || { provider: "mock", model: null, reason: `Ollama is not available (${d.cli.error || d.ollama.error || "no models installed"}); using the rule planner (MOCK MODE)` };
  if (pref === "localai") return pick("localai") || { provider: "mock", model: null, reason: `localai is not available (${d.localai.error || "no models installed"}); using the rule planner (MOCK MODE)` };
  return pick("cli") || pick("ollama") || pick("localai") || { provider: "mock", model: null, reason: `no local model found (Ollama: ${d.cli.error || d.ollama.error || "no models"}; LocalAI: ${d.localai.error || "no models"}); using the rule planner (MOCK MODE)` };
}

function systemPrompt(tools, language) {
  const lines = tools.map((t) => `- ${t.name} (risk ${t.risk}): ${t.description} params=${JSON.stringify(t.schema.properties || {})}${t.schema.required ? " required=" + JSON.stringify(t.schema.required) : ""}`);
  const he = language === "he";
  return `You are JARVIS, a fast and practical personal assistant on this computer. You PLAN actions; you never execute them yourself.
Reply with ONE JSON object only: {"message": string, "actions": [{"tool": string, "params": object}]}

How to answer:
- Answer in ${he ? "Hebrew by default, even when the request is written in English" : "the user's language"}. Keep "message" short and plain — one or two sentences, no lists, no preamble.
- Do the thing rather than explaining how to do it: if a tool can carry the request out, plan it instead of describing the steps.
- Never show your reasoning, and never narrate what you are about to do inside "message".
- Never say an action was done. You are planning it; something else runs it and reports what happened.
- If you are not sure what was meant, either ask ONE short question with no actions, or state the reasonable assumption in "message" and plan for it. Do not ask twice.
- Prefer the shortest route that gets it done: fewer actions, simpler tools.

Rules: use only these tools with exactly these parameter names; at most 6 actions; if the request is conversational or impossible, return an empty actions list and say so in "message".
Simple, reversible actions need no permission — plan them. Deleting, sending, publishing, buying, changing a password or anything else that cannot be undone is refused here: JARVIS asks the person itself before any of it runs.
Never plan purchases, payments, password handling or security changes.
Tools:
${lines.join("\n")}`;
}

function extractJson(text) {
  const s = String(text || "").replace(/^```(?:json)?/m, "").replace(/```$/m, "");
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a === -1 || b === -1) throw new Error("model did not return JSON");
  return JSON.parse(s.slice(a, b + 1));
}

/**
 * The first words of the answer, out of a JSON reply that is still arriving.
 *
 * The model is asked for {"message": ..., "actions": [...]}, and "message" is
 * written first — so the sentence a person reads can be shown while the actions
 * are still being generated. This pulls it out of a half-finished object, with
 * the JSON string escapes undone, and returns null until there is something
 * worth showing.
 */
function partialMessage(text) {
  const m = /"message"\s*:\s*"/.exec(String(text || ""));
  if (!m) return null;
  let out = "";
  for (let i = m.index + m[0].length; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") {
      const next = text[i + 1];
      if (next === undefined) break;
      out += next === "n" ? "\n" : next === "t" ? "\t" : next === "u" ? "" : next;
      if (next === "u") i += 4;
      i += 1;
      continue;
    }
    if (c === '"') return out.trim() || null; // the whole message has arrived
    out += c;
  }
  // Still being written: only worth showing once it is a few words.
  return out.trim().length >= 12 ? out.trim() : null;
}

async function modelPlan(cfg, { provider, model, binary }, command, tools, { signal, onPartial } = {}) {
  const sys = systemPrompt(tools, cfg.language);
  let content;
  if (provider === "cli") {
    // The program, on stdin, streamed back. Nothing over the network at all.
    let shown = "";
    const r = await cli.askCompat({
      binary,
      model,
      json: true,
      timeoutMs: cfg.ai.timeoutMs,
      signal,
      prompt: `${sys}\n\nUser: ${command}`,
      onToken: onPartial
        ? (_chunk, all) => {
            const msg = partialMessage(all);
            // Only ever forward more text, never a shorter or repeated line.
            if (msg && msg.length > shown.length) {
              shown = msg;
              onPartial(msg);
            }
          }
        : undefined,
    });
    content = r.text;
  } else if (provider === "ollama") {
    const base = assertPrivate(cfg.ai.ollamaUrl);
    const r = await fetchJson(`${base}/api/chat`, { method: "POST", timeoutMs: cfg.ai.timeoutMs, signal, body: { model, stream: false, format: "json", options: { temperature: 0.1 }, messages: [{ role: "system", content: sys }, { role: "user", content: command }] } });
    if (!r.ok) throw new Error(`Ollama returned HTTP ${r.status}: ${(r.json && r.json.error) || r.text.slice(0, 200)}`);
    content = r.json?.message?.content;
  } else {
    const base = assertPrivate(cfg.ai.localaiUrl);
    const r = await fetchJson(`${base}/v1/chat/completions`, { method: "POST", timeoutMs: cfg.ai.timeoutMs, signal, body: { model, temperature: 0.1, response_format: { type: "json_object" }, messages: [{ role: "system", content: sys }, { role: "user", content: command }] } });
    if (!r.ok) throw new Error(`LocalAI returned HTTP ${r.status}: ${r.text.slice(0, 200)}`);
    content = r.json?.choices?.[0]?.message?.content;
  }
  if (typeof content !== "string") throw new Error("model response had no content");
  const data = extractJson(content);
  if (!data || typeof data !== "object") throw new Error("model returned a non-object");
  const actions = Array.isArray(data.actions) ? data.actions.slice(0, 6) : [];
  return { message: typeof data.message === "string" ? data.message.slice(0, 2000) : "", actions };
}

// Free-form generation (drafts, project files). Returns a string.
async function generate(cfg, { provider, model, binary }, system, prompt, { signal, json = false, onPartial } = {}) {
  if (provider === "cli") {
    const r = await cli.askCompat({ binary, model, json, timeoutMs: cfg.ai.timeoutMs, signal, prompt: `${system}\n\n${prompt}`, onToken: onPartial ? (chunk) => onPartial(chunk) : undefined });
    return r.text;
  }
  if (provider === "ollama") {
    const base = assertPrivate(cfg.ai.ollamaUrl);
    const r = await fetchJson(`${base}/api/chat`, { method: "POST", timeoutMs: cfg.ai.timeoutMs, signal, body: { model, stream: false, ...(json ? { format: "json" } : {}), options: { temperature: 0.3 }, messages: [{ role: "system", content: system }, { role: "user", content: prompt }] } });
    if (!r.ok) throw new Error(`Ollama returned HTTP ${r.status}`);
    return r.json?.message?.content || "";
  }
  const base = assertPrivate(cfg.ai.localaiUrl);
  const r = await fetchJson(`${base}/v1/chat/completions`, { method: "POST", timeoutMs: cfg.ai.timeoutMs, signal, body: { model, temperature: 0.3, ...(json ? { response_format: { type: "json_object" } } : {}), messages: [{ role: "system", content: system }, { role: "user", content: prompt }] } });
  if (!r.ok) throw new Error(`LocalAI returned HTTP ${r.status}`);
  return r.json?.choices?.[0]?.message?.content || "";
}

function resetCache() { cache = { at: 0, result: null }; }

function resetAll() { resetCache(); cli.resetCache(); }

module.exports = { detect, resolve, modelPlan, generate, extractJson, partialMessage, systemPrompt, resetCache: resetAll, cli, CAPABILITY_WARNING };
