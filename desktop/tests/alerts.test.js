// Customer alerts: deterministic urgency scoring (no model, works offline),
// the alert lifecycle, quiet hours, and the promise that nothing is sent out.
const test = require("node:test");
const assert = require("node:assert/strict");
const { isolate } = require("./helpers");
isolate();

const config = require("../src/core/config");
const { Alerts, scoreCustomer, LABEL } = require("../src/core/alerts");

const delivered = { notify: [], sound: 0, speak: [] };

// Customers and alerts live in files under the shared test home, so each test
// starts from an empty store rather than inheriting the previous one's.
function resetStore() {
  const paths = require("../src/core/paths");
  const { CUSTOMERS_FILE, ALERTS_FILE } = require("../src/core/alerts");
  paths.writeJson(CUSTOMERS_FILE, []);
  paths.writeJson(ALERTS_FILE, []);
}

function makeAlerts(overrides = {}) {
  resetStore();
  config.reset();
  const cfg = config.update({
    alerts: { enabled: true, channels: { notification: true, sound: true, speech: true, phone: true }, speakDetails: false, quietHours: { enabled: false, start: "22:00", end: "07:00" }, ...overrides },
  });
  delivered.notify = [];
  delivered.sound = 0;
  delivered.speak = [];
  return new Alerts({
    getConfig: () => cfg,
    host: {
      notify: (t, b) => delivered.notify.push({ t, b }),
      sound: () => { delivered.sound++; },
      speak: (text) => delivered.speak.push(text),
    },
  });
}

const hoursAgo = (h) => new Date(Date.now() - h * 3600000).toISOString();
const hoursAhead = (h) => new Date(Date.now() + h * 3600000).toISOString();

test("urgency scoring is deterministic and needs no model", () => {
  assert.equal(scoreCustomer({ name: "a", note: "שלום, רציתי לשאול על המחיר" }).urgent, false);
  assert.ok(scoreCustomer({ name: "a", lastMessage: "זה דחוף מאוד, אני מחכה" }).urgent);
  assert.ok(scoreCustomer({ name: "a", lastMessage: "I want a refund, this is unacceptable" }).urgent);
  assert.ok(scoreCustomer({ name: "a", deadline: hoursAgo(3) }).signals.some((s) => s.code === "deadline_missed"));
  assert.ok(scoreCustomer({ name: "a", deadline: hoursAhead(5) }).signals.some((s) => s.code === "deadline_soon"));
  assert.ok(scoreCustomer({ name: "a", waitingSince: hoursAgo(72), answered: false }).signals.some((s) => s.code === "unanswered"));
  assert.ok(!scoreCustomer({ name: "a", waitingSince: hoursAgo(72), answered: true }).signals.some((s) => s.code === "unanswered"));
  assert.ok(scoreCustomer({ name: "a", priority: "high" }).signals.some((s) => s.code === "manual"));
  // The same input always scores the same — nothing random, nothing remote.
  const a = scoreCustomer({ name: "x", lastMessage: "תלונה חמורה, דחוף" });
  const b = scoreCustomer({ name: "x", lastMessage: "תלונה חמורה, דחוף" });
  assert.deepEqual(a, b);
  // Praise alone must not raise an alert.
  assert.equal(scoreCustomer({ name: "a", lastMessage: "תודה רבה, מעולה!" }).urgent, false);
});

test("a scan raises one alert per customer and does not repeat it", async () => {
  const al = makeAlerts();
  al.upsertCustomer({ name: "דנה", lastMessage: "זה דחוף, אני מחכה כבר שבוע" });
  al.upsertCustomer({ name: "רגיל", lastMessage: "תודה על השירות" });
  const first = await al.scan({ force: true });
  assert.equal(first.raised.length, 1);
  assert.equal(first.raised[0].customer_name, "דנה");
  assert.equal(first.raised[0].label, LABEL);
  const second = await al.scan({ force: true });
  assert.equal(second.raised.length, 0, "the same signals must not re-alert every scan");
  assert.equal(al.list().length, 1);
});

test("alerts reach the window, a notification, a sound and speech", async () => {
  const al = makeAlerts();
  al.upsertCustomer({ name: "אבי", lastMessage: "דחוף! לא קיבלתי תשובה" });
  const { raised } = await al.scan({ force: true });
  const a = raised[0];
  assert.equal(a.delivered.window, true);
  assert.equal(a.delivered.notification, true);
  assert.equal(a.delivered.sound, true);
  assert.equal(a.delivered.speech, true);
  assert.equal(delivered.notify.length, 1);
  assert.equal(delivered.sound, 1);
});

