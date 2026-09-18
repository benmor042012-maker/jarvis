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

test("a wake phrase one letter out still wakes JARVIS; a different word does not", async () => {
  // From a real machine: "תתעורר" came back from the speech model as "תפקות",
  // and the screen showed nothing. A better model fixes that word, but one
  // letter dropped from a short Hebrew word is normal for every local model,
  // and refusing it is indistinguishable from not listening at all.
  const s = makeSession();

  said = "תתעור"; // the last letter lost
  let r = await s.handleUtterance(wav(), { durationMs: 900 });
  assert.equal(r.action, "woke", `a near miss must wake: ${JSON.stringify(r)}`);
  assert.equal(r.phrase, "תתעורר", "and it reports the phrase it was near");
  // The transcript is kept as it arrived, not rewritten into what we hoped for.
  assert.equal(s.history.at(-1).text, "תתעור");
  assert.equal(s.history.at(-1).near, 1);

  // Far enough away is still nothing: this is the word that actually came back
  // on that machine, and it must not wake anything.
  const fresh = makeSession();
  said = "תפקות";
  r = await fresh.handleUtterance(wav(), { durationMs: 900 });
  assert.equal(r.action, "ignored");
  assert.equal(r.reason, "no_wake_phrase");

  // And ordinary speech stays ordinary speech.
  for (const sentence of ["מה השעה", "שלום מה קורה", "תעשה לי קפה"]) {
    const other = makeSession();
    said = sentence;
    const out = await other.handleUtterance(wav(), { durationMs: 1200 });
    assert.equal(out.action, "ignored", `"${sentence}" must not wake JARVIS: ${JSON.stringify(out)}`);
  }
});

test("a near miss is held to the same false-wake rules as an exact one", async () => {
  const s = makeSession();
  said = "תתעור";
  // Too short to be speech.
  let r = await s.handleUtterance(wav(), { durationMs: 100 });
  assert.equal(r.reason, "false_wake_protection");
  // Buried in a sentence.
  said = "אמרתי לו תתעור כבר וזה לא עזר בכלל שוב";
  r = await s.handleUtterance(wav(), { durationMs: 2000 });
  assert.equal(r.reason, "false_wake_protection");
  assert.equal(s.state, "standby");
});

test("the phrase matcher's tolerance is one letter in four, and never for short words", () => {
  const { matchClose, nearness } = phrases;
  // Two letters out of six is not a near miss.
  assert.equal(matchClose("תתקורך", ["תתעורר"]), null);
  // A three-letter phrase gets no tolerance at all: too much else fits inside.
  assert.equal(nearness("עצוב", ["עצור"][0]), null);
  assert.equal(nearness("עצור", "עצור"), 0);
  // Exact matches always win, and report zero distance.
  assert.deepEqual(matchClose("hey jarvis", ["תתעורר", "hey jarvis"]), { phrase: "hey jarvis", distance: 0 });
  assert.deepEqual(matchClose("hey jarvi", ["hey jarvis"]), { phrase: "hey jarvis", distance: 1 });
  assert.equal(matchClose("", ["תתעורר"]), null);
  assert.equal(matchClose("תתעורר", []), null);
});

test("a command riding on a near-miss wake word keeps only the command", async () => {
  // The bug this pins: the wake phrase is recognised as a near miss, so it is
  // not in the transcript to remove letter for letter — and the misheard
  // spelling was handed to the planner as the command. "תתעור" became
  // something JARVIS went looking for.
  const s = makeSession();
  said = "תתעור פתח פנקס רשימות";
  const r = await s.handleUtterance(wav(), { durationMs: 1500 });
  assert.equal(r.action, "command", JSON.stringify(r));
  assert.equal(commands.length, 1);
  assert.equal(commands[0].text, "פתח פנקס רשימות", "the misheard wake word must not be part of the command");

  // And a near-miss wake on its own is a wake, not a one-word command.
  const alone = makeSession();
  said = "תתעור";
  const w = await alone.handleUtterance(wav(), { durationMs: 900 });
  assert.equal(w.action, "woke", JSON.stringify(w));
  assert.equal(commands.length, 0, "nothing may be run for a bare wake");
});

