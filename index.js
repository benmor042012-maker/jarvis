// index.js
// הראוטר של ה-Worker: צ'אט עם הזרקת זיכרון, endpoints לניהול זיכרון, ו-cron.

import {
  retrieveMemories,
  buildMemoryBlock,
  touchAccessed,
  extractAndStore,
  consolidate,
  callAnthropic,
} from "./memory.js";

// כאן מדביקים את ה-system prompt הקיים של Jarvis
const BASE_PERSONA = `אתה Jarvis, עוזר קולי אישי. ענה בעברית, בקצרה ולעניין.`;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...CORS },
  });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (request.method === "POST" && (path === "/" || path === "/chat"))
        return handleChat(request, env, ctx);
      if (request.method === "POST" && path === "/memory/retrieve")
        return handleRetrieve(request, env);
      if (request.method === "GET" && path === "/memory")
        return handleList(request, env);
      if (request.method === "DELETE" && path.startsWith("/memory/"))
        return handleDelete(env, decodeURIComponent(path.split("/").pop()));
      return new Response("Not found", { status: 404, headers: CORS });
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(consolidate(env));
  },
};

// הצ'אט הראשי: שולף זיכרון, מזריק, קורא ל-Claude, ואז כותב זיכרון ברקע
async function handleChat(request, env, ctx) {
  const body = await request.json();
  const messages = body.messages || [];
  const userId = body.userId || "effi";

  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const queryText =
    typeof lastUser?.content === "string" ? lastUser.content : "";

  const { core, associative } = await retrieveMemories(env, userId, queryText);
  const memoryBlock = buildMemoryBlock(core, associative);

  const incomingSystem = typeof body.system === "string" ? body.system : BASE_PERSONA;
  const system = memoryBlock
    ? `${incomingSystem}\n\n${memoryBlock}`
    : incomingSystem;

  const data = await callAnthropic(env, {
    model: body.model || "claude-sonnet-5",
    max_tokens: body.max_tokens || 1024,
    system,
    messages,
  });

  const assistantText = (data.content || []).map((b) => b.text || "").join("");

  // כתיבת זיכרון ועדכון גישה, ברקע, בלי לעכב את התשובה למשתמש
  if (queryText && assistantText) {
    ctx.waitUntil(extractAndStore(env, userId, queryText, assistantText));
    ctx.waitUntil(touchAccessed(env, [...core, ...associative]));
  }

  return json(data);
}

// שליפת זיכרון עצמאית (למשל אם ה-frontend רוצה לשלוף בנפרד מהצ'אט)
async function handleRetrieve(request, env) {
  const { query = "", userId = "effi" } = await request.json();
  const { core, associative } = await retrieveMemories(env, userId, query);
  return json({ core, associative });
}

// רשימת כל הזיכרונות הפעילים, ל-UI ולדיבוג
async function handleList(request, env) {
  const url = new URL(request.url);
  const userId = url.searchParams.get("userId") || "effi";
  const rows = await env.DB.prepare(
    `SELECT id, type, subject, content, salience, created_at
     FROM memories WHERE user_id = ? AND status = 'active'
     ORDER BY salience DESC, created_at DESC`
  ).bind(userId).all();
  return json({ memories: rows.results || [] });
}

// מחיקה ידנית של זיכרון שגוי, מ-D1 ומ-Vectorize
async function handleDelete(env, id) {
  await env.DB.prepare(`DELETE FROM memories WHERE id = ?`).bind(id).run();
  try { await env.VECTORIZE.deleteByIds([id]); } catch (e) {}
  return json({ deleted: id });
}
