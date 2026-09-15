// Customer communication — DRAFT ONLY. NOTHING IS SENT.
// Drafts are stored locally, can be copied or exported, and carry the intended
// recipient, purpose, attachments and timing so a human can send them through
// whatever channel they choose. Opt-out, duplicate prevention, a rate-limit
// simulation and a redacted audit trail are all local.
const fs = require("fs");
const path = require("path");
const paths = require("./paths");
const audit = require("./audit");
const { uuid, nowMs, sha256, userError } = require("./util");
const local = require("./planner/local-model");

const LABEL = "DRAFT ONLY — NOTHING IS SENT";
const RATE_PER_HOUR_PER_RECIPIENT = 3;
const DUPLICATE_WINDOW_MS = 24 * 3600 * 1000;

const TEMPLATES = {
  follow_up: {
    title: { he: "מעקב אחרי הצעת מחיר", en: "Quote follow-up" },
    he: "שלום {name},\nרציתי לוודא שקיבלת את הצעת המחיר ששלחתי{topic}. אשמח לענות על כל שאלה ולהתקדם כשנוח לך.\n{signature}",
    en: "Hi {name},\nI wanted to make sure you received the quote I sent{topic}. Happy to answer any questions and move forward whenever it suits you.\n{signature}",
  },
  appointment: {
    title: { he: "תזכורת לפגישה", en: "Appointment reminder" },
    he: "שלום {name},\nתזכורת לפגישה שלנו{topic}. אם צריך לשנות את המועד, ספר לי ונמצא זמן אחר.\n{signature}",
    en: "Hi {name},\nA quick reminder about our appointment{topic}. If you need to reschedule, let me know and we'll find another time.\n{signature}",
  },
  invoice: {
    title: { he: "תזכורת תשלום", en: "Payment reminder" },
    he: "שלום {name},\nמצורפת תזכורת עדינה לחשבונית{topic}. אם התשלום כבר בוצע, תודה והתעלם מהודעה זו.\n{signature}",
    en: "Hi {name},\nA gentle reminder about the invoice{topic}. If you've already paid, thank you and please ignore this message.\n{signature}",
  },
  thanks: {
    title: { he: "תודה", en: "Thank you" },
    he: "שלום {name},\nתודה רבה{topic}. היה לי לעונג לעבוד איתך, ואשמח לעזור שוב בעתיד.\n{signature}",
    en: "Hi {name},\nThank you very much{topic}. It was a pleasure working with you, and I'd be glad to help again.\n{signature}",
  },
  delay: {
    title: { he: "התנצלות על עיכוב", en: "Delay apology" },
    he: "שלום {name},\nמצטער על העיכוב{topic}. אני מטפל בזה ואעדכן אותך ברגע שיהיה חדש.\n{signature}",
    en: "Hi {name},\nSorry for the delay{topic}. I'm on it and will update you as soon as there is news.\n{signature}",
  },
  custom: { title: { he: "הודעה חופשית", en: "Custom message" }, he: "{body}", en: "{body}" },
};

function loadAll() { return paths.readJson(path.join(paths.DRAFTS, "index.json"), []); }
function saveAll(list) { paths.writeJson(path.join(paths.DRAFTS, "index.json"), list); }
function loadOptOut() { return paths.readJson(paths.OPTOUT, []); }
function saveOptOut(list) { paths.writeJson(paths.OPTOUT, list); }

function normRecipient(r) { return String(r || "").trim().toLowerCase(); }
function recipientTag(r) { const n = normRecipient(r); return n ? `${n.slice(0, 2)}…${sha256(n).slice(0, 6)}` : ""; }

function render(template, lang, vars) {
  const t = TEMPLATES[template] || TEMPLATES.custom;
  const text = t[lang === "en" ? "en" : "he"];
  const sig = [vars.senderName, vars.businessName].filter(Boolean).join(", ");
  return text
    .replace("{name}", vars.name || (lang === "en" ? "there" : ""))
    .replace("{topic}", vars.topic ? (lang === "en" ? ` regarding ${vars.topic}` : ` בנוגע ל${vars.topic}`) : "")
    .replace("{signature}", sig ? (lang === "en" ? `Best regards,\n${sig}` : `בברכה,\n${sig}`) : "")
    .replace("{body}", vars.body || "")
    .replace(/\n{3,}/g, "\n\n").trim();
}

