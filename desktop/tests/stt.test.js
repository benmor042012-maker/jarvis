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

test("a better model beside a weak configured one is used instead", async () => {
  // The same self-healing as the retired program: someone who downloads the
  // turbo model by hand should get Hebrew that works, without editing config.
  const fs = require("fs");
  const os = require("os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-model-"));
  const bin = path.join(dir, process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli");
  const weak = path.join(dir, "ggml-small.bin");
  try {
    fs.writeFileSync(bin, "x");
    fs.writeFileSync(weak, "ggml");
    const cfg = { voice: { whisperPath: bin, whisperModel: weak } };
    let d = await stt.detect(cfg, { force: true });
    assert.equal(d.model, weak, "on its own, the configured model is what there is");

    const turbo = path.join(dir, "ggml-large-v3-turbo.bin");
    fs.writeFileSync(turbo, "ggml");
    d = await stt.detect(cfg, { force: true });
    assert.equal(d.model, turbo);
    assert.equal(d.hebrew, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
