// Important-customer alerts.
//
// Customer records live in ~/.jarvis/customers.json and never leave the
// computer. Urgency is scored by deterministic rules — keywords, deadlines,
// unanswered time, sentiment words, manual priority — so alerting keeps working
// with no model installed and in offline mode.
//
// Alerts reach you through the JARVIS window, a Windows notification, a local
// sound, speech, and (over your own Wi-Fi only) a paired phone. There is no
// Telegram, WhatsApp, SMS, email, Firebase, APNs, cloud relay or paid provider
// anywhere in this file: nothing is ever sent outside your network.
const EventEmitter = require("events");
const path = require("path");

const paths = require("./paths");
const audit = require("./audit");
const { uuid, nowMs, sha256 } = require("./util");
const { inQuietHours } = require("./voice/session");

const LABEL = "LOCAL WI-FI ALERTS — NO EXTERNAL MESSAGES";

const CUSTOMERS_FILE = path.join(paths.HOME, "customers.json");
const ALERTS_FILE = path.join(paths.HOME, "alerts.json");

// Deterministic signals. Each adds to a score; URGENT_AT or more raises an
// alert. A single decisive signal — the customer wrote "urgent", made a
// complaint, threatened to cancel, or a deadline has passed — is enough on its
// own; the softer ones have to combine before they interrupt you.
const URGENT_AT = 60;

const KEYWORDS = [
  { weight: 60, code: "urgent", he: ["דחוף", "בהול", "מיידי", "מיד", "חירום"], en: ["urgent", "asap", "immediately", "emergency", "critical"] },
  { weight: 60, code: "complaint", he: ["תלונה", "מתלונן", "מאוכזב", "לא מרוצה", "גרוע", "נורא", "בושה", "אסון"], en: ["complaint", "disappointed", "unacceptable", "terrible", "awful", "furious"] },
  { weight: 60, code: "cancel", he: ["מבטל", "לבטל", "ביטול", "עוזב", "מפסיק"], en: ["cancel", "refund", "leaving", "terminate"] },
  { weight: 70, code: "legal", he: ["עורך דין", "תביעה", "משפטי", "צרכנות"], en: ["lawyer", "legal", "lawsuit", "sue"] },
  { weight: 20, code: "waiting", he: ["מחכה", "ממתין", "עדיין לא", "לא חזרתם", "לא קיבלתי"], en: ["still waiting", "no response", "never heard", "following up again"] },
  { weight: 15, code: "negative", he: ["בעיה", "תקלה", "לא עובד", "נשבר", "טעות"], en: ["problem", "issue", "broken", "not working", "mistake"] },
];

const POSITIVE = { he: ["תודה", "מעולה", "מרוצה", "מושלם", "אלוף"], en: ["thanks", "thank you", "great", "perfect", "excellent"] };

const REASONS = {
  keyword: "urgent wording",
  deadline_missed: "a deadline has passed",
  deadline_soon: "a deadline is close",
  unanswered: "waiting for an answer",
  manual: "you marked this customer as a priority",
  sentiment: "the message sounds unhappy",
};

function loadCustomers() {
  return paths.readJson(CUSTOMERS_FILE, []);
}
function saveCustomers(list) {
  paths.writeJson(CUSTOMERS_FILE, list);
}
function loadAlerts() {
  return paths.readJson(ALERTS_FILE, []);
}
function saveAlerts(list) {
  paths.writeJson(ALERTS_FILE, list);
}

/** A stable, non-identifying tag for the audit log. */
function tag(name) {
  const n = String(name || "").trim().toLowerCase();
  return n ? `${n.slice(0, 2)}…${sha256(n).slice(0, 6)}` : "";
}

function hasAny(text, list) {
  const t = String(text || "").toLowerCase();
  return list.some((w) => t.includes(String(w).toLowerCase()));
}

/**
 * Score one customer record. Pure and deterministic: no model, no network.
 * Returns { score, urgent, signals: [{code, weight, why}] }.
 */
