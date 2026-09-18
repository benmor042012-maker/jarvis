// WhatsApp without a provider: the chat opens with the message typed, and the
// person presses Send. Nothing is sent by JARVIS, and the tool says so.
const test = require("node:test");
const assert = require("node:assert/strict");
const { isolate } = require("./helpers");
isolate();

const config = require("../src/core/config");
const messaging = require("../src/core/tools/messaging");
const apps = require("../src/core/tools/apps");
const { rulePlan } = require("../src/core/planner/rules");

test("phone numbers are normalised the way wa.me wants them", () => {
  assert.equal(messaging.normalizeNumber("050-123-4567"), "972501234567");
  assert.equal(messaging.normalizeNumber("+972 50 123 4567"), "972501234567");
  assert.equal(messaging.normalizeNumber("0044 20 7946 0958"), "442079460958");
  assert.equal(messaging.normalizeNumber("12"), null);
  assert.equal(messaging.normalizeNumber("hello"), null);
});

test("a contact name resolves through Settings → Contacts, and a stranger is refused with the way to add them", () => {
  config.reset();
  const cfg = config.update({ contacts: [{ name: "אמא", phone: "050-000-0000" }, { name: "", phone: "1" }] });
  assert.deepEqual(cfg.contacts, [{ name: "אמא", phone: "050-000-0000" }], "blank rows are dropped");
  assert.deepEqual(messaging.resolveRecipient("אמא", cfg), { name: "אמא", number: "972500000000" });
  assert.deepEqual(messaging.resolveRecipient("0521112222", cfg), { name: null, number: "972521112222" });
  assert.throws(() => messaging.resolveRecipient("דנה", cfg), /don't have a number for "דנה".*אמא.*Settings → Contacts/);
  assert.throws(() => config.update({ contacts: [{ name: "x", phone: "not a number" }] }), /does not look like a phone number/);
});

test("the tool opens wa.me with the text typed and never claims to have sent", async () => {
  const tool = messaging.tools.find((t) => t.name === "open_chat_draft");
  const opened = [];
  const real = apps.openWithDefault;
  // openWithDefault is looked up on the module at call time in messaging.js
  // only if destructured lazily; it is not, so stub the launcher underneath.
  const procs = require("../src/core/procs");
  const realLaunch = procs.launch;
  procs.launch = (file, args) => { opened.push([file, ...args].join(" ")); return { pid: 1 }; };
  try {
    const cfg = { contacts: [{ name: "Dana", phone: "0501234567" }] };
    const out = await tool.run({ to: "Dana", text: "running late, 10 min" }, { cfg });
    assert.equal(out.ok, true);
    assert.equal(out.data.sent, false);
    assert.match(out.summary, /Nothing was sent/);
    assert.equal(opened.length, 1);
    assert.match(opened[0], /https:\/\/wa\.me\/972501234567\?text=running%20late%2C%2010%20min/);
    // The log never sees the words or the number.
    assert.deepEqual(tool.redact({ to: "Dana", text: "secret" }), { to: "[contact]", chars: 6 });
  } finally {
    procs.launch = realLaunch;
    assert.equal(apps.openWithDefault, real);
  }
});

test("the rule planner turns Hebrew and English requests into a draft, never a send", () => {
  for (const [text, to, msg] of [
    ["שלח וואטסאפ לאמא שאני מאחר", "אמא", "אני מאחר"],
    ["תשלח הודעה בוואטסאפ ל0501234567: מגיע בעוד 10 דקות", "0501234567", "מגיע בעוד 10 דקות"],
    ["send whatsapp to Dana saying running late", "Dana", "running late"],
  ]) {
    const p = rulePlan(text, { language: "he" });
    assert.equal(p.actions[0].tool, "open_chat_draft", text);
    assert.deepEqual(p.actions[0].params, { to, text: msg }, text);
    assert.match(p.message, /לוחץ שלח|press Send/);
  }
});