test("the window's own detector can wake JARVIS without any transcription", async () => {
  // A full transcription of one word costs seconds; the page compares the shape
  // of the sound instead, in about a millisecond. What it may not do is talk
  // its way past any rule that guards a spoken wake.
  const s = makeSession();
  const r = s.wakeLocally({ durationMs: 900, distance: 2.4 });
  assert.equal(r.action, "woke");
  assert.equal(r.phrase, null, "nothing was transcribed, so no phrase is claimed");
  assert.equal(r.detector, "local");
  assert.equal(s.state, "listening");
  // No invented transcript in the history either.
  assert.equal(s.history.at(-1).text, "");
  assert.equal(s.history.at(-1).detector, "local");

  // The cool-down applies.
  const again = s.wakeLocally({ durationMs: 900 });
  assert.equal(again.reason, "false_wake_protection");

  // Too short to be speech.
  const brief = makeSession();
  assert.equal(brief.wakeLocally({ durationMs: 50 }).reason, "false_wake_protection");

  // Muted, paused and switched off all still refuse.
  const muted = makeSession();
  muted.setMuted(true);
  assert.equal(muted.wakeLocally({ durationMs: 900 }).reason, "muted");
  const paused = makeSession();
  paused.setPaused(true);
  assert.equal(paused.wakeLocally({ durationMs: 900 }).reason, "paused");
  const off = makeSession({ enabled: false });
  assert.equal(off.wakeLocally({ durationMs: 900 }).reason, "voice_disabled");

  // Quiet hours suppress it exactly as they suppress a spoken wake.
  const now = new Date();
  const hh = (d) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const quiet = makeSession({ quietHours: { enabled: true, start: hh(new Date(now.getTime() - 3600000)), end: hh(new Date(now.getTime() + 3600000)) } });
  assert.equal(quiet.wakeLocally({ durationMs: 900 }).reason, "quiet_hours");
  assert.equal(quiet.state, "standby");
});

test("short Hebrew, English and mixed commands all reach the planner as spoken", async () => {
  // Hebrew is the default, and forcing it must not mean translating: a command
  // said in English, or half in each, has to arrive as it was said.
  for (const sentence of ["פתח פנקס רשימות", "open notepad", "תפתח לי את ה browser"]) {
    const s = makeSession();
    said = "תתעורר";
    await s.handleUtterance(wav(), { durationMs: 900 });
    said = sentence;
    const r = await s.handleUtterance(wav(), { durationMs: 1400 });
    assert.equal(r.action, "command", `"${sentence}": ${JSON.stringify(r)}`);
    assert.equal(commands.at(-1).text, sentence, "the words must reach the planner unchanged");
  }
});

test("nothing heard, and a microphone that is muted, each say which", async () => {
  // Silence while listening is not a command and not an error.
  const s = makeSession();
  said = "תתעורר";
  await s.handleUtterance(wav(), { durationMs: 900 });
  said = "";
  const quiet = await s.handleUtterance(wav(), { durationMs: 900 });
  assert.equal(quiet.action, "ignored");
  assert.equal(quiet.reason, "nothing_heard");
  assert.equal(commands.length, 0, "silence must never be planned");

  const muted = makeSession();
  muted.setMuted(true);
  said = "תתעורר";
  const r = await muted.handleUtterance(wav(), { durationMs: 900 });
  assert.equal(r.reason, "muted");
  assert.ok(r.detail.includes("muted"), r.detail);
});

test("a transcription that times out says so, and does not become a command", async () => {
  const s = makeSession();
  const real = stt.transcribe;
  stt.transcribe = async () => { throw Object.assign(new Error("Local transcription timed out."), { status: 504 }); };
  try {
    await assert.rejects(() => s.handleUtterance(wav(), { durationMs: 900 }), /timed out/);
    assert.equal(commands.length, 0);
    assert.equal(s.lastError?.message, "Local transcription timed out.");
  } finally {
    stt.transcribe = real;
  }
});

test("a missing or unreadable model is reported, with the step that fixes it", async () => {
  const s = makeSession();
  const real = stt.transcribe;
  stt.transcribe = async () => {
    throw Object.assign(new Error("No local speech engine is installed."), { status: 503, code: "speech_engine_missing", install: { what: "whisper.cpp", windows: ["download"], other: ["build"] } });
  };
  try {
    await assert.rejects(() => s.handleUtterance(wav(), { durationMs: 900 }), /No local speech engine/);
    assert.equal(s.lastError.code, "speech_engine_missing");
    assert.ok(s.lastError.install, "the way to fix it travels with the error");
  } finally {
    stt.transcribe = real;
  }
});

test("fast mode and accurate mode are both real settings, and fast is the default", () => {
  const config = require("../src/core/config");
  config.reset();
  assert.equal(config.load().voice.mode, "fast", "something you talk to defaults to answering quickly");
  assert.equal(config.load().voice.gpu, "auto");
  assert.equal(config.update({ voice: { mode: "accurate" } }).voice.mode, "accurate");
  assert.equal(config.update({ voice: { gpu: "off" } }).voice.gpu, "off");
  assert.throws(() => config.update({ voice: { mode: "turbo" } }), /fast/);
  assert.throws(() => config.update({ voice: { gpu: "on" } }), /auto/);
  config.reset();
});
