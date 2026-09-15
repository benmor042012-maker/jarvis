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
import { runTool, TOOLS } from "./tools/index.js";
import * as google from "./google.js";
import { maybeRunScheduledBriefing, runBriefing, latestBriefing } from "./briefing.js";
import { handleUpdate as telegramUpdate, setupWebhook as telegramSetup, verifyWebhook as telegramVerify } from "./telegram.js";

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
- calendar_list_events / calendar_find_free_time כשהמשתמש שואל על היומן, פגישות, מתי פנוי.
- calendar_create_event / calendar_update_event / calendar_delete_event רק כשהמשתמש ביקש במפורש לקבוע, להזיז או לבטל אירוע. אחרי הפעולה אמור מה נקבע ומתי.
- gmail_search / gmail_read כשהמשתמש שואל על מיילים ("מה הגיע", "יש מייל מ-X").
- gmail_create_draft כדי לנסח תשובה למייל. gmail_send רק אם המשתמש אמר במפורש "שלח" אחרי שראה למי ומה.
- gmail_modify לסימון כנקרא, ארכיון או כוכב לפי בקשה.
כשמדברים על זמן, היום הוא לפי current_time באזור Asia/Jerusalem; חשב תאריכים יחסיים ("מחר ב-10") לפי זה.

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
      // Generic tool call for the desktop app (calendar, gmail, ...)
      if (request.method === "POST" && path.match(/^\/api\/tools\/[a-z_]+$/))
        return handleToolCall(request, env, path, cors);
      // Google OAuth (Gmail + Calendar)
      if (request.method === "GET" && path === "/google/auth")
        return handleGoogleAuth(request, env);
      if (request.method === "GET" && path === "/google/callback")
        return handleGoogleCallback(request, env);
      if (request.method === "GET" && path === "/google/status")
        return json(await google.status(env, url.searchParams.get("userId") || "effi"), 200, cors);
      if (request.method === "POST" && path === "/google/disconnect")
        return handleGoogleDisconnect(request, env, cors);
      // Morning briefing
      if (request.method === "GET" && path === "/briefing/latest")
        return handleBriefingLatest(request, env, cors);
      if (request.method === "POST" && path === "/briefing/run")
        return handleBriefingRun(request, env, cors);
      // Telegram bot (full agent)
      if (request.method === "POST" && path === "/telegram/webhook") {
        if (!(await telegramVerify(env, request))) return new Response("forbidden", { status: 403 });
        ctx.waitUntil(telegramUpdate(env, ctx, BASE_PERSONA, request.clone()));
        return new Response("ok", { status: 200 });
      }
      if (request.method === "GET" && path === "/telegram/setup")
        return json(await telegramSetup(env, request), 200, cors);
      if (request.method === "GET" && path === "/") return textResp(banner(), cors);
      return new Response("Not found", { status: 404, headers: cors });
    } catch (e) {
      console.error("router error", e, e?.stack);
      return json({ error: String(e.message || e) }, 500, cors);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      const cron = event.cron || "";
      if (cron === "* * * * *") {
        try { await tickReminders(env); } catch (e) { console.error("reminders tick failed", e); }
      } else if (cron === "0 * * * *") {
        try { await maybeRunScheduledBriefing(env); } catch (e) { console.error("briefing failed", e); }
      } else if (cron === "0 3 * * *") {
        try { await consolidate(env); } catch (e) { console.error("consolidate failed", e); }
      } else {
        // Unknown/local trigger: run everything, cheap and idempotent.
        try { await tickReminders(env); } catch (e) { console.error("reminders tick failed", e); }
        try { await maybeRunScheduledBriefing(env); } catch (e) { console.error("briefing failed", e); }
        try { await consolidate(env); } catch (e) { console.error("consolidate failed", e); }
      }
    })());
  },
};

