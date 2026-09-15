// env_guard.js
// JARVIS must never die because one optional piece of infrastructure is
// missing. A Worker deployed with only ANTHROPIC_API_KEY should still chat;
// memory, reminders, Google and the morning briefing simply report that they
// are not configured yet, in Hebrew, instead of throwing a TypeError.

export function hasKey(env) {
  return !!(env && env.ANTHROPIC_API_KEY);
}

export function hasDB(env) {
  return !!(env && env.DB && typeof env.DB.prepare === "function");
}

export function hasAI(env) {
  return !!(env && env.AI && typeof env.AI.run === "function");
}

export function hasVectorize(env) {
  return !!(env && env.VECTORIZE && typeof env.VECTORIZE.query === "function");
}

export const MSG_NO_KEY =
  "חסר ANTHROPIC_API_KEY ב-Worker. הרץ: wrangler secret put ANTHROPIC_API_KEY";

export const MSG_NO_DB =
  "מסד הנתונים (D1) לא מחובר ל-Worker. זיכרון, תזכורות ותדריך בוקר כבויים עד שתשלים את ההתקנה (ראה SETUP.md). שאר היכולות עובדות כרגיל.";

export const MSG_NO_AI =
  "Workers AI לא מחובר, אז חיפוש סמנטי בזיכרון כבוי. הזיכרון עדיין נשמר ונקרא.";

export const ERR_NO_DB = { error: MSG_NO_DB, not_configured: "d1" };
export const ERR_NO_KEY = { error: MSG_NO_KEY, not_configured: "anthropic_key" };

// Run a function that touches D1; on any failure return `fallback` instead of
// throwing, and log why. Used everywhere a missing binding would crash a request.
export async function safeDB(env, fn, fallback, label = "d1") {
  if (!hasDB(env)) return fallback;
  try {
    return await fn();
  } catch (e) {
    console.error(`${label} failed`, e?.message || e);
    return fallback;
  }
}

// Which pieces are live right now. Used by /health and by the Hebrew
// diagnostics page so the user can see exactly what is missing.
export async function probe(env) {
  const out = {
    anthropic_key: hasKey(env),
    d1_bound: hasDB(env),
    d1_works: false,
    d1_tables: { memories: false, reminders: false, google_tokens: false, briefings: false, telegram_history: false },
    ai: false,
    vectorize: false,
    google_configured: !!(env?.GOOGLE_CLIENT_ID && env?.GOOGLE_CLIENT_SECRET),
    telegram_configured: !!env?.TELEGRAM_BOT_TOKEN,
    telegram_locked: !!env?.OWNER_ID,
  };
  if (out.d1_bound) {
    try {
      await env.DB.prepare("SELECT 1").first();
      out.d1_works = true;
    } catch {}
    if (out.d1_works) {
      for (const t of Object.keys(out.d1_tables)) {
        try {
          await env.DB.prepare(`SELECT 1 FROM ${t} LIMIT 1`).all();
          out.d1_tables[t] = true;
        } catch {}
      }
    }
  }
  if (hasAI(env)) {
    try {
      await env.AI.run("@cf/baai/bge-m3", { text: ["ping"] });
      out.ai = true;
    } catch {}
  }
  if (hasVectorize(env)) {
    try {
      await env.VECTORIZE.describe();
      out.vectorize = true;
    } catch {
      out.vectorize = "bound, לא הצלחתי לאמת";
    }
  }
  return out;
}
