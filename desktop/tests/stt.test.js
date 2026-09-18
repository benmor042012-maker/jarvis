// What JARVIS says when the speech engine will not run.
//
// Reported from a real machine: the screen read "The speech engine failed:"
// and then nothing at all. A program that exits without printing anything is
// the ordinary Windows shape of "could not start" — a library missing from
// beside the executable, or a build the processor cannot run — and a message
// that stops at the colon leaves the user with nowhere to go.
//
// These drive the failure translation directly rather than through a stand-in
// program: Node refuses to spawn a .cmd without a shell, so a fake executable
// would test the spawn layer instead of the words the user reads.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { isolate } = require("./helpers");
isolate();

const stt = require("../src/core/voice/stt");

const ENGINE = { binary: path.join("C:", "Users", "someone", ".jarvis", "speech", "whisper-cli.exe"), model: "ggml-small.bin", engine: "whisper.cpp" };

test("an engine that dies without saying anything still explains itself", () => {
  // 3221225781 is Windows' STATUS_DLL_NOT_FOUND.
  const e = stt.engineFailure({ code: 3221225781, stdout: "", stderr: "" }, ENGINE);
  assert.ok(!/failed:\s*$/.test(e.message), `the message says nothing: ${JSON.stringify(e.message)}`);
  assert.match(e.message, /library/i, e.message);
  assert.match(e.message, /whisper-cli\.exe/, "it names the program that failed");
  assert.ok(e.message.includes(path.dirname(ENGINE.binary)), "and where it should have found the library");
  assert.equal(e.code, "speech_engine_failed");
  assert.equal(e.exit, 3221225781);
  assert.ok(e.install, "and it points at how to install a working one");
});

test("a build the processor cannot run says so, rather than blaming the model", () => {
  const e = stt.engineFailure({ code: 3221225501, stdout: "", stderr: "" }, ENGINE); // STATUS_ILLEGAL_INSTRUCTION
  assert.match(e.message, /processor/i, e.message);
  assert.equal(e.exit, 3221225501);
});

test("any other silent exit still reports the code and a direction to look", () => {
  const e = stt.engineFailure({ code: 9, stdout: "", stderr: "" }, ENGINE);
  assert.ok(!/failed:\s*$/.test(e.message));
  assert.match(e.message, /exit code 9/, e.message);
  assert.match(e.message, /could not start/i, e.message);
});

test("when the engine does say something, that is what the user is told", () => {
  const e = stt.engineFailure({ code: 2, stdout: "", stderr: "error: failed to load model\n" }, ENGINE);
  assert.match(e.message, /failed to load model/, e.message);
  assert.match(e.message, /exit 2/, "with the exit code alongside it");
  assert.equal(e.exit, 2);
});

test("a long complaint from the engine is trimmed, not dropped", () => {
  const e = stt.engineFailure({ code: 1, stdout: "", stderr: "x".repeat(5000) }, ENGINE);
  assert.ok(e.message.length < 400, `the message must stay readable, got ${String(e.message.length)}`);
  assert.match(e.message, /x{50}/, "but it still carries what the engine said");
});

// Reported from a real machine: after the missing Visual C++ libraries were
// installed, the engine finally started — and exited 1 with
// "WARNING: The binary 'main.exe' is deprecated. Please use 'whisper-cli.exe'
// instead." The install was complete and JARVIS still could not hear a word,
// because the installer had picked the retired program out of the folder.
test("the retired main.exe is named for what it is, with the program to use instead", () => {
  const deprecated = { ...ENGINE, binary: path.join(path.dirname(ENGINE.binary), "main.exe") };
  const e = stt.engineFailure({
    code: 1,
    stdout: "",
    stderr: "WARNING: The binary 'main.exe' is deprecated.\n Please use 'whisper-cli.exe' instead.\n",
  }, deprecated);
  assert.match(e.message, /main\.exe/, e.message);
  assert.match(e.message, /whisper-cli/, "it names the program that does work");
  assert.ok(e.message.includes(path.dirname(deprecated.binary)), "and the folder to find it in");
  assert.match(e.message, /npm run voice/, "and the free step when it is not there");
  assert.equal(e.exit, 1);
});