function scoreCustomer(c, now = Date.now()) {
  const signals = [];
  const text = [c.note, c.lastMessage, c.subject].filter(Boolean).join(" \n ");

  for (const k of KEYWORDS) {
    if (hasAny(text, [...k.he, ...k.en])) signals.push({ code: k.code, weight: k.weight, why: REASONS.keyword });
  }

  if (c.deadline) {
    const due = Date.parse(c.deadline);
    if (Number.isFinite(due)) {
      const hoursLeft = (due - now) / 3600000;
      if (hoursLeft < 0) signals.push({ code: "deadline_missed", weight: 60, why: REASONS.deadline_missed, hours: Math.round(-hoursLeft) });
      else if (hoursLeft <= 24) signals.push({ code: "deadline_soon", weight: 30, why: REASONS.deadline_soon, hours: Math.round(hoursLeft) });
    }
  }

  if (c.waitingSince && !c.answered) {
    const since = Date.parse(c.waitingSince);
    if (Number.isFinite(since)) {
      const hours = (now - since) / 3600000;
      if (hours >= 48) signals.push({ code: "unanswered", weight: 60, why: REASONS.unanswered, hours: Math.round(hours) });
      else if (hours >= 24) signals.push({ code: "unanswered", weight: 25, why: REASONS.unanswered, hours: Math.round(hours) });
    }
  }

  if (c.priority === "high") signals.push({ code: "manual", weight: 60, why: REASONS.manual });

  const positive = hasAny(text, [...POSITIVE.he, ...POSITIVE.en]);
  if (positive && signals.every((s) => s.code !== "complaint")) signals.push({ code: "positive", weight: -20, why: "the message also sounds positive" });

  const score = Math.max(0, Math.min(100, signals.reduce((a, s) => a + s.weight, 0)));
  return { score, urgent: score >= URGENT_AT, signals: signals.filter((s) => s.weight > 0) };
}

class Alerts extends EventEmitter {
  constructor({ getConfig, host = {} }) {
    super();
    this.getConfig = getConfig;
    this.host = host; // { notify(title, body), speak(text), sound(), onAlert(alert) }
    this.timer = null;
  }

  cfg() {
    return this.getConfig().alerts || {};
  }