test("private detail is never spoken aloud by default", async () => {
  const al = makeAlerts();
  al.upsertCustomer({ name: "אבי", contact: "avi@example.com", phone: "0501234567", note: "חייב 4,500 ש\"ח, איים לעבור למתחרה", lastMessage: "דחוף" });
  await al.scan({ force: true });
  const spoken = delivered.speak.join(" ");
  assert.ok(spoken.includes("אבי"), "the name is fine to say");
  assert.ok(!spoken.includes("4,500"), "the note must not be spoken");
  assert.ok(!spoken.includes("0501234567"), "the phone must not be spoken");
  assert.ok(!spoken.includes("avi@example.com"), "the contact must not be spoken");
});

test("quiet hours stop the noise but keep the alert", async () => {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const end = String((now.getHours() + 2) % 24).padStart(2, "0");
  const al = makeAlerts({ quietHours: { enabled: true, start: `${hh}:00`, end: `${end}:00` } });
  al.upsertCustomer({ name: "לילה", lastMessage: "דחוף מאוד" });
  const { raised } = await al.scan({ force: true });
  assert.equal(raised.length, 1, "the alert is still raised");
  assert.equal(raised[0].quiet_hours, true);
  assert.equal(raised[0].delivered.window, true);
  assert.equal(raised[0].delivered.notification, false);
  assert.equal(raised[0].delivered.sound, false);
  assert.equal(delivered.speak.length, 0);
});

test("acknowledge, snooze, retry, resolve and history", async () => {
  const al = makeAlerts();
  al.upsertCustomer({ name: "יוסי", lastMessage: "תלונה דחופה" });
  const { raised } = await al.scan({ force: true });
  const id = raised[0].id;

  assert.equal(al.snooze(id, 30).status, "snoozed");
  assert.equal(al.list().length, 0, "a snoozed alert is out of the way");
  assert.equal(al.acknowledge(id).status, "acknowledged");
  const retried = al.retry(id);
  assert.equal(retried.status, "open");
  assert.equal(retried.attempts, 1);
  assert.equal(al.resolve(id).status, "resolved");
  assert.equal(al.list().length, 0);
  assert.equal(al.history().length, 1, "resolved alerts stay in the history");

  // A snooze that has expired comes back on its own.
  al.snooze(id, 1);
  const all = require("../src/core/paths").readJson(require("../src/core/alerts").ALERTS_FILE, []);
  all.find((x) => x.id === id).snooze_until = Date.now() - 1;
  require("../src/core/paths").writeJson(require("../src/core/alerts").ALERTS_FILE, all);
  assert.equal(al.due().length, 1);
  assert.equal(al.wakeSnoozed(), 1);
  assert.equal(al.list().length, 1);
});

test("a customer can be marked urgent by hand, and deleted", async () => {
  const al = makeAlerts();
  const c = al.upsertCustomer({ name: "ידני" });
  const a = al.raiseManual({ customer_id: c.id, headline: "אני רוצה שתזכיר לי" });
  assert.equal(a.customer_name, "ידני");
  assert.equal(a.score, 100);
  assert.throws(() => al.raiseManual({ customer_id: "nope" }), /Unknown customer/);
  assert.equal(al.removeCustomer(c.id), true);
  assert.equal(al.customers().length, 0);
  assert.throws(() => al.upsertCustomer({ name: "" }), /needs a name/);
});

test("nothing leaves the computer: no sending code anywhere in the alert path", () => {
  const src = require("fs").readFileSync(require("path").join(__dirname, "..", "src", "core", "alerts.js"), "utf8");
  // Comments are where the promise is written down; the code is what must be
  // free of any way to send. Strip comments, then look for one.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const forbidden of ["telegram", "whatsapp", "twilio", "sendgrid", "firebase", "fcm", "apns", "nodemailer", "smtp", "fetch(", "https.request", "http.request"]) {
    assert.ok(!code.toLowerCase().includes(forbidden.toLowerCase()), `alerts.js must not contain ${forbidden}`);
  }
  assert.equal(LABEL, "LOCAL WI-FI ALERTS — NO EXTERNAL MESSAGES");
});

test("the audit log records alerts without the customer's identity", async () => {
  const al = makeAlerts();
  al.upsertCustomer({ name: "פרטי מאוד", contact: "secret@example.com", lastMessage: "דחוף" });
  await al.scan({ force: true });
  const entries = require("../src/core/audit").read({ limit: 50 });
  const raised = entries.filter((e) => e.event === "alert_raised");
  assert.ok(raised.length >= 1);
  const text = JSON.stringify(raised);
  assert.ok(!text.includes("פרטי מאוד"), "the audit log must not carry the customer name");
  assert.ok(!text.includes("secret@example.com"));
});
