// Calls: what is genuinely possible, what is refused, and the promise that
// JARVIS never claims a call happened when it cannot know.
const test = require("node:test");
const assert = require("node:assert/strict");
const { isolate } = require("./helpers");
isolate();

const config = require("../src/core/config");
const { Phone, normalizeNumber, maskNumber, CAPABILITIES } = require("../src/core/phone");

function makePhone(overrides = {}) {
  config.reset();
  const cfg = config.update({ phone: { enabled: true, simulation: false, allowDialer: true, ...overrides } });
  return new Phone({ getConfig: () => cfg });
}

const phoneDevice = (online = true) => [{ id: "d1", name: "My Android phone", role: "remote", online, revoked: false, last_seen: Date.now() }];
const owner = { id: "o", name: "This computer", role: "owner" };

test("phone numbers are validated, never passed through as free text", () => {
  assert.equal(normalizeNumber("050-123-4567"), "0501234567");
  assert.equal(normalizeNumber("+972 50 123 4567"), "+972501234567");
  for (const bad of ["", "abc", "tel:0501234567", "05012345678901234567", "0501234567; rm -rf /", "<script>", "12"]) {
    assert.throws(() => normalizeNumber(bad), /phone number/, `should refuse ${JSON.stringify(bad)}`);
  }
  assert.equal(maskNumber("0501234567"), "050***67");
});

test("capabilities are stated honestly, with a reason for every no", () => {
  const p = makePhone();
  const caps = p.capabilities({ devices: phoneDevice() }).capabilities;
  assert.equal(caps.open_dialer_on_phone.available, true);
  for (const key of ["place_call_from_computer", "auto_dial_without_pressing", "answer_incoming_call", "answer_from_computer_over_bluetooth", "record_call_audio"]) {
    assert.equal(caps[key].available, false, `${key} must not claim to work`);
    assert.ok(caps[key].why.length > 30, `${key} must explain why`);
  }
  assert.match(caps.answer_incoming_call.one_time_step, /native/i);
  assert.equal(p.capabilities({ devices: [] }).capabilities.open_dialer_on_phone.available, false);
  assert.match(p.capabilities({ devices: [] }).capabilities.open_dialer_on_phone.blocked_because, /No phone is paired/);
});

test("a call needs explicit approval bound to the exact number", () => {
  const p = makePhone();
  const call = p.request({ to: "050-123-4567", reason: "דנה מחכה לתשובה" }, { device: owner, devices: phoneDevice() });
  assert.equal(call.status, "pending_approval");
  assert.equal(call.number, "0501234567");
  assert.equal(call.simulation, false);
  // A tampered approval is refused.
  assert.throws(() => p.decide(call.id, { decision: "approve", hash: "wrong", device: owner }), /does not match/);
  const ok = p.decide(call.id, { decision: "approve", hash: call.hash, device: owner });
  assert.equal(ok.status, "approved");
  assert.equal(ok.outcome, null, "approval is not a call");
  assert.throws(() => p.decide(call.id, { decision: "approve", hash: call.hash, device: owner }), /already/);
});

test("rejecting means nothing happens at all", () => {
  const p = makePhone();
  const call = p.request({ to: "0501234567", reason: "x" }, { device: owner, devices: phoneDevice() });
  const r = p.decide(call.id, { decision: "reject", hash: call.hash, device: owner });
  assert.equal(r.status, "rejected");
  assert.equal(r.dialer_opened_at, null);
  assert.equal(r.outcome, null);
});