function banner() {
  return "JARVIS Worker\n\nendpoints:\n  POST /            chat\n  POST /chat        chat\n  POST /memory/retrieve\n  GET  /memory\n  DELETE /memory/:id\n  GET  /reminders/poll\n  GET  /cost-report\n  GET  /health\n  POST /api/memory/store\n  POST /api/memory/delete\n  POST /api/reminders\n  GET  /api/reminders\n  POST /api/reminders/:id/cancel\n  POST /api/tools/:name        (desktop → calendar/gmail tools)\n  GET  /google/auth?userId=    (connect Gmail + Calendar, free)\n  GET  /google/status\n  POST /google/disconnect\n  GET  /briefing/latest?userId=\n  POST /briefing/run           (run the morning briefing now)\n  GET  /telegram/setup         (register bot webhook)\n  POST /telegram/webhook\n";
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

// --- Generic tool call (desktop app proxies calendar/gmail here) ---

const DESKTOP_TOOL_ALLOWLIST = new Set(
  Object.keys(TOOLS).filter((n) => n.startsWith("calendar_") || n.startsWith("gmail_"))
);

async function handleToolCall(request, env, path, cors) {
  const name = path.split("/").pop();
  if (!DESKTOP_TOOL_ALLOWLIST.has(name)) return json({ error: `tool not exposed: ${name}` }, 404, cors);
  let body;
  try { body = await request.json(); } catch { return json({ error: "bad json" }, 400, cors); }
  const userId = String(body.userId || "effi").slice(0, 64);
  const rl = checkRateLimit(userId, 60);
  if (!rl.allowed) return json({ error: "rate limit" }, 429, cors);
  const result = await runTool(env, userId, name, body.input || {});
  return json(result, 200, cors);
}

// --- Google OAuth ---

function htmlPage(title, body, status = 200) {
  return new Response(
    `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;background:#0b0f14;color:#e6edf3;display:grid;place-items:center;min-height:100vh;margin:0}
.card{max-width:520px;padding:32px;border:1px solid #223;border-radius:16px;background:#111823;line-height:1.7}h1{font-size:22px;margin:0 0 12px}code{background:#1c2633;padding:2px 6px;border-radius:6px}</style></head>
<body><div class="card"><h1>${title}</h1>${body}</div></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } }
  );
}

function handleGoogleAuth(request, env) {
  if (!google.isConfigured(env)) {
    return htmlPage("Google לא מוגדר",
      `<p>חסרים <code>GOOGLE_CLIENT_ID</code> ו-<code>GOOGLE_CLIENT_SECRET</code>.</p>
       <p>עקוב אחרי <b>SETUP-GOOGLE.md</b> בריפו (5 דקות, חינם), ואז חזור לכאן.</p>`, 500);
  }
  const userId = String(new URL(request.url).searchParams.get("userId") || env.BRIEFING_USER_ID || "effi").slice(0, 64);
  return Response.redirect(google.authUrl(env, request, userId), 302);
}

async function handleGoogleCallback(request, env) {
  const url = new URL(request.url);
  if (url.searchParams.get("error")) {
    return htmlPage("החיבור בוטל", `<p>Google החזיר: <code>${url.searchParams.get("error")}</code></p>`, 400);
  }
  try {
    const { userId, email } = await google.handleCallback(env, request);
    return htmlPage("JARVIS מחובר ל-Google",
      `<p>החשבון <b>${email || ""}</b> מחובר למשתמש <code>${userId}</code>.</p>
       <p>מעכשיו ג'רביס יכול לקרוא מיילים, לנסח טיוטות ולנהל את היומן, ותדריך הבוקר ירוץ אוטומטית.</p>
       <p>אפשר לסגור את החלון.</p>`);
  } catch (e) {
    return htmlPage("החיבור נכשל", `<p><code>${String(e.message || e)}</code></p>`, 500);
  }
}

async function handleGoogleDisconnect(request, env, cors) {
  let body = {};
  try { body = await request.json(); } catch {}
  const userId = String(body.userId || "effi").slice(0, 64);
  await google.disconnect(env, userId);
  return json({ disconnected: userId }, 200, cors);
}

// --- Morning briefing ---

async function handleBriefingLatest(request, env, cors) {
  const url = new URL(request.url);
  const userId = url.searchParams.get("userId") || "effi";
  const markSpoken = url.searchParams.get("peek") !== "1";
  return json(await latestBriefing(env, userId, { markSpoken }), 200, cors);
}

async function handleBriefingRun(request, env, cors) {
  let body = {};
  try { body = await request.json(); } catch {}
  const userId = String(body.userId || env.BRIEFING_USER_ID || "effi").slice(0, 64);
  const rl = checkRateLimit("briefing:" + userId, 3);
  if (!rl.allowed) return json({ error: "rate limit — תדריך ידני עד 3 פעמים בדקה" }, 429, cors);
  const result = await runBriefing(env, userId, { deliver: body.deliver !== false });
  return json(result, result.ok ? 200 : 502, cors);
}
