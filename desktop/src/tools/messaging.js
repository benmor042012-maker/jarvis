const https = require("https");
const { load } = require("../config");
const contacts = require("../contacts");
const computer = require("./computer");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpsJson(options, bodyObj) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    if (bodyObj !== undefined) req.write(typeof bodyObj === "string" ? bodyObj : JSON.stringify(bodyObj));
    req.end();
  });
}

// --- WhatsApp -------------------------------------------------------------
// The deep link is what makes this reliable: WhatsApp resolves the contact and
// fills the compose box itself, so JARVIS only confirms the right chat is open
// and presses one key. No blind clicking at guessed coordinates.

async function findWhatsAppWindow() {
  const windows = await computer.RUNNERS.window_list();
  if (!Array.isArray(windows)) return null;
  return windows.find((w) => /whatsapp/i.test(w.title || "") || /whatsapp/i.test(w.name || "")) || null;
}

async function whatsapp_send({ to, text }) {
  if (!text || typeof text !== "string") throw new Error("text required");
  if (!to) throw new Error("to required (contact name or phone number)");

  const contact = contacts.resolve(to);
  const rawNumber = contact?.phone || to;
  const number = contacts.waNumber(rawNumber);
  if (!/^\d{8,15}$/.test(number)) {
    throw new Error(`אין לי מספר תקין עבור "${to}". אפשר לשמור אותו עם contact_save.`);
  }

  const url = `https://web.whatsapp.com/send?phone=${number}&text=${encodeURIComponent(text)}`;
  await computer.RUNNERS.open_url({ url });

  // WhatsApp Web needs time to load and focus the compose box.
  let win = null;
  for (let i = 0; i < 12; i++) {
    await sleep(1000);
    win = await findWhatsAppWindow();
    if (win) break;
  }
  if (!win) {
    return {
      sent: false,
      message: "לא מצאתי חלון של WhatsApp. ייתכן ש-WhatsApp Web לא מחובר — צריך לסרוק QR פעם אחת.",
    };
  }

  await computer.RUNNERS.window_focus({ pid: win.pid });
  await sleep(1500);
  await computer.RUNNERS.keyboard_combo({ keys: ["enter"] });
  await sleep(1200);

  const shot = await computer.RUNNERS.take_screenshot();
  return {
    ...shot,
    sent: true,
    to: contact?.name || to,
    number,
    message: `נשלח ל-${contact?.name || to} (${number}). בדוק בצילום המסך שההודעה אכן נשלחה.`,
  };
}

async function whatsapp_read() {
  const win = await findWhatsAppWindow();
  if (!win) throw new Error("WhatsApp לא פתוח. פתח אותו עם open_url ל-https://web.whatsapp.com");
  await computer.RUNNERS.window_focus({ pid: win.pid });
  await sleep(800);
  const shot = await computer.RUNNERS.take_screenshot();
  return { ...shot, message: "צילום מסך של WhatsApp. קרא ממנו את ההודעות." };
}

// --- Telegram -------------------------------------------------------------

function telegramToken() {
  const token = load().telegramBotToken;
  if (!token) throw new Error("לא הוגדר Telegram bot token. הוסף אותו בהגדרות של ג'רביס.");
  return token;
}

async function telegram_send({ to, text }) {
  if (!text) throw new Error("text required");
  const cfg = load();
  const token = telegramToken();
  const contact = to ? contacts.resolve(to) : null;
  const chatId = contact?.telegram_chat_id || to || cfg.telegramDefaultChatId;
  if (!chatId) throw new Error("אין chat id. הגדר telegramDefaultChatId בהגדרות, או שמור אותו על איש קשר.");

  const { status, body } = await httpsJson(
    {
      hostname: "api.telegram.org",
      path: `/bot${token}/sendMessage`,
      method: "POST",
      headers: { "content-type": "application/json" },
    },
    { chat_id: chatId, text }
  );
  let parsed;
  try { parsed = JSON.parse(body); } catch { parsed = {}; }
  if (status !== 200 || !parsed.ok) {
    throw new Error(`Telegram שגיאה: ${parsed.description || status}`);
  }
  return `נשלח בטלגרם ל-${contact?.name || chatId}`;
}

async function telegram_read({ count = 10 } = {}) {
  const token = telegramToken();
  const { status, body } = await httpsJson({
    hostname: "api.telegram.org",
    path: `/bot${token}/getUpdates?limit=${Math.min(50, Math.max(1, Number(count) || 10))}`,
    method: "GET",
  });
  let parsed;
  try { parsed = JSON.parse(body); } catch { parsed = {}; }
  if (status !== 200 || !parsed.ok) throw new Error(`Telegram שגיאה: ${parsed.description || status}`);
  const messages = (parsed.result || [])
    .map((u) => u.message || u.edited_message)
    .filter(Boolean)
    .map((m) => ({
      from: m.from?.first_name || m.from?.username || String(m.from?.id || ""),
      chat_id: m.chat?.id,
      date: new Date((m.date || 0) * 1000).toISOString(),
      text: (m.text || "").slice(0, 2000),
    }));
  return messages.length ? messages : "אין הודעות חדשות בטלגרם.";
}

