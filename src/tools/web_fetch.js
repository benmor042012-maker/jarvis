// tools/web_fetch.js
// Server-side URL fetch. Strips HTML to plain text so Claude can read a page.
// Free — uses the Worker's built-in fetch.

const MAX_BYTES = 200_000;
const MAX_CHARS = 20_000;

export const web_fetch_def = {
  name: "web_fetch",
  description:
    "מוריד עמוד אינטרנט לפי URL ומחזיר את הטקסט שלו (בלי HTML). השתמש אחרי web_search כדי לקרוא תוצאה ספציפית, או כשהמשתמש נותן קישור מפורש. לא לקבצי מדיה.",
  input_schema: {
    type: "object",
    properties: {
      url: { type: "string", description: "כתובת http/https מלאה" },
    },
    required: ["url"],
  },
};

export async function web_fetch({ url }) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return { error: "invalid url" };
  }
  if (!/^https?:$/.test(u.protocol)) return { error: "only http/https allowed" };
  // Block private/local addresses to prevent SSRF
  if (isPrivateHost(u.hostname)) return { error: "blocked host" };

  const r = await fetch(u.href, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (compatible; JarvisBot/1.0; +https://github.com/benmor042012-maker/jarvis)",
      accept: "text/html,application/xhtml+xml,text/plain;q=0.9",
    },
    redirect: "follow",
  });
  if (!r.ok) return { error: `fetch failed: ${r.status}` };

  const ctype = (r.headers.get("content-type") || "").toLowerCase();
  const reader = r.body.getReader();
  let received = 0;
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    chunks.push(value);
    if (received >= MAX_BYTES) {
      try { await reader.cancel(); } catch {}
      break;
    }
  }
  const buf = new Uint8Array(received);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
  const text = new TextDecoder("utf-8", { fatal: false }).decode(buf);

  const clean = /html|xml/.test(ctype) ? htmlToText(text) : text;
  const truncated = clean.length > MAX_CHARS;
  return {
    url: u.href,
    title: extractTitle(text),
    content: clean.slice(0, MAX_CHARS),
    truncated,
    content_type: ctype || "unknown",
  };
}

function isPrivateHost(h) {
  if (!h) return true;
  h = h.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "0.0.0.0" || h === "::1") return true;
  if (/^127\./.test(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true; // link-local
  if (/^fe80:/i.test(h)) return true;
  if (/\.internal$/i.test(h)) return true;
  return false;
}

function extractTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? stripInline(m[1]).trim().slice(0, 200) : "";
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/h[1-6]>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+\n/g, "\n")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function stripInline(s) {
  return s.replace(/<[^>]+>/g, "");
}
