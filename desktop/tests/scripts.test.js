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

test("npm run fast measures the models here, takes the fastest, and pins it", async () => {
  // A stub engine whose delay depends on the model file: the big one is slow,
  // the small one is quick — which is the whole question the script answers.
  const http = require("http");
  const os = require("os");
  const { spawnSync } = require("child_process");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-fast-"));
  const speech = path.join(home, "speech");
  fs.mkdirSync(speech, { recursive: true });
  const small = path.join(speech, "ggml-small.bin");
  fs.writeFileSync(small, "big model");

  // The model "download": a local server standing in for the model repository.
  const body = Buffer.from("tiny model");
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": body.length });
    res.end(body);
  });
  await new Promise((r) => { server.listen(0, "127.0.0.1", r); });
  const base = `http://127.0.0.1:${String(server.address().port)}`;

  // A stub whisper that is slow for the heavy model and quick for the light one.
  const stub = path.join(home, "stub.mjs");
  fs.writeFileSync(
    stub,
    `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const a = process.argv.slice(2);
const model = a[a.indexOf("-m") + 1];
const out = a[a.indexOf("-of") + 1];
const slow = /small/.test(model);
await new Promise((r) => setTimeout(r, slow ? 2600 : 60));
writeFileSync(out + ".txt", "ok\\n");
`,
  );
  fs.chmodSync(stub, 0o755); // a shebang script Node will only spawn when it is executable

  const env = { ...process.env, JARVIS_HOME: home, JARVIS_WHISPER_MODEL_BASE: base };
  // Point the config at the stub, the way the installer would.
  const cfgScript = `const c = require(${JSON.stringify(path.join(ROOT, "desktop", "src", "core", "config.js"))});
c.update({ voice: { whisperPath: ${JSON.stringify(stub)}, whisperModel: ${JSON.stringify(small)}, keepModelLoaded: false } });`;
  spawnSync(process.execPath, ["-e", cfgScript], { env, encoding: "utf8" });

  // spawnSync would block this process's event loop, and the model server above
  // lives in it — so the "download" would never be answered. Run it async.
  const r = await new Promise((resolve, reject) => {
    const child = require("child_process").spawn(process.execPath, [path.join(SCRIPTS, "fast.mjs")], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`npm run fast did not finish:\n${stdout}`)); }, 120000);
    child.on("error", reject);
    child.on("exit", (code) => { clearTimeout(timer); resolve({ status: code, stdout, stderr }); });
  });
  server.close();
  assert.equal(r.status, 0, r.stderr);

  // It measured the installed model, found it too slow, fetched a smaller one
  // and measured that too — and said both numbers.
  assert.match(r.stdout, /measuring ggml-small\.bin/);
  assert.match(r.stdout, /Too slow for talking to/);
  assert.match(r.stdout, /downloading ggml-base\.bin/);
  assert.ok(fs.existsSync(path.join(speech, "ggml-base.bin")), "the smaller model should have been downloaded");

  // The choice is written down, pinned so the agent cannot promote it back to
  // the model it just measured as too slow, with the model kept in memory.
  const saved = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
  assert.equal(path.basename(saved.voice.whisperModel), "ggml-base.bin");
  assert.equal(saved.voice.modelPinned, true);
  assert.equal(saved.voice.keepModelLoaded, true);
  assert.equal(saved.voice.mode, "fast");

  // And it is honest about what the smaller model costs.
  assert.match(r.stdout, /What this costs/);
  assert.match(r.stdout, /wake word is unaffected/i);
  assert.ok(!/api[_-]?key|account|subscription|\$/i.test(r.stdout), "nothing to pay for");
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
