// src/telegram.js
// Telegram webhook inside the main Worker, so the bot has the FULL agent:
// memory, reminders, calendar, gmail, web. (telegram-worker.js is the old
// standalone bot without tools; this replaces it.)
//
// Secrets: TELEGRAM_BOT_TOKEN, OWNER_ID (your chat id, from /id).
// Register once by opening  https://<worker>/telegram/setup  in a browser.

import { runAgent } from "./agent.js";
import { retrieveMemories, buildMemoryBlock, extractAndStore } from "./memory.js";
import { runBriefing } from "./briefing.js";

const HISTORY_TURNS = 12;

export function telegramConfigured(env) {
  return !!env.TELEGRAM_BOT_TOKEN;
}

// Telegram signs every webhook call with this header value; we derive it
// from the bot token so no extra secret is needed.
async function webhookSecret(env) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("jarvis-webhook:" + env.TELEGRAM_BOT_TOKEN));
  return [...new Uint8Array(buf)].slice(0, 24).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function verifyWebhook(env, request) {
  if (!telegramConfigured(env)) return false;
  const got = request.headers.get("x-telegram-bot-api-secret-token") || "";
  return got.length > 0 && got === (await webhookSecret(env));
}

async function tg(env, method, payload) {
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return r.json();
}

// GET /telegram/setup — registers this worker as the webhook. Idempotent.
export async function setupWebhook(env, request) {
  if (!telegramConfigured(env)) return { ok: false, error: "TELEGRAM_BOT_TOKEN חסר" };
  const u = new URL(request.url);
  const hook = `${u.origin}/telegram/webhook`;
  const sw = await tg(env, "setWebhook", { url: hook, drop_pending_updates: true, allowed_updates: ["message"], secret_token: await webhookSecret(env) });
  const me = await tg(env, "getMe", {});
  return { ok: !!sw.ok, webhook: hook, bot: me?.result?.username ? "@" + me.result.username : null, telegram: sw.description };
}

// POST /telegram/webhook — one update from Telegram.
export async function handleUpdate(env, ctx, persona, request) {
  let update;
  try { update = await request.json(); } catch { return; }
  const msg = update.message || update.edited_message;
  if (!msg || !msg.text) return;
  const chatId = msg.chat.id;
  const text = msg.text.trim();

  if (text === "/start" || text === "/id") {
    await tg(env, "sendMessage", { chat_id: chatId, text: `שלום, אני JARVIS. ה-ID שלך הוא: ${chatId}\nכדי לנעול אותי רק אליך, הוסף Secret בשם OWNER_ID עם המספר הזה.` });
    return;
  }
  if (env.OWNER_ID && String(chatId) !== String(env.OWNER_ID)) {
    await tg(env, "sendMessage", { chat_id: chatId, text: "מצטער, אני עוזר פרטי." });
    return;
  }

  const userId = env.BRIEFING_USER_ID || "effi";

  if (text === "/briefing" || text === "/boker" || text === "תדריך") {
    await tg(env, "sendChatAction", { chat_id: chatId, action: "typing" });
    const r = await runBriefing(env, userId, { deliver: false });
    await tg(env, "sendMessage", { chat_id: chatId, text: r.ok ? r.text : `לא הצלחתי להכין תדריך: ${r.error}` });
    return;
  }

  await tg(env, "sendChatAction", { chat_id: chatId, action: "typing" });

  const history = await loadHistory(env, chatId);
  const messages = [...history, { role: "user", content: text }];
  const { core, associative } = await retrieveMemories(env, userId, text);
  const memoryBlock = buildMemoryBlock(core, associative);
  const system = memoryBlock ? `${persona}\n\n${memoryBlock}` : persona;

  let reply = "לא הצלחתי לחשוב על תשובה כרגע.";
  try {
    const { response } = await runAgent(env, { userId, system, messages, maxSteps: 8 });
    const t = (response?.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    if (t) reply = t;
    else if (response?.error) reply = "שגיאה מהמוח: " + (response.error.message || "");
  } catch (e) {
    reply = "תקלה בחיבור למוח.";
  }

  await tg(env, "sendMessage", { chat_id: chatId, text: reply.slice(0, 4000) });
  ctx.waitUntil(saveHistory(env, chatId, text, reply));
  ctx.waitUntil(extractAndStore(env, userId, text, reply));
}

async function loadHistory(env, chatId) {
  try {
    const rows = await env.DB.prepare(
      `SELECT role, content FROM telegram_history WHERE chat_id = ? ORDER BY created_at DESC LIMIT ?`
    ).bind(String(chatId), HISTORY_TURNS * 2).all();
    return (rows.results || []).reverse().map((r) => ({ role: r.role, content: r.content }));
  } catch { return []; }
}

async function saveHistory(env, chatId, userText, reply) {
  const now = Date.now();
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO telegram_history (chat_id, role, content, created_at) VALUES (?, 'user', ?, ?)`).bind(String(chatId), userText.slice(0, 4000), now),
      env.DB.prepare(`INSERT INTO telegram_history (chat_id, role, content, created_at) VALUES (?, 'assistant', ?, ?)`).bind(String(chatId), reply.slice(0, 4000), now + 1),
      env.DB.prepare(`DELETE FROM telegram_history WHERE chat_id = ? AND created_at < ?`).bind(String(chatId), now - 7 * 864e5),
    ]);
  } catch (e) { console.error("telegram history save failed", e); }
}
