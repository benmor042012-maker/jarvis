// ============================================================
//  JARVIS proxy - Cloudflare Worker
//  Holds the Anthropic API key server-side as a secret so it is
//  NEVER exposed in the public site. Deploy this, set the secret
//  ANTHROPIC_API_KEY, then paste the Worker URL into PROXY_URL
//  in index.html.
// ============================================================

const ALLOWED_ORIGIN = "https://benmor042012-maker.github.io"; // lock the proxy to your site
const MODEL          = "claude-sonnet-5";        // or "claude-haiku-4-5" (cheaper/faster)
const MAX_TOKENS     = 1000;
const SYSTEM_PROMPT  = "אתה JARVIS, עוזר AI חכם, שנון ורגוע בסגנון הסרטים של איירון מן. אתה עונה תמיד בעברית, בקצרה ולעניין (1-3 משפטים בדרך כלל, אלא אם התבקש הסבר ארוך), בביטחון עצמי מסוים ומעט הומור יבש, בלי להיות מוגזם. אתה יכול לפנות למשתמש בכבוד קליל. אל תשתמש באימוג'ים.";

export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (request.method !== "POST")   return json({ error: "method not allowed" }, 405, cors);

    let body;
    try { body = await request.json(); } catch { return json({ error: "bad json" }, 400, cors); }

    // The proxy owns the model, system prompt and limits. The client only
    // sends the conversation, so nobody can run up your bill via a huge request.
    let messages = Array.isArray(body.messages) ? body.messages : [];
    messages = messages
      .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .slice(-20); // cap history length to control token cost
    if (!messages.length) return json({ error: "no messages" }, 400, cors);

    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, system: SYSTEM_PROMPT, messages }),
      });
      const data = await r.json();
      if (!r.ok) return json({ error: (data.error && data.error.message) || "upstream error" }, r.status, cors);
      const reply = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim();
      return json({ reply }, 200, cors);
    } catch (e) {
      return json({ error: "proxy failure" }, 502, cors);
    }
  },
};

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", ...cors },
  });
}