  start() {
    this.stop();
    const every = Math.max(30000, this.cfg().scanIntervalMs || 120000);
    this.timer = setInterval(() => this.scan().catch(() => undefined), every);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // --- customers ---------------------------------------------------------
  customers() {
    return loadCustomers().map((c) => ({ ...c, ...scoreCustomer(c) }));
  }

  upsertCustomer(input, { device } = {}) {
    const list = loadCustomers();
    const id = String(input.id || "").trim() || uuid();
    const existing = list.find((c) => c.id === id);
    const record = {
      id,
      name: String(input.name ?? existing?.name ?? "").slice(0, 120),
      contact: String(input.contact ?? existing?.contact ?? "").slice(0, 200),
      phone: String(input.phone ?? existing?.phone ?? "").slice(0, 40),
      subject: String(input.subject ?? existing?.subject ?? "").slice(0, 300),
      note: String(input.note ?? existing?.note ?? "").slice(0, 4000),
      lastMessage: String(input.lastMessage ?? existing?.lastMessage ?? "").slice(0, 4000),
      priority: ["normal", "high"].includes(input.priority) ? input.priority : existing?.priority || "normal",
      deadline: String(input.deadline ?? existing?.deadline ?? "").slice(0, 40),
      waitingSince: String(input.waitingSince ?? existing?.waitingSince ?? "").slice(0, 40),
      answered: input.answered !== undefined ? !!input.answered : !!existing?.answered,
      created_at: existing?.created_at || nowMs(),
      updated_at: nowMs(),
    };
    if (!record.name.trim()) throw Object.assign(new Error("A customer needs a name."), { status: 400 });
    const next = existing ? list.map((c) => (c.id === id ? record : c)) : [...list, record];
    saveCustomers(next.slice(-1000));
    audit.log({ event: existing ? "customer_updated" : "customer_added", device: device?.name, detail: { customer: tag(record.name), priority: record.priority } });
    return { ...record, ...scoreCustomer(record) };
  }

  removeCustomer(id, { device } = {}) {
    const list = loadCustomers();
    const next = list.filter((c) => c.id !== id);
    saveCustomers(next);
    audit.log({ event: "customer_removed", device: device?.name, detail: { removed: next.length !== list.length } });
    return next.length !== list.length;
  }

  // --- alerts ------------------------------------------------------------
  list({ includeResolved = false, limit = 100 } = {}) {
    const all = loadAlerts();
    const open = includeResolved ? all : all.filter((a) => a.status === "open" || (a.status === "snoozed" && a.snooze_until <= nowMs()));
    return open.slice(-limit).reverse();
  }

  history(limit = 200) {
    return loadAlerts().slice(-limit).reverse();
  }

  /** Re-evaluate every customer and raise alerts for the urgent ones. */
  async scan({ device, force = false } = {}) {
    const cfg = this.getConfig();
    if (!cfg.alerts?.enabled && !force) return { raised: [], scanned: 0, skipped: "alerts_disabled" };
    const customers = loadCustomers();
    const existing = loadAlerts();
    const raised = [];
    for (const c of customers) {
      const { score, urgent, signals } = scoreCustomer(c);
      if (!urgent) continue;
      // One open alert per customer per signal set: re-raising the same thing
      // every two minutes would be noise, not an alert.
      const fingerprint = sha256(`${c.id}:${signals.map((s) => s.code).sort().join(",")}`);
      const already = existing.find((a) => a.fingerprint === fingerprint && (a.status === "open" || a.status === "snoozed" || (a.status === "acknowledged" && nowMs() - a.acknowledged_at < 12 * 3600000)));
      if (already) continue;
      raised.push(this._raise(c, { score, signals, fingerprint }, { device }));
    }
    return { raised, scanned: customers.length };
  }

  _raise(customer, { score, signals, fingerprint }, { device } = {}) {
    const cfg = this.getConfig();
    const quiet = inQuietHours(cfg.alerts?.quietHours);
    const alert = {
      id: uuid(),
      created_at: nowMs(),
      customer_id: customer.id,
      customer_name: customer.name,
      // Deliberately short: the full note is shown on screen, never spoken.
      headline: signals.map((s) => s.why).join("; "),
      score,
      signals,
      fingerprint,
      status: "open",
      acknowledged_at: null,
      snooze_until: 0,
      attempts: 0,
      last_attempt_at: null,
      delivered: { window: false, notification: false, sound: false, speech: false, phone: 0 },
      quiet_hours: quiet,
      label: LABEL,
    };
    const all = loadAlerts();
    all.push(alert);
    saveAlerts(all.slice(-500));
    audit.log({ event: "alert_raised", detail: { customer: tag(customer.name), score, signals: signals.map((s) => s.code), quiet_hours: quiet } });
    this._deliver(alert, { quiet });
    return alert;
  }

  /** Raise an alert by hand, e.g. from a voice command or the UI. */
  raiseManual({ customer_id, headline }, { device } = {}) {
    const c = loadCustomers().find((x) => x.id === customer_id);
    if (!c) throw Object.assign(new Error("Unknown customer."), { status: 404 });
    return this._raise(c, { score: 100, signals: [{ code: "manual", weight: 60, why: headline || REASONS.manual }], fingerprint: sha256(`${c.id}:manual:${nowMs()}`) }, { device });
  }

  _deliver(alert, { quiet }) {
    const cfg = this.getConfig();
    const a = cfg.alerts || {};
    const channels = a.channels || {};
    const delivered = alert.delivered;

    // On screen always: the window is where the full detail lives.
    delivered.window = true;
    this.emit("event", { type: "alert", alert });

    if (quiet) {
      // Quiet hours suppress noise, not the alert itself.
      audit.log({ event: "alert_quiet_hours", detail: { alert: alert.id } });
    } else {
      if (channels.notification !== false && typeof this.host.notify === "function") {
        try {
          this.host.notify(`JARVIS — ${alert.customer_name}`, alert.headline);
          delivered.notification = true;
        } catch { /* the window may be gone */ }
      }
      if (channels.sound !== false && typeof this.host.sound === "function") {
        try { this.host.sound(); delivered.sound = true; } catch { /* no audio device */ }
      }
      if (channels.speech && typeof this.host.speak === "function") {
        // Never the note, never the contact details — just who and why.
        try { this.host.speak(this._spokenText(alert)); delivered.speech = true; } catch { /* no voice */ }
      }
      if (channels.phone !== false && typeof this.host.phones === "function") {
        // The alert has already gone out on the local event stream above; this
        // records how many paired phones on your Wi-Fi were holding it open.
        try { delivered.phone = this.host.phones() || 0; } catch { delivered.phone = 0; }
      }
    }
    this._persist(alert);
  }

  /** What may be said out loud. Private detail stays on screen. */
  _spokenText(alert) {
    const cfg = this.getConfig();
    const he = (cfg.language || "he") === "he";
    const full = cfg.alerts?.speakDetails === true;
    if (!full) return he ? `שים לב, לקוח דורש תשומת לב: ${alert.customer_name}.` : `Attention: a customer needs you — ${alert.customer_name}.`;
    return he ? `שים לב: ${alert.customer_name}. ${alert.headline}.` : `Attention: ${alert.customer_name}. ${alert.headline}.`;
  }

  _persist(alert) {
    const all = loadAlerts();
    const i = all.findIndex((a) => a.id === alert.id);
    if (i >= 0) all[i] = alert;
    saveAlerts(all);
  }

  _update(id, patch, event, device) {
    const all = loadAlerts();
    const a = all.find((x) => x.id === id);
    if (!a) return null;
    Object.assign(a, patch);
    saveAlerts(all);
    audit.log({ event, device: device?.name, detail: { alert: id } });
    this.emit("event", { type: "alert", alert: a });
    return a;
  }

  acknowledge(id, { device } = {}) {
    return this._update(id, { status: "acknowledged", acknowledged_at: nowMs(), snooze_until: 0 }, "alert_acknowledged", device);
  }

  snooze(id, minutes, { device } = {}) {
    const m = Math.max(1, Math.min(24 * 60, Number(minutes) || 15));
    return this._update(id, { status: "snoozed", snooze_until: nowMs() + m * 60000 }, "alert_snoozed", device);
  }

  resolve(id, { device } = {}) {
    return this._update(id, { status: "resolved", snooze_until: 0 }, "alert_resolved", device);
  }

  /** Deliver an open alert again — the user pressing "retry". */
  retry(id, { device } = {}) {
    const all = loadAlerts();
    const a = all.find((x) => x.id === id);
    if (!a) return null;
    a.attempts++;
    a.last_attempt_at = nowMs();
    a.status = "open";
    a.snooze_until = 0;
    saveAlerts(all);
    audit.log({ event: "alert_retried", device: device?.name, detail: { alert: id, attempts: a.attempts } });
    this._deliver(a, { quiet: inQuietHours(this.getConfig().alerts?.quietHours) });
    return a;
  }

  /** Alerts whose snooze expired, so the UI and the phone can ring again. */
  due() {
    return loadAlerts().filter((a) => a.status === "snoozed" && a.snooze_until && a.snooze_until <= nowMs());
  }

  wakeSnoozed() {
    const due = this.due();
    for (const a of due) this.retry(a.id);
    return due.length;
  }

  deleteAll() {
    const n = loadAlerts().length;
    saveAlerts([]);
    audit.log({ event: "alerts_deleted", detail: { removed: n } });
    return n;
  }
}

module.exports = { Alerts, scoreCustomer, LABEL, CUSTOMERS_FILE, ALERTS_FILE, KEYWORDS, URGENT_AT, tag };