// --- Gmail ----------------------------------------------------------------

function gmailCreds() {
  const cfg = load();
  if (!cfg.gmailAddress || !cfg.gmailAppPassword) {
    throw new Error("לא הוגדר Gmail. צריך כתובת + App Password בהגדרות של ג'רביס.");
  }
  return { address: cfg.gmailAddress, password: cfg.gmailAppPassword };
}

async function gmail_send({ to, subject, body }) {
  if (!to) throw new Error("to required");
  if (!body) throw new Error("body required");
  const { address, password } = gmailCreds();

  const contact = contacts.resolve(to);
  const recipient = contact?.email || to;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
    throw new Error(`"${to}" הוא לא כתובת מייל תקינה ואין לי מייל שמור עבורו.`);
  }

  let nodemailer;
  try {
    nodemailer = require("nodemailer");
  } catch {
    throw new Error("חסרה החבילה nodemailer. הרץ npm install בתיקיית desktop.");
  }

  const transport = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: address, pass: password },
  });
  await transport.sendMail({
    from: address,
    to: recipient,
    subject: subject || "(ללא נושא)",
    text: body,
  });
  return `נשלח מייל ל-${recipient}`;
}

// Gmail's Atom feed gives unread senders and subjects over plain HTTPS basic
// auth — no extra dependency and no OAuth flow.
async function gmail_read({ count = 10 } = {}) {
  const { address, password } = gmailCreds();
  const auth = Buffer.from(`${address}:${password}`).toString("base64");
  const { status, body } = await httpsJson({
    hostname: "mail.google.com",
    path: "/mail/feed/atom",
    method: "GET",
    headers: { Authorization: `Basic ${auth}` },
  });
  if (status === 401) throw new Error("Gmail דחה את הסיסמה. ודא שזה App Password ולא סיסמת החשבון.");
  if (status !== 200) throw new Error(`Gmail שגיאה: ${status}`);

  const entries = [...body.matchAll(/<entry>([\s\S]*?)<\/entry>/g)]
    .slice(0, Math.min(25, Math.max(1, Number(count) || 10)))
    .map((m) => {
      const chunk = m[1];
      const pick = (tag) => (chunk.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)) || [, ""])[1].trim();
      return {
        subject: pick("title").slice(0, 300),
        from: pick("name"),
        email: pick("email"),
        summary: pick("summary").slice(0, 500),
      };
    });
  const total = (body.match(/<fullcount>(\d+)<\/fullcount>/) || [, "0"])[1];
  return entries.length ? { unread_total: Number(total), messages: entries } : "אין מיילים שלא נקראו.";
}

const DEFS = [
  { name: "whatsapp_send", description: "Send a WhatsApp message. Opens the chat with the text pre-filled and presses send. Give a saved contact name or a phone number.", input_schema: { type: "object", properties: { to: { type: "string", description: "Contact name or phone number" }, text: { type: "string" } }, required: ["to", "text"] } },
  { name: "whatsapp_read", description: "Look at the open WhatsApp window and read the messages on screen", input_schema: { type: "object", properties: {}, required: [] } },
  { name: "telegram_send", description: "Send a Telegram message via the bot", input_schema: { type: "object", properties: { to: { type: "string", description: "Contact name or chat id; defaults to the configured chat" }, text: { type: "string" } }, required: ["text"] } },
  { name: "telegram_read", description: "Read recent messages sent to the Telegram bot", input_schema: { type: "object", properties: { count: { type: "integer" } }, required: [] } },
  { name: "gmail_send", description: "Send an email from the configured Gmail account", input_schema: { type: "object", properties: { to: { type: "string", description: "Contact name or email address" }, subject: { type: "string" }, body: { type: "string" } }, required: ["to", "body"] } },
  { name: "gmail_read", description: "List unread Gmail messages (sender and subject)", input_schema: { type: "object", properties: { count: { type: "integer" } }, required: [] } },
];

const RUNNERS = {
  whatsapp_send, whatsapp_read,
  telegram_send, telegram_read,
  gmail_send, gmail_read,
};

const ACTION_TYPES = {
  whatsapp_send: "send_message",
  whatsapp_read: "read_messages",
  telegram_send: "send_message",
  telegram_read: "read_messages",
  gmail_send: "send_email",
  gmail_read: "read_messages",
};

module.exports = { DEFS, RUNNERS, ACTION_TYPES };
