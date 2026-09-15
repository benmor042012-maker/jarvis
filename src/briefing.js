// src/briefing.js
// "POV: Jarvis calls you at 6:00" — the morning briefing.
//
// Every morning at BRIEFING_HOUR (local, Asia/Jerusalem) the cron wakes up,
// JARVIS reads overnight email, today's calendar, pending reminders and the
// weather, drafts replies to emails that need one (drafts only — never sends),
// writes a short Hebrew briefing, and delivers it:
//   • Telegram message (if TELEGRAM_BOT_TOKEN + OWNER_ID are set)
//   • stored in D1 so the web page / desktop app pick it up and READ IT ALOUD
// All free: Workers cron, D1, Gmail/Calendar APIs, Telegram Bot API.

import { runAgent } from "./agent.js";
import { retrieveMemories, buildMemoryBlock } from "./memory.js";
import { status as googleStatus } from "./google.js";
import { hasDB, hasKey, MSG_NO_DB, MSG_NO_KEY, safeDB } from "./env_guard.js";

const TZ = "Asia/Jerusalem";

const BRIEFING_SYSTEM = `אתה JARVIS, עוזר AI אישי בסגנון איירון מן. עכשיו בוקר ואתה מכין למשתמש תדריך בוקר קצר בעברית, כאילו אתה מתקשר אליו להעיר אותו.

עשה בסדר הזה, באמצעות הכלים:
1. gmail_search עם "is:unread newer_than:16h -category:promotions -category:social" — קרא את מה שהגיע בלילה.
2. למיילים שדורשים תשובה אנושית (לקוח, פנייה, בקשה, הרשמה שצריך לאשר) — קרא אותם עם gmail_read ונסח טיוטת תשובה קצרה ומנומסת עם gmail_create_draft (reply_to_message_id). אל תשלח בפועל. אל תנסח טיוטות לניוזלטרים, התראות אוטומטיות או ספאם.
3. calendar_list_events מהתחלת היום עד סוף היום.
4. reminder_list.
5. weather לעיר של המשתמש אם ידועה מהזיכרון, אחרת "תל אביב".

ואז כתוב את התדריך עצמו: 5-10 משפטים, בגוף שני, טון רגוע ובטוח עם מעט הומור יבש, בלי אימוג'ים, בלי כותרות ובלי markdown (זה יוקרא בקול). התחל ב"בוקר טוב". ציין: כמה מיילים הגיעו ומה חשוב, לאילו הכנת טיוטות, מה יש היום ביומן ומתי הדבר הראשון, תזכורות פתוחות, ומזג האוויר במשפט. אם Google לא מחובר — אמור זאת במשפט אחד ותמשיך עם מה שיש.`;

function localHour(date = new Date()) {
  const h = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", hour12: false }).format(date);
  return Number(h.replace(/^24$/, "0"));
}

function localDateKey(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

// Called by the cron every hour (see wrangler.toml). Fires once per local day.
export async function maybeRunScheduledBriefing(env) {
  if (!hasDB(env) || !hasKey(env)) return { skipped: "not_configured" };
  const hour = Number(env.BRIEFING_HOUR ?? 6);
  if (localHour() !== hour) return { skipped: "not_the_hour", local_hour: localHour() };
  const users = await briefingUsers(env);
  const out = [];
  for (const userId of users) {
    const today = localDateKey();
    const exists = await safeDB(
      env,
      () => env.DB.prepare(`SELECT id FROM briefings WHERE user_id = ? AND day = ? LIMIT 1`).bind(userId, today).first(),
      null,
      "briefing dedupe"
    );
    if (exists) { out.push({ userId, skipped: "already_sent" }); continue; }
    out.push(await runBriefing(env, userId));
  }
  return { ran: out };
}

// Who gets a briefing: everyone who connected Google, plus the configured owner.
async function briefingUsers(env) {
  const set = new Set();
  if (env.BRIEFING_USER_ID) set.add(env.BRIEFING_USER_ID);
  const rows = await safeDB(env, () => env.DB.prepare(`SELECT user_id FROM google_tokens`).all(), { results: [] }, "briefing users");
  for (const r of rows.results || []) set.add(r.user_id);
  if (!set.size) set.add("effi");
  return [...set];
}

export async function runBriefing(env, userId, { deliver = true } = {}) {
  if (!hasKey(env)) return { userId, ok: false, error: MSG_NO_KEY };
  if (!hasDB(env)) return { userId, ok: false, error: MSG_NO_DB };
  const { core } = await retrieveMemories(env, userId, "בוקר, עיר מגורים, עבודה, לוח זמנים");
  const memoryBlock = buildMemoryBlock(core, []);
  const g = await googleStatus(env, userId);
  const now = new Intl.DateTimeFormat("he-IL", { timeZone: TZ, dateStyle: "full", timeStyle: "short" }).format(new Date());

  const system = [BRIEFING_SYSTEM, memoryBlock, `עכשיו: ${now}. Google ${g.connected ? "מחובר (" + g.email + ")" : "לא מחובר"}.`]
    .filter(Boolean).join("\n\n");

  const { response, toolTrace, aborted } = await runAgent(env, {
    userId,
    system,
    messages: [{ role: "user", content: "הכן את תדריך הבוקר שלי." }],
    maxSteps: 14,
  });

  const text = (response?.content || [])
    .filter((b) => b.type === "text").map((b) => b.text || "").join("\n").trim();
  if (!text) {
    console.error("briefing produced no text", aborted, response?.error);
    return { userId, ok: false, error: response?.error?.message || aborted || "empty" };
  }

  const id = crypto.randomUUID();
  const drafts = toolTrace.filter((t) => t.tool === "gmail_create_draft" && t.output?.draft_created).length;
  await safeDB(
    env,
    () => env.DB.prepare(
      `INSERT INTO briefings (id, user_id, day, text, drafts_created, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(id, userId, localDateKey(), text, drafts, Date.now()).run(),
    null,
    "briefing insert"
  );

  let telegram = null;
  if (deliver) telegram = await sendTelegram(env, text);
  return { userId, ok: true, id, text, drafts_created: drafts, telegram, tools_used: toolTrace.map((t) => t.tool) };
}

// Web page / desktop poll this and speak whatever hasn't been spoken yet.
export async function latestBriefing(env, userId, { markSpoken = true } = {}) {
  if (!hasDB(env)) return { briefing: null, not_configured: "d1" };
  const row = await safeDB(env, () => env.DB.prepare(
    `SELECT id, day, text, drafts_created, created_at, spoken_at FROM briefings
     WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`
  ).bind(userId).first(), null, "latestBriefing");
  if (!row) return { briefing: null };
  const unspoken = !row.spoken_at;
  if (unspoken && markSpoken) {
    await env.DB.prepare(`UPDATE briefings SET spoken_at = ? WHERE id = ?`).bind(Date.now(), row.id).run();
  }
  return {
    briefing: { id: row.id, day: row.day, text: row.text, drafts_created: row.drafts_created, created_at: row.created_at },
    unspoken,
  };
}

export async function sendTelegram(env, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.OWNER_ID) return { sent: false, reason: "telegram not configured" };
  try {
    const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: env.OWNER_ID, text: text.slice(0, 4000) }),
    });
    const d = await r.json();
    return { sent: !!d.ok, error: d.ok ? undefined : d.description };
  } catch (e) {
    return { sent: false, error: String(e.message || e) };
  }
}
