// ============================================================
//  JARVIS proxy - Vercel serverless function
//  Place this file at:  api/chat.js  in your repo.
//  Set env var ANTHROPIC_API_KEY in the Vercel project settings.
//  The function URL is then:  https://YOURPROJECT.vercel.app/api/chat
// ============================================================

const ALLOWED_ORIGIN = "https://benmor042012-maker.github.io";
const MODEL          = "claude-sonnet-5";        // or "claude-haiku-4-5-20251001"
const MAX_TOKENS     = 1000;
const SYSTEM_PROMPT  = "אתה JARVIS, עוזר AI חכם, שנון ורגוע בסגנון הסרטים של איירון מן. אתה עונה תמיד בעברית, בקצרה ולעניין (1-3 משפטים בדרך כלל, אלא אם התבקש הסבר ארוך), בביטחון עצמי מסוים ומעט הומור יבש, בלי להיות מוגזם. אתה יכול לפנות למשתמש בכבוד קליל. אל תשתמש באימוג'ים.";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST")   return res.status(405).json({ error: "method not allowed" });

  let messages = Array.isArray(req.body && req.body.messages) ? req.body.messages : [];
  messages = messages
    .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-20);
  if (!messages.length) return res.status(400).json({ error: "no messages" });

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, system: SYSTEM_PROMPT, messages }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: (data.error && data.error.message) || "upstream error" });
    const reply = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim();
    return res.status(200).json({ reply });
  } catch (e) {
    return res.status(502).json({ error: "proxy failure" });
  }
}
