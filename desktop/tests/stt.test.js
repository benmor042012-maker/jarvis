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
