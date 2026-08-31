const fs = require("fs");
const path = require("path");
const { JARVIS_HOME } = require("./config");

const CONTACTS_PATH = path.join(JARVIS_HOME, "contacts.json");

// Ported from the web page (index.html): Israeli numbers by default.
// "0501234567" -> "972501234567", "+972-50-123" and "00972..." also work.
function waNumber(raw) {
  let d = String(raw || "").replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  else if (d.startsWith("0")) d = "972" + d.slice(1);
  return d;
}

function loadAll() {
  try {
    return JSON.parse(fs.readFileSync(CONTACTS_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveAll(all) {
  fs.mkdirSync(path.dirname(CONTACTS_PATH), { recursive: true });
  fs.writeFileSync(CONTACTS_PATH, JSON.stringify(all, null, 2), "utf8");
}

function normalize(s) {
  return String(s || "").trim().toLowerCase().replace(/^ל/, "");
}

// Exact match first, then prefix, then substring — Hebrew names arrive from
// speech with prefixes like "לאבא" attached.
function resolve(name) {
  const all = loadAll();
  const want = normalize(name);
  if (!want) return null;
  const keys = Object.keys(all);
  const exact = keys.find((k) => normalize(k) === want);
  if (exact) return { name: exact, ...all[exact] };
  const prefix = keys.find((k) => normalize(k).startsWith(want) || want.startsWith(normalize(k)));
  if (prefix) return { name: prefix, ...all[prefix] };
  const sub = keys.find((k) => normalize(k).includes(want) || want.includes(normalize(k)));
  return sub ? { name: sub, ...all[sub] } : null;
}

async function contact_list() {
  const all = loadAll();
  const names = Object.keys(all);
  if (!names.length) return "אין אנשי קשר שמורים. אפשר להוסיף עם contact_save.";
  return names.map((n) => ({ name: n, ...all[n] }));
}

async function contact_save({ name, phone, email, telegram_chat_id }) {
  if (!name) throw new Error("name required");
  const all = loadAll();
  const existing = all[name] || {};
  all[name] = {
    ...existing,
    ...(phone ? { phone } : {}),
    ...(email ? { email } : {}),
    ...(telegram_chat_id ? { telegram_chat_id } : {}),
  };
  saveAll(all);
  return `נשמר: ${name}`;
}

const DEFS = [
  { name: "contact_list", description: "List saved contacts and their phone/email", input_schema: { type: "object", properties: {}, required: [] } },
  { name: "contact_save", description: "Save or update a contact's phone, email or telegram chat id", input_schema: { type: "object", properties: { name: { type: "string" }, phone: { type: "string" }, email: { type: "string" }, telegram_chat_id: { type: "string" } }, required: ["name"] } },
];

const RUNNERS = { contact_list, contact_save };

const ACTION_TYPES = {
  contact_list: "contact_list",
  contact_save: "contact_save",
};

module.exports = { DEFS, RUNNERS, ACTION_TYPES, resolve, waNumber, loadAll, saveAll, CONTACTS_PATH };
