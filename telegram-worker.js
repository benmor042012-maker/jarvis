// ============================================================
//  JARVIS on Telegram - Cloudflare Worker (webhook bot) + self-check
//  Secrets: TELEGRAM_BOT_TOKEN, ANTHROPIC_API_KEY   Optional: OWNER_ID
//  After deploy, just open the Worker URL in a browser to see a full
//  Hebrew health report. No /?setup or /?info needed anymore.
// ============================================================

const MODEL         = "claude-sonnet-5";
const MAX_TOKENS    = 800;
const SYSTEM_PROMPT = "אתה JARVIS, עוזר AI חכם, שנון ורגוע בסגנון הסרטים של איירון מן. אתה עונה תמיד בעברית, בקצרה ולעניין (1-3 משפטים בדרך כלל, אלא אם התבקש הסבר ארוך), בביטחון עצמי מסוים ומעט הומור יבש, בלי להיות מוגזם. אתה יכול לפנות למשתמש בכבוד קליל. אל תשתמש באימוג'ים.";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ---------------- POST from Telegram (a real message) ----------------
    if (request.method === "POST") {
      let update;
      try { update = await request.json(); } catch { return ok(); }
      const msg = update.message || update.edited_message;
      if (!msg || !msg.text) return ok();
      const chatId = msg.chat.id;
      const text = msg.text.trim();

      if (text === "/start" || text === "/id") {
        await tg(env, "sendMessage", { chat_id: chatId,
          text: "שלום, אני JARVIS. ה-ID שלך הוא: " + chatId + "\nכדי לנעול אותי רק אליך, הוסף Secret בשם OWNER_ID." });
        return ok();
      }
      if (env.OWNER_ID && String(chatId) !== String(env.OWNER_ID)) {
        await tg(env, "sendMessage", { chat_id: chatId, text: "מצטער, אני עוזר פרטי." });
        return ok();
      }
      await tg(env, "sendChatAction", { chat_id: chatId, action: "typing" });
      let reply = "לא הצלחתי לחשוב על תשובה כרגע.";
      try {
        const r = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, system: SYSTEM_PROMPT, messages: [{ role: "user", content: text }] }),
        });
        const data = await r.json();
        if (r.ok) reply = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim() || reply;
        else reply = "שגיאה מהמוח: " + ((data.error && data.error.message) || r.status);
      } catch (e) { reply = "תקלה בחיבור למוח."; }
      await tg(env, "sendMessage", { chat_id: chatId, text: reply });
      return ok();
    }

    // ---------------- GET in a browser = self-check health report ----------------
    const lines = [];
    const good = "\u2705", bad = "\u274c", warn = "\u26a0\ufe0f";

    // 1) secrets present?
    const hasTok = !!env.TELEGRAM_BOT_TOKEN;
    const hasKey = !!env.ANTHROPIC_API_KEY;
    lines.push((hasTok?good:bad) + " TELEGRAM_BOT_TOKEN " + (hasTok?"קיים":"חסר!"));
    lines.push((hasKey?good:bad) + " ANTHROPIC_API_KEY " + (hasKey?"קיים":"חסר!"));

    // 2) is the token a real bot? (getMe) and auto-fix the webhook
    let botName = "";
    if (hasTok) {
      try {
        const me = await (await tg(env, "getMe", {})).json();
        if (me.ok) { botName = "@" + me.result.username;
          lines.push(good + " הטוקן תקין. הבוט הוא " + botName);
        } else {
          lines.push(bad + " הטוקן נדחה ע\"י טלגרם: " + (me.description || "") + "  <-- זו כנראה הבעיה. צור טוקן חדש ב-BotFather ועדכן את ה-Secret.");
        }
      } catch (e) { lines.push(bad + " לא הצלחתי לפנות לטלגרם."); }

      // (re)register the webhook to THIS url, cleanly
      const hook = url.origin + url.pathname;
      try {
        const sw = await (await tg(env, "setWebhook", { url: hook, drop_pending_updates: true })).json();
        lines.push((sw.ok?good:bad) + " חיבור webhook: " + (sw.description || (sw.ok?"הוגדר":"נכשל")));
      } catch (e) { lines.push(bad + " נכשל בהגדרת webhook."); }

      // report what Telegram sees
      try {
        const info = await (await tg(env, "getWebhookInfo", {})).json();
        if (info.ok) {
          const r = info.result;
          lines.push((r.url===hook?good:warn) + " הכתובת שטלגרם מכיר: " + (r.url || "(ריק)"));
          if (r.last_error_message) lines.push(bad + " שגיאה אחרונה מטלגרם: " + r.last_error_message);
          else lines.push(good + " אין שגיאות אצל טלגרם");
        }
      } catch (e) {}
    }

    // 3) does the brain answer?
    if (hasKey) {
      try {
        const r = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({ model: MODEL, max_tokens: 20, messages: [{ role: "user", content: "אמור שלום" }] }),
        });
        const d = await r.json();
        if (r.ok) lines.push(good + " המוח (Claude) עונה, יש קרדיט");
        else lines.push(bad + " המוח החזיר שגיאה: " + ((d.error && d.error.message) || r.status) + "  <-- כנראה מפתח לא תקין או אין קרדיט");
      } catch (e) { lines.push(bad + " לא הצלחתי לפנות למוח."); }
    }

    lines.push("");
    lines.push("אם הכל ירוק למעלה, שלח /start לבוט " + (botName||"") + " בטלגרם, וזה אמור לעבוד.");

    return new Response(lines.join("\n"), { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
  },
};

function ok() { return new Response("ok", { status: 200 }); }
async function tg(env, method, payload) {
  return fetch("https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/" + method, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
  });
}
