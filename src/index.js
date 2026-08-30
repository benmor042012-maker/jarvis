// src/index.js
// JARVIS Worker — main router.
//
// Endpoints:
//   POST /            → chat (with agent loop, tools, memory)
//   POST /chat        → same as /
//   POST /memory/retrieve
//   GET  /memory
//   DELETE /memory/:id
//   GET  /reminders/poll  → returns fired reminders since last poll
//   GET  /cost-report     → Cost Guard summary
//   GET  /health          → self-check
//
// Response shape for /chat is BACKWARDS COMPATIBLE with the existing
// index.html frontend: { reply, ... }. Also returns extras so newer
// clients can render tool traces.

import {
  retrieveMemories,
  buildMemoryBlock,
  touchAccessed,
  extractAndStore,
  consolidate,
  rememberExplicit,
} from "./memory.js";
import { runAgent } from "./agent.js";
import { checkRateLimit, corsHeaders } from "./security.js";
import { costReport } from "./cost_guard.js";
import { reminder_poll, reminder_set, reminder_list, reminder_cancel, tickReminders } from "./tools/reminders.js";

const BASE_PERSONA = `אתה JARVIS, עוזר AI אישי חכם, שנון ורגוע בסגנון סרטי איירון מן. אתה עונה תמיד בעברית, בקצרה ולעניין (1-3 משפטים בדרך כלל אלא אם התבקש הסבר ארוך), בביטחון עצמי מסוים ומעט הומור יבש, בלי להיות מוגזם. אתה יכול לפנות למשתמש בכבוד קליל. אל תשתמש באימוג'ים.

יש לך גישה לכלים אמיתיים. השתמש בהם רק כשצריך:
- web_search למידע עדכני שאתה לא בטוח בו (מחירים, חדשות, מזג אוויר עדכני, עובדות חוזרות בשינוי).
- web_fetch אחרי web_search כדי לקרוא תוצאה מסוימת.
- weather למזג אוויר בעיר מסוימת.
- calculator לחישוב מדויק במקום ניחוש.
- current_time לשאלות על שעה/יום/תאריך.
- reminder_set/list/cancel לתזכורות שנשמרות גם אם הדפדפן נסגר.
- memory_write כשהמשתמש אומר "תזכור ש..." או כשמתגלה עובדה חשובה יציבה.
- memory_search כשהמשתמש שואל מה אתה זוכר.
- memory_forget רק כשהמשתמש אומר במפורש לשכוח משהו.

אם אתה יכול לענות מזיכרון או מידע כללי — ענה ישירות. אל תפעיל כלי סתם.`;

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function textResp(text, headers) {
  return new Response(text, {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8", ...headers },
  });
}

export default {
  async fetch(request, env, ctx) {
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (request.method === "POST" && (path === "/" || path === "/chat"))
        return handleChat(request, env, ctx, cors);
      if (request.method === "POST" && path === "/memory/retrieve")
        return handleRetrieve(request, env, cors);
      if (request.method === "GET" && path === "/memory")
        return handleList(request, env, cors);
      if (request.method === "DELETE" && path.startsWith("/memory/"))
        return handleDelete(env, decodeURIComponent(path.split("/").pop()), cors);
      if (request.method === "GET" && path === "/reminders/poll")
        return handleRemPoll(request, env, cors);
      if (request.method === "GET" && path === "/cost-report")
        return json(costReport(env), 200, cors);
      if (request.method === "GET" && path === "/health")
        return handleHealth(env, cors);
      // Desktop API endpoints
      if (request.method === "POST" && path === "/api/memory/store")
        return handleMemoryStore(request, env, cors);
      if (request.method === "POST" && path === "/api/memory/delete")
        return handleMemoryDelete(request, env, cors);
      if (request.method === "POST" && path === "/api/reminders")
        return handleReminderCreate(request, env, cors);
      if (request.method === "GET" && path === "/api/reminders")
        return handleReminderList(request, env, cors);
      if (request.method === "POST" && path.match(/^\/api\/reminders\/[^/]+\/cancel$/))
        return handleReminderCancel(request, env, path, cors);
      if (request.method === "GET" && path === "/") return textResp(banner(), cors);
      return new Response("Not found", { status: 404, headers: cors });
    } catch (e) {
      console.error("router error", e, e?.stack);
      return json({ error: String(e.message || e) }, 500, cors);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      try { await tickReminders(env); } catch (e) { console.error("reminders tick failed", e); }
      try { await consolidate(env); } catch (e) { console.error("consolidate failed", e); }
    })());
  },
};

function banner() {
  return "JARVIS Worker\n\nendpoints:\n  POST /            chat\n  POST /chat        chat\n  POST /memory/retrieve\n  GET  /memory\n  DELETE /memory/:id\n  GET  /reminders/poll\n  GET  /cost-report\n  GET  /health\n  POST /api/memory/store\n  POST /api/memory/delete\n  POST /api/reminders\n  GET  /api/reminders\n  POST /api/reminders/:id/cancel\n";
}

