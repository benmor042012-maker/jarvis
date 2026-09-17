// The voice session: wake phrase, false-wake protection, quiet hours, max
// listening duration, and stop phrases that work with no model at all.
const test = require("node:test");
const assert = require("node:assert/strict");
const { isolate } = require("./helpers");
isolate();

const config = require("../src/core/config");
const { VoiceSession, inQuietHours, hhmmToMinutes } = require("../src/core/voice/session");
const phrases = require("../src/core/voice/phrases");
const stt = require("../src/core/voice/stt");

// A valid WAV header so the session's input check passes; the engine is stubbed.
function wav(bytes = 3200) {
  const data = Buffer.alloc(bytes);
  const head = Buffer.alloc(44);
  head.write("RIFF", 0, "ascii");
  head.writeUInt32LE(36 + data.length, 4);
  head.write("WAVEfmt ", 8, "ascii");
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(16000, 24);
  head.writeUInt32LE(32000, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36, "ascii");
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

let said = "";
let commands = [];
let stops = [];
function makeSession(overrides = {}) {
  // config.update merges into the file on disk, which every test in this file
  // shares, so each session states the settings it relies on in full.
  config.reset();
  const cfg = config.update({
    voice: {
      enabled: true,
      wakePhrases: ["תתעורר", "hey jarvis"],
      stopPhrases: ["עצור", "תעצור", "חירום", "stop", "emergency"],
      quietHours: { enabled: false, start: "22:00", end: "07:00" },
      maxListenMs: 15000,
      ...overrides,
    },
  });
  commands = [];
  stops = [];
  const s = new VoiceSession({
    getConfig: () => cfg,
    onCommand: async (text, meta) => { commands.push({ text, meta }); return { plan: { plan_id: "p1", message: "ok", actions: [] }, job: null }; },
    onStop: (source) => { stops.push(source); return { cancelled_jobs: 1 }; },
  });
  s.setMicGranted(true);
  return s;
}

// Stub the local engine so the tests exercise the session, not whisper.
const realTranscribe = stt.transcribe;
test.before(() => { stt.transcribe = async () => ({ text: said, engine: "stub", model: "stub", language: "he" }); });
test.after(() => { stt.transcribe = realTranscribe; });

test("phrase matching is Hebrew-safe and never matches inside a word", () => {
  assert.ok(phrases.containsPhrase("תתעורר", "תתעורר"));
  assert.ok(phrases.containsPhrase("היי ג׳רביס, תתעורר!", "תתעורר"));
  assert.ok(phrases.containsPhrase("Hey Jarvis", "hey jarvis"));
  assert.ok(!phrases.containsPhrase("מתעורר לאט", "תתעורר"), "substring must not match");
  assert.ok(!phrases.containsPhrase("המעצור נשבר", "עצור"), "substring must not match");
  assert.equal(phrases.stripPhrase("תתעורר פתח פנקס רשימות", "תתעורר"), "פתח פנקס רשימות");
});

test("quiet hours wrap past midnight", () => {
  assert.equal(hhmmToMinutes("22:00"), 1320);
  assert.equal(hhmmToMinutes("7:05"), 425);
  assert.equal(hhmmToMinutes("25:00"), null);
  const q = { enabled: true, start: "22:00", end: "07:00" };
  assert.ok(inQuietHours(q, new Date("2026-01-01T23:30:00")));
  assert.ok(inQuietHours(q, new Date("2026-01-01T03:00:00")));
  assert.ok(!inQuietHours(q, new Date("2026-01-01T12:00:00")));
  assert.ok(!inQuietHours({ ...q, enabled: false }, new Date("2026-01-01T23:30:00")));
});

test("standby ignores ordinary speech and wakes only on the phrase", async () => {
  const s = makeSession();
  said = "מה השעה עכשיו";
  let r = await s.handleUtterance(wav(), { durationMs: 900 });
  assert.equal(r.action, "ignored");
  assert.equal(r.reason, "no_wake_phrase");
  assert.equal(s.state, "standby");
  // The window shows this back to the user: "I said the wake phrase and
  // nothing happened" is only answerable if what was heard instead comes back.
  assert.equal(r.text, said);

  said = "תתעורר";
  r = await s.handleUtterance(wav(), { durationMs: 900 });
  assert.equal(r.action, "woke");
  assert.equal(s.state, "listening");
  assert.ok(r.listening_until > Date.now());
});

test("a command spoken with the wake phrase runs in one go", async () => {
  const s = makeSession();
  said = "תתעורר פתח פנקס רשימות";
  const r = await s.handleUtterance(wav(), { durationMs: 1400 });
  assert.equal(r.action, "command");
  assert.equal(commands[0].text, "פתח פנקס רשימות");
});

test("false-wake protection: long sentences, blips and repeats are refused", async () => {
  const s = makeSession();
  said = "אתמול בטלוויזיה אמרו שצריך תתעורר מוקדם כדי להספיק הכל בבוקר";
  let r = await s.handleUtterance(wav(), { durationMs: 4000 });
  assert.equal(r.reason, "false_wake_protection");
  assert.equal(s.state, "standby");

  said = "תתעורר";
  r = await s.handleUtterance(wav(), { durationMs: 50 });
  assert.equal(r.reason, "false_wake_protection", "a 50ms blip is not speech");

  r = await s.handleUtterance(wav(), { durationMs: 900 });
  assert.equal(r.action, "woke");
  s.reset();
  r = await s.handleUtterance(wav(), { durationMs: 900 });
  assert.equal(r.reason, "false_wake_protection", "cool-down blocks an immediate second wake");
  assert.equal(s.stats.falseWakes, 3);
});

test("quiet hours suppress the wake but never the stop phrase", async () => {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const s = makeSession({ quietHours: { enabled: true, start: `${hh}:00`, end: `${String((now.getHours() + 2) % 24).padStart(2, "0")}:00` } });
  said = "תתעורר";
  let r = await s.handleUtterance(wav(), { durationMs: 900 });
  assert.equal(r.reason, "quiet_hours");
  said = "עצור";
  r = await s.handleUtterance(wav(), { durationMs: 700 });
  assert.equal(r.action, "stopped");
});

test("stop phrases stop without any model, even while paused or mid-task", async () => {
  const s = makeSession();
  for (const word of ["עצור", "תעצור", "חירום", "stop", "emergency"]) {
    said = word;
    const r = await s.handleUtterance(wav(), { durationMs: 700 });
    assert.equal(r.action, "stopped", word);
    assert.equal(r.model_used, false, "stopping must not need a model");
    assert.equal(r.phrase, word);
  }
  assert.equal(stops.length, 5);

  s.setPaused(true);
  said = "תעצור";
  const r = await s.handleUtterance(wav(), { durationMs: 700 });
  assert.equal(r.action, "stopped", "a stop phrase is honoured even when paused");
  said = "תתעורר";
  const w = await s.handleUtterance(wav(), { durationMs: 900 });
  assert.equal(w.action, "ignored");
  assert.equal(w.reason, "paused");
});

test("muted and disabled states refuse to listen and say why", async () => {
  const s = makeSession();
  s.setMuted(true);
  said = "תתעורר";
  let r = await s.handleUtterance(wav(), { durationMs: 900 });
  assert.equal(r.reason, "muted");

  s.setMuted(false);
  s.setMicGranted(false);
  r = await s.handleUtterance(wav(), { durationMs: 900 });
  assert.equal(r.reason, "microphone_not_granted");
});

test("listening expires after the maximum duration", async () => {
  const s = makeSession({ maxListenMs: 2000 });
  said = "תתעורר";
  await s.handleUtterance(wav(), { durationMs: 900 });
  assert.equal(s.state, "listening");
  s.listeningUntil = Date.now() - 1; // the window has passed
  said = "פתח פנקס רשימות";
  const r = await s.handleUtterance(wav(), { durationMs: 900 });
  assert.equal(r.action, "ignored", "after the window it is ordinary speech again");
  assert.equal(commands.length, 0);
});

test("status reports the missing speech engine honestly, with the install step", async () => {
  const s = makeSession();
  const st = await s.status({ force: true });
  assert.equal(st.engine.available, false);
  assert.match(st.engine.reason, /No local speech engine|model/);
  assert.ok(st.engine.install.windows.some((line) => /whisper/i.test(line)));
  assert.ok(st.engine.install.windows.some((line) => /ggml-small\.bin/.test(line)), "must name the exact free model file");
  assert.equal(st.state, "unavailable");
  assert.deepEqual(st.wakePhrases, ["תתעורר", "hey jarvis"]);
});

test("a transcription failure surfaces the reason instead of inventing a command", async () => {
  const s = makeSession();
  stt.transcribe = async () => { throw Object.assign(new Error("No local speech engine is installed."), { status: 503, code: "speech_engine_missing", install: { what: "whisper.cpp" } }); };
  await assert.rejects(() => s.handleUtterance(wav(), { durationMs: 900 }), /speech engine/);
  assert.equal(commands.length, 0);
  assert.equal(s.lastError.code, "speech_engine_missing");
  stt.transcribe = async () => ({ text: said, engine: "stub", model: "stub", language: "he" });
});

test("nothing but transcripts is remembered, and audio is never kept by default", async () => {
  const s = makeSession();
  said = "תתעורר";
  await s.handleUtterance(wav(), { durationMs: 900 });
  assert.ok(s.history.length >= 1);
  assert.ok(s.history.every((h) => !("audio" in h) && !("wav" in h)));
  assert.equal(config.load().voice.keepAudio, false);
});
