// The speech engine layer: what JARVIS says when the engine will not run.
//
// Reported from a real machine: the screen read "The speech engine failed:"
// and then nothing at all. A program that exits without printing anything is
// the normal Windows shape of "could not start" — a missing library beside it,
// or a build the processor cannot run — and a message that stops at the colon
// leaves the user with nowhere to go.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { isolate } = require("./helpers");
isolate();

const config = require("../src/core/config");
const stt = require("../src/core/voice/stt");

const IS_WIN = process.platform === "win32";

function wav(bytes = 1600) {
  const b = Buffer.alloc(44 + bytes);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(36 + bytes, 4);
  b.write("WAVEfmt ", 8, "ascii");
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36, "ascii");
  b.writeUInt32LE(bytes, 40);
  return b;
}

/** An "engine" that exits with the given code, printing whatever is asked. */
function fakeEngine(dir, { code, prints = "" }) {
  const bin = path.join(dir, IS_WIN ? "whisper-cli.cmd" : "whisper-cli");
  fs.writeFileSync(
    bin,
    IS_WIN
      ? `@echo off\r\n${prints ? `echo ${prints} 1>&2\r\n` : ""}exit /b ${String(code)}\r\n`
      : `#!/bin/sh\n${prints ? `echo '${prints}' >&2\n` : ""}exit ${String(code)}\n`,
  );
  if (!IS_WIN) fs.chmodSync(bin, 0o755);
  const model = path.join(dir, "ggml-small.bin");
  fs.writeFileSync(model, "ggml stand-in");
  return { ...config.load(), voice: { ...config.load().voice, whisperPath: bin, whisperModel: model, keepAudio: false } };
}

test("an engine that dies without saying anything still explains itself", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-stt-"));
  // 3221225781 is Windows' STATUS_DLL_NOT_FOUND: the shape of a program that
  // could not start because a library beside it is missing.
  const cfg = fakeEngine(dir, { code: IS_WIN ? 3221225781 : 1 });
  stt.resetCache();
  try {
    await assert.rejects(
      () => stt.transcribe(wav(), { cfg, language: "he", timeoutMs: 20000 }),
      (e) => {
        assert.ok(!/failed:\s*$/.test(e.message), `the message says nothing: ${JSON.stringify(e.message)}`);
        assert.match(e.message, /could not start|library|processor|exit code/i, e.message);
        assert.equal(e.code, "speech_engine_failed");
        assert.notEqual(e.exit, undefined, "the exit code has to be reported");
        assert.ok(e.install, "and it must point at how to install a working one");
        return true;
      },
    );
  } finally {
    stt.resetCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("when the engine does say something, that is what the user is told", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-stt-"));
  const cfg = fakeEngine(dir, { code: 2, prints: "model file is corrupt" });
  stt.resetCache();
  try {
    await assert.rejects(
      () => stt.transcribe(wav(), { cfg, language: "he", timeoutMs: 20000 }),
      (e) => {
        assert.match(e.message, /model file is corrupt/, e.message);
        assert.match(e.message, /exit 2/, "with the exit code alongside it");
        return true;
      },
    );
  } finally {
    stt.resetCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed recording is deleted, not left lying around", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-stt-"));
  const cfg = fakeEngine(dir, { code: 1 });
  const paths = require("../src/core/paths");
  stt.resetCache();
  try {
    await stt.transcribe(wav(), { cfg, language: "he", timeoutMs: 20000 }).catch(() => undefined);
    const left = fs.existsSync(paths.TEMP) ? fs.readdirSync(paths.TEMP).filter((f) => f.endsWith(".wav")) : [];
    assert.deepEqual(left, [], "audio must not survive a failure either");
  } finally {
    stt.resetCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