async function handleChat(request, env, ctx, cors) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "bad json" }, 400, cors); }

  const userId = String(body.userId || "effi").slice(0, 64);
  const rl = checkRateLimit(userId);
  if (!rl.allowed) return json({ error: "rate limit — נסה שוב בעוד דקה" }, 429, cors);

  let messages = Array.isArray(body.messages) ? body.messages : [];
  messages = messages
    .filter((m) => m && (m.role === "user" || m.role === "assistant"))
    .slice(-20);
  if (!messages.length) return json({ error: "no messages" }, 400, cors);

  // Retrieve memory context
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const queryText =
    typeof lastUser?.content === "string"
      ? lastUser.content
      : Array.isArray(lastUser?.content)
        ? lastUser.content.filter((b) => b.type === "text").map((b) => b.text).join(" ")
        : "";
  const { core, associative } = await retrieveMemories(env, userId, queryText);
  const memoryBlock = buildMemoryBlock(core, associative);

  const persona = typeof body.system === "string" ? body.system : BASE_PERSONA;
  const system = memoryBlock ? `${persona}\n\n${memoryBlock}` : persona;

  const { response, toolTrace, aborted } = await runAgent(env, {
    userId,
    model: body.model,
    system,
    messages,
  });

  // Extract text reply from final Claude response
  const contentArr = response?.content || [];
  const reply = contentArr
    .filter((b) => b.type === "text")
    .map((b) => b.text || "")
    .join("\n")
    .trim();

  if (response?.error) {
    return json({
      error: response.error.message || String(response.error),
      reply: "",
      raw: response,
    }, response?.status || 502, cors);
  }

  // Memory write + access update in the background
  if (queryText && reply) {
    ctx.waitUntil(extractAndStore(env, userId, queryText, reply));
    ctx.waitUntil(touchAccessed(env, [...core, ...associative]));
  }

  return json({
    reply,
    tool_trace: toolTrace,
    aborted: aborted || null,
    // legacy fields
    content: contentArr,
    stop_reason: response?.stop_reason,
  }, 200, cors);
}

async function handleRetrieve(request, env, cors) {
  const { query = "", userId = "effi" } = await request.json();
  const { core, associative } = await retrieveMemories(env, userId, query);
  return json({ core, associative }, 200, cors);
}

async function handleList(request, env, cors) {
  const url = new URL(request.url);
  const userId = url.searchParams.get("userId") || "effi";
  const rows = await env.DB.prepare(
    `SELECT id, type, subject, content, salience, created_at
     FROM memories WHERE user_id = ? AND status = 'active'
     ORDER BY salience DESC, created_at DESC`
  ).bind(userId).all();
  return json({ memories: rows.results || [] }, 200, cors);
}

async function handleDelete(env, id, cors) {
  await env.DB.prepare(`DELETE FROM memories WHERE id = ?`).bind(id).run();
  try { await env.VECTORIZE.deleteByIds([id]); } catch {}
  return json({ deleted: id }, 200, cors);
}

async function handleRemPoll(request, env, cors) {
  const url = new URL(request.url);
  const userId = url.searchParams.get("userId") || "effi";
  const out = await reminder_poll(env, userId);
  return json(out, 200, cors);
}

async function handleHealth(env, cors) {
  const checks = {
    anthropic_key: !!env.ANTHROPIC_API_KEY,
    d1: false,
    vectorize: false,
    ai: false,
  };
  try { await env.DB.prepare("SELECT 1").first(); checks.d1 = true; } catch {}
  try { await env.AI.run("@cf/baai/bge-m3", { text: ["ping"] }); checks.ai = true; } catch {}
  try { await env.VECTORIZE.describe(); checks.vectorize = true; } catch { checks.vectorize = "unknown"; }
  return json({ ok: true, checks, timestamp: new Date().toISOString() }, 200, cors);
}

// --- Desktop API endpoints ---

async function handleMemoryStore(request, env, cors) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "bad json" }, 400, cors); }
  const userId = String(body.userId || "effi").slice(0, 64);
  const content = body.content;
  if (!content) return json({ error: "content required" }, 400, cors);
  const id = await rememberExplicit(env, userId, content, { subject: body.subject, type: body.type || "semantic", salience: body.salience || 3 });
  return json({ ok: true, id }, 200, cors);
}

async function handleMemoryDelete(request, env, cors) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "bad json" }, 400, cors); }
  if (!body.id) return json({ error: "id required" }, 400, cors);
  await env.DB.prepare(`DELETE FROM memories WHERE id = ?`).bind(body.id).run();
  try { await env.VECTORIZE.deleteByIds([body.id]); } catch {}
  return json({ deleted: body.id }, 200, cors);
}

async function handleReminderCreate(request, env, cors) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "bad json" }, 400, cors); }
  const userId = String(body.userId || "effi").slice(0, 64);
  const result = await reminder_set(env, userId, { text: body.text, at_iso: body.at_iso, in_seconds: body.in_seconds });
  return json(result, 200, cors);
}

async function handleReminderList(request, env, cors) {
  const url = new URL(request.url);
  const userId = url.searchParams.get("userId") || "effi";
  const result = await reminder_list(env, userId);
  return json(result, 200, cors);
}

async function handleReminderCancel(request, env, path, cors) {
  let body;
  try { body = await request.json(); } catch { body = {}; }
  const parts = path.split("/");
  const id = parts[3];
  const userId = String(body.userId || "effi").slice(0, 64);
  const result = await reminder_cancel(env, userId, { id });
  return json(result, 200, cors);
}
