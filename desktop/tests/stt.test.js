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

/** A file that passes for a model: the GGML marker, and big enough to be one. */
function fakeModel(file) {
  const fs = require("fs");
  const buf = Buffer.alloc(1024 * 1024 + 16);
  buf.write("ggml", 0, "ascii");
  fs.writeFileSync(file, buf);
}

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
    fakeModel(tooPoor);

    // On its own, what is configured is what there is.
    let d = await stt.detect({ voice: { whisperPath: bin, whisperModel: tooPoor } }, { force: true });
    assert.equal(d.model, tooPoor);

    // With something usable beside it, base gives way without anyone editing
    // config.json.
    fakeModel(small);
    d = await stt.detect({ voice: { whisperPath: bin, whisperModel: tooPoor } }, { force: true });
    assert.equal(d.model, small);

    // But small configured with turbo beside it stays small. This used to swap
    // itself for the large model and spend several seconds a sentence doing it
    // — undoing, silently, the one choice that makes JARVIS quick to talk to.
    fakeModel(turbo);
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

test("the flags follow the mode, and the processor is used when asked", () => {
  // What reaches whisper.cpp decides both the speed and the accuracy, so it is
  // pinned rather than trusted. Checked directly rather than through a stand-in
  // engine: a script with a shebang cannot be spawned on Windows at all, which
  // is how this test first failed.
  const args = (o) => stt.whisperArgs({ model: "/s/ggml-small.bin", file: "/t/a.wav", language: "he", seconds: 1.2, ...o });
  const after = (list, flag) => list[list.indexOf(flag) + 1];

  const fast = args({ mode: "fast" });
  assert.equal(after(fast, "-l"), "he", "Hebrew is what was asked for");
  assert.ok(!fast.includes("-tr"), "and it is never translated into English");
  assert.ok(fast.includes("-ac"), "fast mode trims the encoder to the length of the recording");
  assert.ok(Number(after(fast, "-ac")) < 1500, after(fast, "-ac"));
  assert.ok(!fast.includes("-ng"), "the graphics card is left to the engine by default");
  assert.equal(after(fast, "-bs"), "1", "fast mode takes the first guess rather than decoding five times over");
  assert.ok(fast.includes("-nf"), "and does not re-decode the same audio at rising temperatures when it is unsure");

  // The same mode on a large model drops the search instead: there it costs
  // the seconds that made JARVIS unusable.
  assert.equal(after(args({ mode: "fast", model: "/s/ggml-large-v3-turbo.bin" }), "-bs"), "1");

  const accurate = args({ mode: "accurate", model: "/s/ggml-large-v3-turbo.bin" });
  assert.ok(!accurate.includes("-ac"), "accurate mode keeps the whole window");
  assert.equal(after(accurate, "-bs"), "5", "and searches rather than taking the first guess");
  assert.ok(!accurate.includes("-nf"), "accurate mode keeps the retries that make it accurate");

  assert.ok(args({ mode: "fast", gpu: "off" }).includes("-ng"), "processor-only means processor-only");

  // A long recording is not trimmed even in fast mode: -ac shorter than the
  // audio would cut the end off.
  assert.ok(!args({ mode: "fast", seconds: 45 }).includes("-ac"));

  // The initial prompt is a plain sentence, and never the wake phrase: whisper
  // repeats its prompt on unclear audio, which would turn a cough into a wake.
  const prompt = after(fast, "--prompt");
  assert.match(prompt, /[\u0590-\u05FF]/, "Hebrew audio gets a Hebrew prompt");
  assert.ok(!prompt.includes("תתעורר"), prompt);
  assert.ok(!args({ language: "xx" }).includes("--prompt"), "a language with no prompt written for it gets none");
});

test("the model is kept in memory when the download came with a server", async () => {
  // The program reloads a 466 MB model for every sentence, which on an ordinary
  // disk is most of the wait. whisper-server ships in the same download and
  // holds it in memory. This drives the real client against a stand-in server
  // that speaks the same protocol.
  const fs = require("fs");
  const os = require("os");
  const http = require("http");
  const server = require("../src/core/voice/whisper-server");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-wserver-"));
  let received = null;
  const stub = http.createServer((req, res) => {
    if (req.url === "/") { res.writeHead(200).end("ok"); return; }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      received = Buffer.concat(chunks).toString("latin1");
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ text: " שלום עולם " }));
    });
  });
  try {
    await new Promise((r) => { stub.listen(0, "127.0.0.1", r); });
    const port = stub.address().port;

    const wav = Buffer.concat([Buffer.from("RIFF0000WAVE"), Buffer.alloc(3200)]);
    const text = await server.transcribe({ port, wav, language: "he", timeoutMs: 5000 });
    assert.equal(text.trim(), "שלום עולם", "the transcript comes back from the server");
    assert.match(received, /name="file"; filename="a\.wav"/, "the audio is posted as a file");
    assert.match(received, /name="language"[\s\S]*he/, "in the language asked for");
    assert.ok(!/name="translate"/.test(received), "and never asked to be translated");

    // No server binary beside the program: the caller must get null and use the
    // command line, rather than an error.
    const cli = path.join(dir, process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli");
    fs.writeFileSync(cli, "x");
    assert.equal(server.serverBinaryFor(cli), null);
    assert.equal(await server.ensure({ cliPath: cli, model: path.join(dir, "m.bin"), threads: 2 }), null);
    assert.deepEqual(server.status(), { running: false, model: null, port: null });

    // And it is found when the download did include it.
    const srv = path.join(dir, process.platform === "win32" ? "whisper-server.exe" : "whisper-server");
    fs.writeFileSync(srv, "x");
    assert.equal(server.serverBinaryFor(cli), srv);
  } finally {
    stub.close();
    server.stop("test over");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a damaged model file is named as the problem, before anything is transcribed", async () => {
  // What a half-finished download does on a real machine: whisper.cpp says
  // "failed to initialize whisper context" — which sounds like the engine is
  // broken, so people reinstall the engine and the model stays broken. Worse,
  // it says it seconds after you speak, once per sentence, for ever.
  const fs = require("fs");
  const os = require("os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-damaged-"));
  const bin = path.join(dir, process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli");
  const broken = path.join(dir, "ggml-base.bin");
  try {
    fs.writeFileSync(bin, "x");
    // A web page, which is what an unauthenticated link hands back.
    fs.writeFileSync(broken, Buffer.alloc(2 * 1024 * 1024, "<"));

    const d = await stt.detect({ voice: { whisperPath: bin, whisperModel: broken, modelPinned: true } }, { force: true });
    assert.equal(d.available, false, "a file that is not a model cannot transcribe, and must not be offered as if it could");
    assert.match(d.reason, /damaged/i);
    assert.match(d.reason, /ggml-base\.bin/);
    assert.match(d.install.note, /npm run voice/);

    // A truncated download is caught by its size alone.
    fs.writeFileSync(broken, "ggml");
    assert.equal(stt.isModelFile(broken), false, "four bytes is not a model");

    // And a real one passes.
    fakeModel(broken);
    assert.equal(stt.isModelFile(broken), true);

    // The engine's own wording, when it gets that far, is translated too.
    const err = stt.engineFailure(
      { code: 3, stderr: "load_backend: loaded CPU backend\nerror: failed to initialize whisper context\n" },
      { binary: bin, model: broken, engine: "whisper.cpp" },
    );
    assert.equal(err.code, "speech_model_damaged");
    assert.match(err.message, /file is damaged/i);
    assert.match(err.message, /npm run voice/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