function tone(text, style, lang) {
  // Deterministic tone helpers when no local model is installed.
  if (style === "formal") return lang === "en" ? text.replace(/^Hi\b/m, "Dear").replace(/\bI'm\b/g, "I am").replace(/\bwe'll\b/g, "we will").replace(/\byou've\b/g, "you have") : text.replace(/^שלום\b/m, "שלום רב,").replace(/^היי\b/m, "שלום רב,");
  if (style === "friendly") return lang === "en" ? text.replace(/^Dear\b/m, "Hi").replace(/Best regards,/, "Thanks a lot,") : text.replace(/^שלום רב,?/m, "היי").replace(/בברכה,/, "תודה רבה,");
  if (style === "short") return text.split("\n").filter((l) => l.trim()).slice(0, 3).join("\n");
  return text;
}

class Drafts {
  constructor({ getConfig }) { this.getConfig = getConfig; }

  templates(lang) { return Object.entries(TEMPLATES).map(([id, t]) => ({ id, title: t.title[lang === "en" ? "en" : "he"] })); }

  checks({ recipient, purpose }) {
    const rec = normRecipient(recipient);
    const list = loadAll();
    const now = nowMs();
    const warnings = [];
    if (rec && loadOptOut().includes(rec)) warnings.push({ code: "opted_out", text: "This recipient asked not to be contacted (opt-out list)." });
    const same = list.filter((d) => normRecipient(d.recipient) === rec && rec);
    if (same.some((d) => d.purpose === purpose && now - d.created_at < DUPLICATE_WINDOW_MS)) warnings.push({ code: "duplicate", text: "A draft with the same purpose for this recipient was created in the last 24 hours." });
    if (same.filter((d) => now - d.created_at < 3600000).length >= RATE_PER_HOUR_PER_RECIPIENT) warnings.push({ code: "rate_limit", text: `Rate-limit simulation: more than ${RATE_PER_HOUR_PER_RECIPIENT} drafts per hour for one recipient.` });
    return warnings;
  }

  async create({ recipient = "", purpose = "custom", language = "he", name = "", topic = "", body = "", style = "", timing = "", attachments = [], improve = false, translate_to = "" }, { device, signal } = {}) {
    const cfg = this.getConfig();
    const lang = language === "en" ? "en" : "he";
    if (!TEMPLATES[purpose]) purpose = "custom";
    if (purpose === "custom" && !body.trim()) throw userError("A message body is required for a custom draft.");
    let text = render(purpose, lang, { name, topic, body, senderName: cfg.drafts.senderName, businessName: cfg.drafts.businessName });
    let modelUsed = null;
    const unavailable = [];
    if (style) text = tone(text, style, lang);
    if (improve || translate_to) {
      const resolved = await local.resolve(cfg);
      if (resolved.provider === "mock") {
        unavailable.push(translate_to ? "Translation needs a local model (Ollama/LocalAI); none is installed, so the draft is left in its original language." : "Tone improvement with a local model is unavailable (no local model installed); deterministic tone rules were applied.");
      } else {
        try {
          const instr = translate_to ? `Translate the following message to ${translate_to === "en" ? "English" : "Hebrew"}, keeping names and numbers exact. Output only the message.` : `Improve the tone of this customer message (${style || "polite, clear"}), keep it short, keep all facts identical. Output only the message.`;
          const out = await local.generate(cfg, resolved, "You edit business messages. Output only the final message text.", `${instr}\n\n${text}`, { signal });
          if (out.trim()) { text = out.trim(); modelUsed = `${resolved.provider}:${resolved.model}`; }
        } catch (e) { unavailable.push(`Local model failed: ${e.message.slice(0, 120)}`); }
      }
    }
    const warnings = this.checks({ recipient, purpose });
    const draft = {
      id: uuid(), created_at: nowMs(), recipient, purpose, language: translate_to || lang, text, timing, attachments: attachments.filter((a) => typeof a === "string").slice(0, 10),
      style, model: modelUsed, warnings, notes: unavailable, reviewed: false, exported_path: null, label: LABEL, device: device?.name || null,
    };
    const list = loadAll();
    list.push(draft);
    saveAll(list.slice(-500));
    audit.log({ event: "draft_created", device: device?.name, detail: { id: draft.id, recipient: recipientTag(recipient), purpose, chars: text.length, warnings: warnings.map((w) => w.code), model: modelUsed } });
    return draft;
  }

  list() { return loadAll().slice().reverse(); }
  get(id) { return loadAll().find((d) => d.id === id) || null; }

  update(id, { text, reviewed, timing }) {
    const list = loadAll();
    const d = list.find((x) => x.id === id);
    if (!d) return null;
    if (typeof text === "string") d.text = text.slice(0, 20000);
    if (typeof reviewed === "boolean") d.reviewed = reviewed;
    if (typeof timing === "string") d.timing = timing.slice(0, 200);
    saveAll(list);
    audit.log({ event: "draft_updated", detail: { id, reviewed: d.reviewed } });
    return d;
  }

  remove(id) {
    const list = loadAll();
    const next = list.filter((d) => d.id !== id);
    saveAll(next);
    audit.log({ event: "draft_deleted", detail: { id } });
    return next.length !== list.length;
  }

  exportDraft(id) {
    const d = this.get(id);
    if (!d) return null;
    fs.mkdirSync(paths.DRAFTS, { recursive: true });
    const file = path.join(paths.DRAFTS, `draft-${d.id.slice(0, 8)}.txt`);
    const head = [LABEL, `Recipient: ${d.recipient || "(none)"}`, `Purpose: ${d.purpose}`, `Timing: ${d.timing || "(unspecified)"}`, `Attachments: ${d.attachments.join(", ") || "(none)"}`, `Created: ${new Date(d.created_at).toISOString()}`, "", ""].join("\n");
    fs.writeFileSync(file, head + d.text + "\n", "utf8");
    this.update(id, {});
    const list = loadAll();
    const x = list.find((y) => y.id === id);
    x.exported_path = file;
    saveAll(list);
    audit.log({ event: "draft_exported", detail: { id, file } });
    return file;
  }

  optOut() { return loadOptOut(); }
  addOptOut(recipient) { const l = loadOptOut(); const n = normRecipient(recipient); if (n && !l.includes(n)) { l.push(n); saveOptOut(l); } audit.log({ event: "optout_added", detail: { recipient: recipientTag(n) } }); return l; }
  removeOptOut(recipient) { const n = normRecipient(recipient); const l = loadOptOut().filter((x) => x !== n); saveOptOut(l); return l; }
}

module.exports = { Drafts, TEMPLATES, LABEL, render, tone };