test("a configured main.exe is replaced by the whisper-cli.exe beside it", async () => {
  const fs = require("fs");
  const os = require("os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-stt-"));
  const name = process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli";
  const stale = path.join(dir, process.platform === "win32" ? "main.exe" : "main");
  try {
    fs.writeFileSync(stale, "x");
    const model = path.join(dir, "ggml-small.bin");
    fs.writeFileSync(model, "ggml");
    const cfg = { voice: { whisperPath: stale, whisperModel: model } };

    // On its own, the configured path is all there is.
    let d = await stt.detect(cfg, { force: true });
    assert.equal(d.binary, stale);

    // With the supported program beside it, that one is used instead.
    fs.writeFileSync(path.join(dir, name), "x");
    d = await stt.detect(cfg, { force: true });
    assert.equal(d.binary, path.join(dir, name));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a model that cannot do Hebrew gives way; a model chosen on purpose does not", async () => {
  const fs = require("fs");
  const os = require("os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-model-"));
  const bin = path.join(dir, process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli");
  const tooPoor = path.join(dir, "ggml-base.bin");
  const small = path.join(dir, "ggml-small.bin");
  const turbo = path.join(dir, "ggml-large-v3-turbo.bin");
  try {
    fs.writeFileSync(bin, "x");
    fs.writeFileSync(tooPoor, "ggml");

    // On its own, what is configured is what there is.
    let d = await stt.detect({ voice: { whisperPath: bin, whisperModel: tooPoor } }, { force: true });
    assert.equal(d.model, tooPoor);

    // With something usable beside it, base gives way without anyone editing
    // config.json.
    fs.writeFileSync(small, "ggml");
    d = await stt.detect({ voice: { whisperPath: bin, whisperModel: tooPoor } }, { force: true });
    assert.equal(d.model, small);

    // But small configured with turbo beside it stays small. This used to swap
    // itself for the large model and spend several seconds a sentence doing it
    // — undoing, silently, the one choice that makes JARVIS quick to talk to.
    fs.writeFileSync(turbo, "ggml");
    d = await stt.detect({ voice: { whisperPath: bin, whisperModel: small } }, { force: true });
    assert.equal(d.model, small, "a model chosen on purpose is not a fault to correct");
    assert.equal(d.hebrew, true);

    // And turbo configured stays turbo: accuracy over speed is just as valid.
    d = await stt.detect({ voice: { whisperPath: bin, whisperModel: turbo } }, { force: true });
    assert.equal(d.model, turbo);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a model too slow for this computer gives way to the biggest one that keeps up", async () => {
  // "I want every answer in a second." A model that needs fifteen is not an
  // assistant, and the fix cannot be a download: it has to be the models that
  // are already on this machine.
  const fs = require("fs");
  const os = require("os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-speed-"));
  const bin = path.join(dir, process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli");
  // Sizes stand in for the real files: what matters is the order.
  const big = path.join(dir, "ggml-large-v3-turbo.bin");
  const mid = path.join(dir, "ggml-small.bin");
  const wee = path.join(dir, "ggml-base.bin");
  try {
    fs.writeFileSync(bin, "x");
    fs.writeFileSync(big, Buffer.alloc(3000, "g"));
    fs.writeFileSync(mid, Buffer.alloc(2000, "g"));
    fs.writeFileSync(wee, Buffer.alloc(1000, "g"));

    const slow = { runs: 3, avg: stt.TARGET_MS * 4 };
    const quick = { runs: 3, avg: 900 };

    // Nothing measured yet: the configured model stands.
    assert.equal(stt.chooseModel(big, null).model, big);
    // One slow run is not enough — the first includes loading the model.
    assert.equal(stt.chooseModel(big, { runs: 1, avg: stt.TARGET_MS * 4 }).model, big);
    // Measured slow, and the largest model that is smaller takes over.
    const switched = stt.chooseModel(big, slow);
    assert.equal(switched.model, mid, "the next size down, not the smallest");
    assert.deepEqual(
      { from: switched.fallback.from, to: switched.fallback.to },
      { from: "ggml-large-v3-turbo.bin", to: "ggml-small.bin" },
      "and it says what it swapped, so nothing changes silently",
    );
    // When that one is known to be slow too, it goes down one more.
    assert.equal(stt.chooseModel(big, slow, (f) => (f === mid ? slow : null)).model, wee);
    // Fast enough, and nothing changes.
    assert.equal(stt.chooseModel(big, quick).model, big);
    assert.equal(stt.chooseModel(big, quick).fallback, null);
    // Nothing smaller to fall back to: it stays, rather than claiming a switch.
    assert.equal(stt.chooseModel(wee, slow).model, wee);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the flags follow the mode, and the processor is used when asked", async () => {
  // What actually reaches whisper.cpp decides both the speed and the accuracy,
  // so the flags are pinned rather than trusted.
  const fs = require("fs");
  const os = require("os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-flags-"));
  const model = path.join(dir, "ggml-small.bin");
  const seen = [];
  // A stand-in engine: it records the arguments and writes an empty transcript.
  const bin = path.join(dir, "whisper-cli.mjs");
  fs.writeFileSync(bin, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const a = process.argv.slice(2);
if (a.includes("--help")) { console.log("usage"); process.exit(0); }
writeFileSync(process.env.JARVIS_FLAG_LOG, JSON.stringify(a));
writeFileSync(a[a.indexOf("-of") + 1] + ".txt", "שלום\\n");
`);
  fs.chmodSync(bin, 0o755);
  const log = path.join(dir, "flags.json");
  process.env.JARVIS_FLAG_LOG = log;
  const head = Buffer.alloc(44);
  head.write("RIFF", 0, "ascii"); head.writeUInt32LE(36 + 32000, 4); head.write("WAVEfmt ", 8, "ascii");
  head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(16000, 24); head.writeUInt32LE(32000, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
  head.write("data", 36, "ascii"); head.writeUInt32LE(32000, 40);
  const oneSecond = Buffer.concat([head, Buffer.alloc(32000)]);
  try {
    fs.writeFileSync(model, "ggml");
    // Detection is cached for fifteen seconds, and an earlier test in this file
    // has already filled it with a folder that no longer exists.
    stt.resetCache();
    const run = async (voice) => {
      await stt.transcribe(oneSecond, { cfg: { voice: { whisperPath: bin, whisperModel: model, ...voice } }, language: "he" });
      stt.resetCache();
      return JSON.parse(fs.readFileSync(log, "utf8"));
    };

    const fast = await run({ mode: "fast" });
    seen.push(fast);
    assert.ok(fast.includes("-ac"), "fast mode trims the encoder to the length of the recording");
    assert.equal(fast[fast.indexOf("-l") + 1], "he", "Hebrew is what was asked for");
    assert.ok(!fast.includes("-tr"), "and it is never translated into English");
    assert.ok(!fast.includes("-ng"), "the graphics card is left to the engine by default");

    const accurate = await run({ mode: "accurate" });
    assert.ok(!accurate.includes("-ac"), "accurate mode keeps the whole window");
    assert.equal(accurate[accurate.indexOf("-bs") + 1], "5", "and searches rather than taking the first guess");

    const cpuOnly = await run({ mode: "fast", gpu: "off" });
    assert.ok(cpuOnly.includes("-ng"), "processor-only means processor-only");
  } finally {
    delete process.env.JARVIS_FLAG_LOG;
    fs.rmSync(dir, { recursive: true, force: true });
    stt.resetCache();
  }
});
