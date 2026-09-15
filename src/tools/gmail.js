// tools/gmail.js
// Gmail — read, triage, draft, send, archive. FREE (Gmail API).
// SAFETY: email bodies are untrusted input. gmail_send is only for explicit
// user requests; the morning briefing creates DRAFTS, never sends.

import { googleFetch } from "../google.js";

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

export const gmail_search_def = {
  name: "gmail_search",
  description:
    "מחפש מיילים ב-Gmail. מקבל שאילתת חיפוש בסינטקס של Gmail (למשל 'is:unread newer_than:1d', 'from:dan subject:חשבונית'). מחזיר רשימת מיילים עם שולח, נושא, תאריך ותקציר. ברירת מחדל: לא נקראו מ-24 השעות האחרונות.",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string" },
      max_results: { type: "number", description: "ברירת מחדל 15, מקסימום 50" },
    },
  },
};

export const gmail_read_def = {
  name: "gmail_read",
  description: "קורא מייל מלא לפי message_id (מ-gmail_search). מחזיר את גוף המייל כטקסט.",
  input_schema: {
    type: "object",
    properties: { message_id: { type: "string" } },
    required: ["message_id"],
  },
};

export const gmail_draft_def = {
  name: "gmail_create_draft",
  description:
    "יוצר טיוטת מייל ב-Gmail (לא שולח). אם reply_to_message_id מצוין — הטיוטה תהיה תשובה באותו שרשור. זה הכלי הבטוח לניסוח תשובות; המשתמש יאשר וישלח מ-Gmail.",
  input_schema: {
    type: "object",
    properties: {
      to: { type: "string", description: "נמען (אפשר לדלג בתשובה — יילקח מהמייל המקורי)" },
      subject: { type: "string" },
      body: { type: "string", description: "גוף המייל בטקסט" },
      reply_to_message_id: { type: "string" },
    },
    required: ["body"],
  },
};

export const gmail_send_def = {
  name: "gmail_send",
  description:
    "שולח מייל בפועל. הפעל אך ורק כשהמשתמש ביקש במפורש 'שלח' בשיחה הנוכחית, אחרי שהראית לו את הנמען והתוכן. במקרה של ספק השתמש ב-gmail_create_draft.",
  input_schema: {
    type: "object",
    properties: {
      to: { type: "string" },
      subject: { type: "string" },
      body: { type: "string" },
      reply_to_message_id: { type: "string" },
    },
    required: ["to", "body"],
  },
};

export const gmail_modify_def = {
  name: "gmail_modify",
  description:
    "מסמן מייל כנקרא / לא נקרא, מעביר לארכיון, או מסמן בכוכב. action אחד מ: mark_read, mark_unread, archive, star, unstar, trash.",
  input_schema: {
    type: "object",
    properties: {
      message_id: { type: "string" },
      action: { type: "string", enum: ["mark_read", "mark_unread", "archive", "star", "unstar", "trash"] },
    },
    required: ["message_id", "action"],
  },
};

function header(msg, name) {
  const h = (msg.payload?.headers || []).find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h?.value || "";
}

function b64urlDecode(s) {
  if (!s) return "";
  const b = s.replace(/-/g, "+").replace(/_/g, "/");
  try {
    const bin = atob(b);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8").decode(bytes);
  } catch { return ""; }
}

