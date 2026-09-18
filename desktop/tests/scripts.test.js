// The launcher scripts run npm and electron. On Windows those are .cmd files,
// which Node will only spawn through a shell — and pairing a shell with an
// args array makes Node concatenate the arguments unescaped (DEP0190). These
// tests pin the safe form: one quoted command line, no args array.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const SCRIPTS = path.join(__dirname, "..", "..", "scripts");
const ROOT = path.join(__dirname, "..", "..");

test("no launcher pairs an args array with shell:true", () => {
  for (const file of fs.readdirSync(SCRIPTS).filter((f) => f.endsWith(".mjs"))) {
    const text = fs.readFileSync(path.join(SCRIPTS, file), "utf8");
    for (const m of text.matchAll(/spawn(?:Sync)?\(([^;]*?)\)\s*[;,)]/gs)) {
      const call = m[1];
      if (/shell\s*:/.test(call)) {
        assert.ok(!/\[[^\]]*\]\s*,/.test(call), `${file}: spawn with shell must not pass an args array:\n${call}`);
      }
    }
  }
});

test("windows command lines quote arguments and refuse dangerous ones", async () => {
  // On Windows an absolute path is not a valid ESM specifier ("protocol 'd:'"),
  // so the dynamic import needs a file:// URL.
  const { windowsCommandLine } = await import(require("url").pathToFileURL(path.join(SCRIPTS, "spawn-compat.mjs")).href);
  assert.equal(windowsCommandLine("npm", ["--prefix", "client", "install"]), "npm --prefix client install");
  assert.equal(windowsCommandLine("C:\\Program Files\\nodejs\\npm.cmd", ["run", "build"]), '"C:\\Program Files\\nodejs\\npm.cmd" run build');
  for (const bad of ["a & calc.exe", "a | b", "a > out", "%PATH%", 'say "hi"', "a\nb", "a^b"]) {
    assert.throws(() => windowsCommandLine("npm", [bad]), /unsafe argument/, `should refuse: ${bad}`);
  }
});

test("the local-AI installer explains itself instead of crashing when Ollama is absent", () => {
  const { spawnSync } = require("child_process");
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, "install-ai.mjs")], {
    encoding: "utf8",
    timeout: 60000,
    input: "",
    env: { ...process.env, PATH: "/nonexistent", JARVIS_OLLAMA_URL: "http://127.0.0.1:1" },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ollama\.com\/download/);
  assert.match(r.stdout, /free, open source/);
  assert.ok(!/api[_-]?key|account|credit card|subscription/i.test(r.stdout), "must not ask for an account or a key");
});

test("npm run ai is wired and the model table is coherent", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(SCRIPTS, "..", "package.json"), "utf8"));
  assert.equal(pkg.scripts.ai, "node scripts/install-ai.mjs");
  const text = fs.readFileSync(path.join(SCRIPTS, "install-ai.mjs"), "utf8");
  const ids = [...text.matchAll(/id: "([^"]+)"/g)].map((m) => m[1]);
  assert.ok(ids.length >= 3, "should offer a few models");
  for (const id of ids) assert.match(id, /^[a-z0-9.]+:[a-z0-9.]+$/, `${id} should be an ollama model tag`);
  // The smallest option must be last so low-RAM machines still get a choice.
  const needs = [...text.matchAll(/needsGb: (\d+)/g)].map((m) => Number(m[1]));
  assert.deepEqual(needs, [...needs].sort((a, b) => b - a), "models should be listed from most to least demanding");
});

