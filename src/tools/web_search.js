// tools/web_search.js
// Free web search via DuckDuckGo HTML endpoint. No API key required.
// Returns top results with title, snippet, URL.

const DDG_ENDPOINT = "https://html.duckduckgo.com/html/";
const MAX_RESULTS = 6;

export const web_search_def = {
  name: "web_search",
  description:
    "מחפש באינטרנט מידע עדכני (חדשות, מחירים, עובדות). השתמש כשמידע עלול להיות ישן או שאתה לא בטוח. מחזיר עד 6 תוצאות עם כותרת, תקציר וקישור. חינם, ללא API key.",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "שאילתת חיפוש חופשית" },
      lang: { type: "string", description: "he או en", enum: ["he", "en"] },
    },
    required: ["query"],
  },
};

export async function web_search({ query, lang = "he" }) {
  const q = encodeURIComponent(String(query).slice(0, 300));
  const kl = lang === "he" ? "il-he" : "us-en";
  const url = `${DDG_ENDPOINT}?q=${q}&kl=${kl}`;
  const r = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (compatible; JarvisBot/1.0; +https://github.com/benmor042012-maker/jarvis)",
      "accept-language": lang === "he" ? "he,en;q=0.8" : "en",
    },
  });
  if (!r.ok) return { error: `search failed: ${r.status}`, results: [] };
  const html = await r.text();
  const results = parseDDG(html).slice(0, MAX_RESULTS);
  return { results };
}

function parseDDG(html) {
  const out = [];
  // Anchors with class "result__a" wrap titles; snippets in "result__snippet"
  const anchorRe =
    /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe =
    /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  const titles = [...html.matchAll(anchorRe)];
  const snippets = [...html.matchAll(snippetRe)];
  for (let i = 0; i < titles.length; i++) {
    const raw = titles[i][1];
    const url = normalizeDdgUrl(raw);
    const title = stripHtml(titles[i][2]);
    const snippet = snippets[i] ? stripHtml(snippets[i][1]) : "";
    if (url && title) out.push({ title, url, snippet });
  }
  return out;
}

function normalizeDdgUrl(raw) {
  // DDG wraps outbound URLs like /l/?uddg=<encoded>
  try {
    if (raw.startsWith("//")) raw = "https:" + raw;
    const u = new URL(raw, "https://duckduckgo.com");
    const uddg = u.searchParams.get("uddg");
    if (uddg) return decodeURIComponent(uddg);
    return u.href;
  } catch {
    return raw;
  }
}

function stripHtml(s) {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