test("JARVIS only ever records what the phone confirms — never 'connected'", () => {
  const p = makePhone();
  const call = p.request({ to: "0501234567", reason: "x" }, { device: owner, devices: phoneDevice() });
  p.decide(call.id, { decision: "approve", hash: call.hash, device: owner });
  const opened = p.dialerOpened(call.id, { device: { name: "My Android phone" } });
  assert.equal(opened.status, "dialer_opened");
  assert.equal(opened.outcome, "unknown");
  assert.match(opened.outcome_note, /does not tell a web page/);
  const statuses = p.list().map((c) => c.status).join(",");
  assert.ok(!/connected|answered_for_you/.test(statuses), "no fake connected state exists");

  // The outcome comes from the user, and only from a known list.
  assert.throws(() => p.setOutcome(call.id, { outcome: "connected" }), /outcome must be one of/);
  const closed = p.setOutcome(call.id, { outcome: "answered", note: "דיברנו 3 דקות" });
  assert.equal(closed.status, "closed");
  assert.equal(closed.outcome, "answered");
});

test("the dialer cannot be opened without an approval", () => {
  const p = makePhone();
  const call = p.request({ to: "0501234567", reason: "x" }, { device: owner, devices: phoneDevice() });
  assert.throws(() => p.dialerOpened(call.id, { device: owner }), /not approved/);
});

test("with no phone connected the call falls back to a labelled simulation", () => {
  const p = makePhone();
  const call = p.request({ to: "0501234567", reason: "x" }, { device: owner, devices: [] });
  assert.equal(call.simulation, true);
  assert.match(call.simulation_because, /No phone/);
  const done = p.decide(call.id, { decision: "approve", hash: call.hash, device: owner });
  assert.equal(done.status, "simulated");
  assert.equal(done.outcome, "simulated");
  assert.match(done.outcome_note, /no number was dialled/i);
  assert.equal(done.dialer_opened_at, null);
});

test("answering a call for you is refused with the reason and the step", () => {
  const p = makePhone();
  try {
    p.answerIncoming();
    assert.fail("answering must not silently succeed");
  } catch (e) {
    assert.equal(e.code, "answering_not_possible");
    assert.equal(e.status, 501);
    assert.match(e.detail, /ANSWER_PHONE_CALLS|native/);
  }
  assert.equal(CAPABILITIES.answer_incoming_call.available, false);
});

test("stop and emergency stop end calls in flight", () => {
  const p = makePhone();
  const a = p.request({ to: "0501234567", reason: "a" }, { device: owner, devices: phoneDevice() });
  const b = p.request({ to: "0501234568", reason: "b" }, { device: owner, devices: phoneDevice() });
  p.decide(b.id, { decision: "approve", hash: b.hash, device: owner });
  assert.equal(p.stopAll("emergency_stop"), 2);
  assert.equal(p.get(a.id).status, "stopped");
  assert.equal(p.get(b.id).status, "stopped");
  assert.equal(p.get(b.id).outcome, "cancelled");
});

test("notes and drafts are text only, and never audio", () => {
  const p = makePhone();
  const call = p.request({ to: "0501234567", reason: "x" }, { device: owner, devices: phoneDevice() });
  const withNote = p.addTranscript(call.id, { text: "ביקש הצעת מחיר עד יום ראשון", speaker: "them" });
  assert.equal(withNote.transcript.length, 1);
  assert.equal(withNote.transcript[0].speaker, "them");
  assert.throws(() => p.addTranscript(call.id, { text: "   " }), /Nothing to add/);
  const withDraft = p.setDraft(call.id, "אשלח הצעה מעודכנת");
  assert.match(withDraft.draft, /הצעה/);
  assert.equal(CAPABILITIES.record_call_audio.available, false);
});

test("calling is refused entirely when the feature is switched off", () => {
  const p = makePhone({ enabled: false });
  assert.throws(() => p.request({ to: "0501234567", reason: "x" }, { device: owner, devices: phoneDevice() }), /switched off/);
});

test("no external messaging or telephony provider exists in the call path", () => {
  const src = require("fs").readFileSync(require("path").join(__dirname, "..", "src", "core", "phone.js"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const forbidden of ["twilio", "vonage", "plivo", "sip:", "telegram", "whatsapp", "nodemailer", "fetch(", "https.request"]) {
    assert.ok(!code.toLowerCase().includes(forbidden), `phone.js must not contain ${forbidden}`);
  }
});