test("started detached, the agent outlives the window that launched it", async () => {
  // The bug this pins: JARVIS ran as a child of the console that started it, so
  // closing that console killed the tray agent. The launcher must hand the
  // agent off, confirm it is answering, and then exit on its own.
  const { spawn } = require("child_process");
  const os = require("os");
  const net = require("net");

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-detach-"));
  const port = await new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => { resolve(p); }); });
  });
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ server: { port, lanEnabled: false } }));

  const launcher = spawn(process.execPath, [path.join(ROOT, "scripts", "start.mjs"), "--headless", "--detached"], {
    env: { ...process.env, JARVIS_HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  launcher.stdout.on("data", (c) => { out += c; });
  launcher.stderr.on("data", (c) => { out += c; });

  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { launcher.kill("SIGKILL"); reject(new Error(`the launcher never exited. Output:\n${out}`)); }, 60000);
    launcher.on("close", (code) => { clearTimeout(timer); resolve(code); });
  });

  let agentPid = 0;
  try {
    assert.equal(exitCode, 0, out);
    // It only claims success after asking the agent, so the message is evidence.
    assert.match(out, /JARVIS is running/, out);
    assert.match(out, /close this window/i, "it must say the window is safe to close");
    const pid = /process (\d+)/.exec(out);
    assert.ok(pid, `the launcher must report the process it handed off to. Output:\n${out}`);
    agentPid = Number(pid[1]);

    // The launcher is gone; the agent must still be answering.
    const res = await fetch(`http://127.0.0.1:${String(port)}/api/health`, { cache: "no-store" });
    assert.equal(res.ok, true, "the agent died with its launcher");
    const health = await res.json();
    assert.equal(health.ok, true);

    // And it is genuinely a different process from the one that exited.
    assert.notEqual(agentPid, launcher.pid);
    assert.doesNotThrow(() => process.kill(agentPid, 0), "the handed-off process must still be alive");
  } finally {
    if (agentPid) { try { process.kill(agentPid, "SIGKILL"); } catch { /* already gone */ } }
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("an incomplete desktop app is named, not launched into Electron's welcome window", async () => {
  // Reported from a real machine: a new download was unpacked over the folder
  // while JARVIS was still running, so Windows kept the locked files and
  // desktop/main.js never arrived. Electron, handed an app path it cannot
  // read, opens its own demo window — which looks exactly like JARVIS starting
  // and then ignoring you. The launcher has to say what is missing instead.
  const os = require("os");
  const { spawn } = require("child_process");
  const isWin = process.platform === "win32";

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-broken-"));
  const bin = path.join(root, "desktop", "node_modules", ".bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(path.join(root, "client", "dist"), { recursive: true });
  fs.cpSync(path.join(ROOT, "scripts"), path.join(root, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(root, "client", "dist", "index.html"), "<!doctype html>");
  // The manifest arrived; the program it points at did not.
  fs.writeFileSync(path.join(root, "desktop", "package.json"), JSON.stringify({ name: "jarvis-desktop", main: "main.js" }));
  // Electron only has to look installed: the launcher must refuse before it
  // would ever be run.
  const electron = path.join(bin, isWin ? "electron.cmd" : "electron");
  fs.writeFileSync(electron, isWin ? "@echo off\r\nexit /b 0\r\n" : "#!/bin/sh\nexit 0\n");
  if (!isWin) fs.chmodSync(electron, 0o755);

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-broken-home-"));
  try {
    const child = spawn(process.execPath, [path.join(root, "scripts", "start.mjs")], {
      env: { ...process.env, JARVIS_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (c) => { out += c; });
    child.stderr.on("data", (c) => { out += c; });
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`the launcher never exited. Output:\n${out}`)); }, 30000);
      child.on("close", (c) => { clearTimeout(timer); resolve(c); });
    });
    assert.equal(code, 1, `it must refuse to start. Output:\n${out}`);
    assert.match(out, /incomplete/i, out);
    assert.match(out, /main\.js/, "it names the file that is missing");
    assert.match(out, /tray/i, "and the way out: quit JARVIS, unpack again");
    assert.doesNotMatch(out, /JARVIS is running/, "nothing may claim success");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("the icons are generated, square, and one per tray state", async () => {
  // The icons are code now, not committed artwork, so the generator is what
  // has to stay correct: a missing tray state means a tray with no picture.
  const out = path.join(ROOT, "desktop", "assets");
  const before = fs.readdirSync(out).filter((f) => f.endsWith(".png")).sort();
  const { runSync } = await import("../../scripts/spawn-compat.mjs");
  const r = runSync(process.execPath, [path.join(ROOT, "scripts", "make-icons.mjs")], { encoding: "utf8" });
  assert.equal(r.status, 0, String(r.stdout) + String(r.stderr));
  const after = fs.readdirSync(out).filter((f) => f.endsWith(".png")).sort();
  assert.deepEqual(after, before, "the generator must produce exactly the icon set that ships");

  // main.js asks for tray-<state>.png at three sizes; every state must answer.
  const states = ["connected", "listening", "busy", "paused", "offline", "emergency_stopped"];
  for (const s of states) {
    for (const suffix of ["", "-32", "-256"]) {
      const file = path.join(out, `tray-${s}${suffix}.png`);
      assert.ok(fs.existsSync(file), `${file} is missing`);
    }
  }
  assert.ok(fs.existsSync(path.join(out, "icon.png")), "the window icon is missing");

  // Real PNGs, and square at the size the name promises.
  const dims = (file) => {
    const b = fs.readFileSync(file);
    assert.equal(b.subarray(1, 4).toString("ascii"), "PNG", `${file} is not a PNG`);
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  };
  assert.deepEqual(dims(path.join(out, "icon.png")), { w: 256, h: 256 });
  assert.deepEqual(dims(path.join(out, "tray-connected.png")), { w: 16, h: 16 });
  assert.deepEqual(dims(path.join(out, "tray-connected-32.png")), { w: 32, h: 32 });
  assert.deepEqual(dims(path.join(out, "tray-connected-256.png")), { w: 256, h: 256 });

  // Each state has to look like itself, or the tray picture says nothing about
  // what JARVIS is doing.
  const hash = (file) => require("crypto").createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const distinct = new Set(states.map((s) => hash(path.join(out, `tray-${s}-32.png`))));
  assert.equal(distinct.size, states.length, "two tray states render identically");
});

test("npm run fast: the choice walks down only as far as it must, and stops at the first that keeps up", async () => {
  // The decision, with the engine and the network taken out: a stand-in speech
  // engine cannot be spawned on Windows at all (no shebang, and Node refuses a
  // .cmd without a shell), and which model JARVIS ends up using is exactly the
  // thing that should be covered on the platform most people run it on.
  const { pickFastest, below, LADDER } = await import(require("url").pathToFileURL(path.join(SCRIPTS, "lib", "pick-model.mjs")).href);
  const join = (...p) => p.join("/");
  const speechDir = "/speech";

  // A computer where small needs 12 seconds — the machine in the screenshot —
  // and base answers in under a second.
  const times = { "ggml-small.bin": 12000, "ggml-base.bin": 900, "ggml-tiny.bin": 200 };
  const downloaded = [];
  const measured = [];
  const here = new Set(["/speech/ggml-small.bin"]);
  const run = (over = {}) =>
    pickFastest({
      current: "/speech/ggml-small.bin",
      speechDir,
      join,
      targetMs: 1200,
      exists: (p) => here.has(p),
      measure: (p) => { measured.push(path.posix.basename(p)); return Promise.resolve(times[path.posix.basename(p)]); },
      fetchModel: (file, dest) => { downloaded.push(file); here.add(dest); return Promise.resolve(); },
      ...over,
    });

  const out = await run();
  assert.equal(out.model, "/speech/ggml-base.bin");
  assert.equal(out.took, 900);
  assert.equal(out.before, 12000, "it reports what the old model really cost");
  assert.equal(out.changed, true);
  assert.deepEqual(measured, ["ggml-small.bin", "ggml-base.bin"], "it stops at the first that keeps up");
  assert.deepEqual(downloaded, ["ggml-base.bin"], "tiny is never fetched when base is fast enough");

  // Already fast: nothing is downloaded and nothing is measured beyond the one.
  const quick = await pickFastest({
    current: "/speech/ggml-small.bin", speechDir, join, targetMs: 1200,
    exists: () => true,
    measure: () => Promise.resolve(800),
    fetchModel: () => { throw new Error("must not download"); },
  });
  assert.equal(quick.changed, false);
  assert.equal(quick.model, "/speech/ggml-small.bin");

  // A computer where even tiny cannot keep up still gets the fastest of them,
  // and the caller can see it is still over the target rather than be told a
  // number that was never measured.
  const slowTimes = { "ggml-small.bin": 12000, "ggml-base.bin": 6000, "ggml-tiny.bin": 3000 };
  const hopeless = await pickFastest({
    current: "/speech/ggml-small.bin", speechDir, join, targetMs: 1200,
    exists: (p) => p === "/speech/ggml-small.bin",
    measure: (p) => Promise.resolve(slowTimes[path.posix.basename(p)]),
    fetchModel: () => Promise.resolve(),
  });
  assert.equal(path.posix.basename(hopeless.model), "ggml-tiny.bin");
  assert.equal(hopeless.took, 3000);
  assert.ok(hopeless.took > 1200, "and it is still over target, which the script says out loud");

  // A model that cannot be downloaded is skipped, not fatal.
  const skipped = await pickFastest({
    current: "/speech/ggml-small.bin", speechDir, join, targetMs: 1200,
    exists: (p) => p === "/speech/ggml-small.bin",
    measure: (p) => Promise.resolve(slowTimes[path.posix.basename(p)]),
    fetchModel: (file) => (file === "ggml-base.bin" ? Promise.reject(new Error("offline")) : Promise.resolve()),
  });
  assert.equal(path.posix.basename(skipped.model), "ggml-tiny.bin");

  // The ladder is heaviest first and multilingual only: an .en model cannot do
  // Hebrew at any size, so none may appear here.
  assert.deepEqual([...LADDER].sort((a, b) => b.mb - a.mb).map((m) => m.file), LADDER.map((m) => m.file));
  assert.ok(!LADDER.some((m) => /\.en\./.test(m.file)));
  assert.deepEqual(below("ggml-base.bin").map((m) => m.file), ["ggml-tiny.bin"]);
  assert.deepEqual(below("ggml-tiny.bin"), [], "nothing below the smallest");
});

test("the voice installer offers every model, and a name that is not downloaded yet is fetched", async () => {
  // The gap this closes, seen on a real machine: with ggml-small already here,
  // the menu listed only what was on the disk, and typing the name of anything
  // else did nothing at all — so the one answer to "this computer needs twelve
  // seconds a sentence", a smaller model, could not be given from the installer.
  // The installer reads its answer from a terminal, which a test cannot supply
  // (piped stdin is not a TTY and the prompt returns ""), so the rule itself is
  // what is covered here.
  const { resolveChoice } = await import(require("url").pathToFileURL(path.join(SCRIPTS, "lib", "pick-model.mjs")).href);
  const MODELS = [
    { id: "small", file: "ggml-small.bin", mb: 466 },
    { id: "base", file: "ggml-base.bin", mb: 148 },
    { id: "tiny", file: "ggml-tiny.bin", mb: 75 },
  ];
  const dir = "/speech";
  const here = new Set(["/speech/ggml-small.bin"]);
  const ask = (want) => resolveChoice(want, "/speech/ggml-small.bin", { exists: (f) => here.has(f), join: (...p) => p.join("/"), dir, models: MODELS });

  assert.deepEqual(ask("base"), { kind: "download", file: "/speech/ggml-base.bin", model: MODELS[1] }, "not here yet: fetch it");
  here.add("/speech/ggml-base.bin");
  assert.equal(ask("base").kind, "use", "already here: just switch");
  assert.equal(ask("").kind, "keep", "Enter keeps what is in use");
  assert.equal(ask("small").kind, "keep", "asking for the one in use changes nothing");
  assert.equal(ask("BASE").kind, "use", "the answer is not case-sensitive");
  assert.equal(ask("ggml-tiny.bin").kind, "download", "the file name works as well as the short name");
  const nonsense = ask("enormous");
  assert.equal(nonsense.kind, "unknown");
  assert.equal(nonsense.answer, "enormous");
  assert.equal(nonsense.file, "/speech/ggml-small.bin", "and nothing changes");
});

test("npm run fast is wired, asks for nothing paid, and says so when there is no engine to measure", () => {
  const os = require("os");
  const { spawnSync } = require("child_process");
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.scripts.fast, "node scripts/fast.mjs");

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-fast-"));
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, "fast.mjs")], {
    encoding: "utf8", timeout: 60000, env: { ...process.env, JARVIS_HOME: home },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /speech engine is not installed/i);
  assert.match(r.stdout, /npm run voice/);
  assert.ok(!/api[_-]?key|account|subscription|credit card/i.test(r.stdout), "nothing to pay for");
});

test("a pinned model is used as configured, not promoted to the heavier one beside it", () => {
  const os = require("os");
  const stt = require("../src/core/voice/stt.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-pin-"));
  const tiny = path.join(dir, "ggml-tiny.bin");
  const small = path.join(dir, "ggml-small.bin");
  fs.writeFileSync(tiny, "t");
  fs.writeFileSync(small, "s");
  // Unpinned, the better model beside a weak one wins (someone who downloaded
  // small should get it). Pinned, the measured choice stands.
  assert.deepEqual(stt.modelCandidates({ voice: { whisperModel: tiny } }), [small, tiny]);
  assert.deepEqual(stt.modelCandidates({ voice: { whisperModel: tiny, modelPinned: true } }), [tiny]);
});