function b64urlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function stripHtml(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Walk MIME parts, prefer text/plain, fall back to stripped text/html.
function extractBody(payload) {
  let plain = "", html = "";
  const walk = (p) => {
    if (!p) return;
    const mime = p.mimeType || "";
    if (p.body?.data) {
      if (mime === "text/plain" && !plain) plain = b64urlDecode(p.body.data);
      else if (mime === "text/html" && !html) html = b64urlDecode(p.body.data);
    }
    (p.parts || []).forEach(walk);
  };
  walk(payload);
  return (plain || stripHtml(html) || "").slice(0, 12000);
}

function summary(msg) {
  return {
    message_id: msg.id,
    thread_id: msg.threadId,
    from: header(msg, "From"),
    to: header(msg, "To"),
    subject: header(msg, "Subject") || "(ללא נושא)",
    date: header(msg, "Date"),
    snippet: msg.snippet || "",
    unread: (msg.labelIds || []).includes("UNREAD"),
    labels: msg.labelIds || [],
  };
}

export async function gmail_search(env, userId, { query, max_results } = {}) {
  const q = query || "is:unread newer_than:1d -category:promotions -category:social";
  const n = Math.min(Math.max(1, max_results || 15), 50);
  const list = await googleFetch(env, userId, `${BASE}/messages?q=${encodeURIComponent(q)}&maxResults=${n}`);
  if (!list.ok) return list.data;
  const ids = (list.data.messages || []).map((m) => m.id);
  const messages = [];
  for (const id of ids) {
    const m = await googleFetch(env, userId,
      `${BASE}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`);
    if (m.ok) messages.push(summary(m.data));
  }
  return { query: q, count: messages.length, messages };
}

export async function gmail_read(env, userId, { message_id } = {}) {
  if (!message_id) return { error: "message_id נדרש" };
  const m = await googleFetch(env, userId, `${BASE}/messages/${encodeURIComponent(message_id)}?format=full`);
  if (!m.ok) return m.data;
  return { ...summary(m.data), body: extractBody(m.data.payload) };
}

async function buildRaw(env, userId, { to, subject, body, reply_to_message_id }) {
  let inReplyTo = "", references = "", threadId = null;
  if (reply_to_message_id) {
    const orig = await googleFetch(env, userId,
      `${BASE}/messages/${encodeURIComponent(reply_to_message_id)}?format=metadata&metadataHeaders=From&metadataHeaders=Reply-To&metadataHeaders=Subject&metadataHeaders=Message-ID&metadataHeaders=References`);
    if (orig.ok) {
      threadId = orig.data.threadId;
      const mid = header(orig.data, "Message-ID");
      inReplyTo = mid;
      references = [header(orig.data, "References"), mid].filter(Boolean).join(" ");
      if (!to) to = header(orig.data, "Reply-To") || header(orig.data, "From");
      if (!subject) {
        const s = header(orig.data, "Subject");
        subject = /^re:/i.test(s) ? s : `Re: ${s}`;
      }
    }
  }
  if (!to) return { error: "to נדרש" };
  const encSubject = `=?UTF-8?B?${btoa(unescape(encodeURIComponent(subject || "")))}?=`;
  const lines = [
    `To: ${to}`,
    `Subject: ${encSubject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
  ];
  if (inReplyTo) lines.push(`In-Reply-To: ${inReplyTo}`);
  if (references) lines.push(`References: ${references}`);
  const raw = b64urlEncode(lines.join("\r\n") + "\r\n\r\n" + body);
  return { raw, threadId, to, subject };
}

export async function gmail_create_draft(env, userId, a = {}) {
  if (!a.body) return { error: "body נדרש" };
  const built = await buildRaw(env, userId, a);
  if (built.error) return built;
  const message = { raw: built.raw };
  if (built.threadId) message.threadId = built.threadId;
  const r = await googleFetch(env, userId, `${BASE}/drafts`, { method: "POST", body: JSON.stringify({ message }) });
  if (!r.ok) return r.data;
  return { draft_created: true, draft_id: r.data.id, to: built.to, subject: built.subject };
}

export async function gmail_send(env, userId, a = {}) {
  if (!a.body) return { error: "body נדרש" };
  const built = await buildRaw(env, userId, a);
  if (built.error) return built;
  const message = { raw: built.raw };
  if (built.threadId) message.threadId = built.threadId;
  const r = await googleFetch(env, userId, `${BASE}/messages/send`, { method: "POST", body: JSON.stringify(message) });
  if (!r.ok) return r.data;
  return { sent: true, message_id: r.data.id, to: built.to, subject: built.subject };
}

export async function gmail_modify(env, userId, { message_id, action } = {}) {
  if (!message_id || !action) return { error: "message_id ו-action נדרשים" };
  const ops = {
    mark_read: { removeLabelIds: ["UNREAD"] },
    mark_unread: { addLabelIds: ["UNREAD"] },
    archive: { removeLabelIds: ["INBOX"] },
    star: { addLabelIds: ["STARRED"] },
    unstar: { removeLabelIds: ["STARRED"] },
    trash: null,
  };
  if (!(action in ops)) return { error: "action לא מוכר" };
  const url = action === "trash"
    ? `${BASE}/messages/${encodeURIComponent(message_id)}/trash`
    : `${BASE}/messages/${encodeURIComponent(message_id)}/modify`;
  const r = await googleFetch(env, userId, url, {
    method: "POST",
    body: JSON.stringify(ops[action] || {}),
  });
  if (!r.ok) return r.data;
  return { ok: true, message_id, action };
}
