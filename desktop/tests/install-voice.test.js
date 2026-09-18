// The speech-engine installer. It is the one script a stuck user runs, so the
// ways it can go wrong are tested against a local server rather than trusted:
// a truncated download, an error page wearing a model's name, a release with no
// Windows build, and a program installed without the libraries it needs.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { pathToFileURL } = require("url");

const LIB = pathToFileURL(path.join(__dirname, "..", "..", "scripts", "lib", "whisper-install.mjs")).href;
const INSTALLER = path.join(__dirname, "..", "..", "scripts", "install-voice.mjs");

/**
 * Run the installer as a separate process, without blocking this one.
 *
 * spawnSync cannot be used here: it blocks this process's event loop, so the
 * local server below could never answer the request the child is waiting on —
 * the two would deadlock. stdin is closed so the script's prompt reads EOF and
 * takes its default, exactly as it does when run from a .bat file.
 */
function runInstaller(env, timeoutMs = 60000, stopWhen = null) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [INSTALLER], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let stopped = false;
    const watch = (c) => {
      out += c;
      // Some paths carry on into a real source build, which takes minutes and
      // is not what the test is about. Stop once the behaviour under test has
      // happened and let the assertions look at what it left behind.
      if (stopWhen && !stopped && stopWhen.test(out)) {
        stopped = true;
        child.kill("SIGKILL");
      }
    };
    child.stdout.on("data", watch);
    child.stderr.on("data", watch);
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`the installer did not finish within ${String(timeoutMs)}ms. Output so far:\n${out}`)); }, timeoutMs);
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (status) => { clearTimeout(timer); resolve({ status, out }); });
  });
}

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-install-"));
  // Windows hands out the same folder under two spellings: the 8.3 short name
  // (C:\Users\RUNNER~1\...) and the long one. The agent canonicalises its home
  // on purpose, so a test that held on to the short spelling would be comparing
  // two names for one folder and failing on Windows only.
  try {
    return fs.realpathSync.native(dir);
  } catch {
    return dir;
  }
}

// Every model the installer can offer. Kept beside the installer's own table:
// a test that only served the current default would go quiet the day the
// recommendation changes, which is exactly when it should speak up.
const MODEL_FILES = ["ggml-large-v3-turbo.bin", "ggml-medium.bin", "ggml-small.bin", "ggml-base.bin", "ggml-tiny.bin"];

/** A model file is "ggml" plus enough bytes to not look like an error page. */
function fakeModel(size = 2 * 1024 * 1024) {
  const b = Buffer.alloc(size);
  b.write("ggml", 0, "ascii");
  return b;
}

/**
 * Put a program in the speech folder that really does start, so a test about a
 * later step is not stopped by the engine check. A file with batch text in it
 * named .exe cannot run on Windows, so there the stand-in is a copy of the Node
 * binary running this test: it answers --help and exits 0, which is all the
 * installer asks of an engine. Returns the file name it used.
 */
function workingEngine(speech) {
  const isWin = process.platform === "win32";
  const binName = isWin ? "whisper-cli.exe" : "whisper-cli";
  const dest = path.join(speech, binName);
  if (isWin) {
    fs.copyFileSync(process.execPath, dest);
  } else {
    fs.writeFileSync(dest, "#!/bin/sh\necho usage\n");
    fs.chmodSync(dest, 0o755);
  }
  return binName;
}

async function serve(routes) {
  const server = http.createServer((req, res) => {
    const route = routes[req.url.split("?")[0]];
    if (!route) {
      res.writeHead(404).end("no");
      return;
    }
    route(req, res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    // close() alone leaves keep-alive sockets open and the test run never ends.
    close: () => { server.closeAllConnections?.(); server.close(); },
  };
}

test("the right Windows build is picked out of a release list, and a release without one is skipped", async () => {
  const { pickWindowsAsset } = await import(LIB);
  const releases = [
    { tag_name: "v1.9.0", assets: [{ name: "source.tar.gz", browser_download_url: "u1" }] },
    { tag_name: "v1.8.0", assets: [{ name: "whisper-bin-Win32.zip", browser_download_url: "u2" }, { name: "whisper-bin-x64.zip", browser_download_url: "u3" }] },
  ];
  const hit = pickWindowsAsset(releases);
  assert.equal(hit.url, "u3", "the x64 build, not the 32-bit one");
  assert.equal(hit.tag, "v1.8.0", "and the release it actually came from");

  assert.equal(pickWindowsAsset([{ tag_name: "v2", assets: [{ name: "readme.txt", browser_download_url: "x" }] }]), null);
  assert.equal(pickWindowsAsset([]), null);
  assert.equal(pickWindowsAsset(null), null);
});

test("a release holding both programs yields whisper-cli, never the retired main", async () => {
  // Reported from a real machine: the install completed, and the engine it had
  // chosen was main.exe — which in current whisper.cpp only prints "the binary
  // 'main.exe' is deprecated, please use 'whisper-cli.exe' instead" and exits
  // 1. Both files sit in the same release, so which one is found first is down
  // to the order the folder is listed in; preference has to be explicit.
  const { findBinary, WINDOWS_BIN_NAMES, UNIX_BIN_NAMES } = await import(LIB);
  const dir = tmp();
  try {
    for (const [names, stub, wanted] of [[WINDOWS_BIN_NAMES, "main.exe", "whisper-cli.exe"], [UNIX_BIN_NAMES, "main", "whisper-cli"]]) {
      const box = path.join(dir, wanted);
      fs.mkdirSync(path.join(box, "bin"), { recursive: true });
      // The retired one shallower than the supported one, so a plain
      // first-match search would take it.
      fs.writeFileSync(path.join(box, stub), "x");
      fs.writeFileSync(path.join(box, "bin", wanted), "x");
      assert.equal(path.basename(findBinary(box, names)), wanted);

      // And when the retired program is genuinely all there is, it is still
      // better than refusing to install anything.
      const only = path.join(dir, `only-${stub}`);
      fs.mkdirSync(only, { recursive: true });
      fs.writeFileSync(path.join(only, stub), "x");
      assert.equal(path.basename(findBinary(only, names)), stub);
    }
    assert.equal(findBinary(path.join(dir, "nothing-here"), WINDOWS_BIN_NAMES), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a complete download is kept; a truncated one is thrown away", async () => {
  const { download } = await import(LIB);
  const dir = tmp();
  const body = fakeModel();
  const s = await serve({
    "/good": (_req, res) => { res.writeHead(200, { "content-length": String(body.length) }).end(body); },
    // Sends part of the file and then goes quiet without ever closing — the
    // shape of a Wi-Fi drop or a captive portal. Nothing times this out for us:
    // if the download had no stall limit, the installer would sit here forever.
    "/short": (_req, res) => {
      res.writeHead(200, { "content-length": String(body.length * 2) });
      res.write(body);
    },
    "/missing": (_req, res) => { res.writeHead(404).end("nope"); },
  });
  try {
    const dest = path.join(dir, "ggml-small.bin");
    const size = await download(`${s.base}/good`, dest, { label: "model" });
    assert.equal(size, body.length);
    assert.equal(fs.existsSync(dest), true);

    const shortDest = path.join(dir, "short.bin");
    await assert.rejects(() => download(`${s.base}/short`, shortDest, { label: "model", stallMs: 800 }), /went quiet|stopped responding|stopped early/);
    assert.equal(fs.existsSync(shortDest), false, "a partial file must never be left behind");
    assert.equal(fs.existsSync(shortDest + ".part"), false, "and neither must the scratch file");

    await assert.rejects(() => download(`${s.base}/missing`, path.join(dir, "x.bin"), { label: "engine" }), /HTTP 404/);
  } finally {
    s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an error page wearing a model's name is not mistaken for a model", async () => {
  const { looksLikeModel, isMultilingual } = await import(LIB);
  const dir = tmp();
  try {
    const real = path.join(dir, "ggml-small.bin");
    fs.writeFileSync(real, fakeModel());
    assert.equal(looksLikeModel(real), true);

    const html = path.join(dir, "ggml-medium.bin");
    fs.writeFileSync(html, Buffer.alloc(3 * 1024 * 1024, "<"));
    assert.equal(looksLikeModel(html), false, "wrong magic bytes");

    const tiny = path.join(dir, "ggml-base.bin");
    fs.writeFileSync(tiny, "ggml");
    assert.equal(looksLikeModel(tiny), false, "far too small to be a model");

    assert.equal(looksLikeModel(path.join(dir, "not-there.bin")), false);

    // The ".en" builds cannot do Hebrew at any size.
    assert.equal(isMultilingual(path.join(dir, "ggml-small.bin")), true);
    assert.equal(isMultilingual(path.join(dir, "ggml-small.en.bin")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the program is installed together with the libraries it needs, wherever the zip hid it", async () => {
  const { findBinary, installFrom, WINDOWS_BIN_NAMES } = await import(LIB);
  const dir = tmp();
  try {
    // Releases have nested the binaries differently over the years, so the
    // search has to find it rather than expect it at the top.
    const nested = path.join(dir, "unpack", "Release", "bin");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, "whisper-cli.exe"), "program");
    fs.writeFileSync(path.join(nested, "ggml.dll"), "library");
    fs.writeFileSync(path.join(nested, "whisper.dll"), "library");
    fs.mkdirSync(path.join(dir, "unpack", "docs"));
    fs.writeFileSync(path.join(dir, "unpack", "docs", "README.md"), "text");

    const found = findBinary(path.join(dir, "unpack"), WINDOWS_BIN_NAMES);
    assert.equal(path.basename(found), "whisper-cli.exe");

    const into = path.join(dir, "speech");
    const { installed, files } = installFrom(found, into, { chmod: false });
    assert.equal(installed, path.join(into, "whisper-cli.exe"));
    // Without the DLLs beside it the program would look installed and then
    // fail on the first word spoken.
    assert.deepEqual(files.sort(), ["ggml.dll", "whisper-cli.exe", "whisper.dll"]);
    for (const f of files) assert.equal(fs.existsSync(path.join(into, f)), true);

    assert.equal(findBinary(path.join(dir, "no-such-dir"), WINDOWS_BIN_NAMES), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the installer leaves JARVIS able to hear, and says so only after checking", async (t) => {
  // The whole script, run as the user runs it, against a local server standing
  // in for GitHub and Hugging Face. On Windows it takes the ready-made-build
  // path; elsewhere there is no prebuilt binary to fetch, so the engine is put
  // in place first and the script is checked from the model step onwards.
  const home = tmp();
  const speech = path.join(home, "speech");
  fs.mkdirSync(speech, { recursive: true });
  const isWin = process.platform === "win32";

  // A stand-in engine that behaves like whisper.cpp: it writes the transcript
  // file the caller asked for. The installer now runs it for real, so a stub
  // that only prints something would not be enough.
  const binName = isWin ? "whisper-cli.exe" : "whisper-cli";
  const stub = path.join(__dirname, "..", "..", "scripts", "e2e", "stub-whisper.mjs");
  fs.writeFileSync(path.join(speech, binName), isWin ? `@echo off\r\nnode "${stub}" %*\r\n` : `#!/bin/sh\nexec node "${stub}" "$@"\n`);
  if (!isWin) fs.chmodSync(path.join(speech, binName), 0o755);
  if (isWin) t.diagnostic("windows: a file named .exe that is really a script cannot be executed, which is the failure path asserted below");

  const model = fakeModel();
  // Whichever model the installer recommends, this stands in for it: the test
  // is about the steps, not about which name is the default this month.
  const serveModel = (_req, res) => { res.writeHead(200, { "content-length": String(model.length) }).end(model); };
  const s = await serve(Object.fromEntries(MODEL_FILES.map((f) => [`/${f}`, serveModel])));
  try {
    // A dead release address, so no test can ever reach the real internet.
    const env = { JARVIS_HOME: home, JARVIS_WHISPER_MODEL_BASE: s.base, JARVIS_WHISPER_RELEASES_API: "http://127.0.0.1:9/none" };

    if (isWin) {
      // Windows will not run a script named .exe, so the stand-in cannot start.
      // The installer must treat that as "not installed" and try to replace it,
      // rather than trusting a program it was never able to run.
      const w = await runInstaller(env, 60000, /Looking for the latest/i);
      assert.ok(!/Ready\./.test(w.out), `it must not say Ready for an engine it could not run:\n${w.out}`);
      assert.match(w.out, /cannot start/i, w.out);
      return;
    }

    const r = await runInstaller(env);
    const out = r.out;
    assert.match(out, /speech engine is already here, and it runs/, out);
    assert.match(out, /Model installed: ggml-[a-z0-9.-]+\.bin/);
    // Finding the files is not the claim — running the engine is.
    assert.match(out, /Checking that the engine really runs/);
    assert.equal(r.status, 0, out);
    assert.match(out, /Ready\./, out);
    assert.match(out, /Hebrew: yes/);
    assert.match(out, /תתעורר/, "it must end by telling you what to say");

    // It wrote the two paths into the config rather than leaving detection to
    // guesswork, and the model really is on disk.
    const cfg = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
    const installed = fs.readdirSync(speech).filter((f) => f.endsWith(".bin"));
    assert.equal(installed.length, 1, `exactly one model should be installed, found ${installed.join(", ")}`);
    assert.equal(cfg.voice.whisperModel, path.join(speech, installed[0]));
    assert.equal(path.basename(cfg.voice.whisperPath), binName);
    assert.equal(cfg.voice.enabled, true);
    assert.equal(fs.statSync(cfg.voice.whisperModel).size, model.length);
  } finally {
    s.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a model that never arrives is refused, and the manual steps are printed", async () => {
  const home = tmp();
  const speech = path.join(home, "speech");
  fs.mkdirSync(speech, { recursive: true });
  const isWin = process.platform === "win32";
  workingEngine(speech);

  // Serves an HTML error page under the model's name — the failure a proxy or a
  // rate limit actually produces.
  const junk = Buffer.alloc(2 * 1024 * 1024, "<");
  const serveJunk = (_req, res) => { res.writeHead(200, { "content-length": String(junk.length) }).end(junk); };
  const s = await serve(Object.fromEntries(MODEL_FILES.map((f) => [`/${f}`, serveJunk])));
  try {
    const r = await runInstaller({ JARVIS_HOME: home, JARVIS_WHISPER_MODEL_BASE: s.base, JARVIS_WHISPER_RELEASES_API: "http://127.0.0.1:9/none" });
    const out = r.out;
    assert.equal(r.status, 1, "a failed install must not report success");
    assert.match(out, /not a speech model/);
    assert.deepEqual(fs.readdirSync(speech).filter((f) => f.endsWith(".bin")), [], "the junk must not be kept");
    // And it must tell the user how to do it themselves — the Windows steps
    // point at the ready-made build and the model download, the others at
    // building it, so assert on what both have to name.
    assert.match(out, /by hand/);
    assert.match(out, /whisper\.cpp/);
    assert.match(out, isWin ? /huggingface\.co/ : /download-ggml-model/);
    assert.ok(out.includes(speech), "the steps must name the folder to put it in");
  } finally {
    s.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("an engine already there but unable to start is replaced, not trusted", async () => {
  // Reported from a real machine: an earlier install had left main.exe without
  // the libraries beside it. The installer saw a program in the folder, said
  // "already here", and skipped the download that would have repaired it — so
  // the fix could never reach the person who needed it. Presence is not proof.
  const home = tmp();
  const speech = path.join(home, "speech");
  fs.mkdirSync(speech, { recursive: true });
  const isWin = process.platform === "win32";
  const binName = isWin ? "whisper-cli.exe" : "whisper-cli";
  const broken = path.join(speech, binName);

  // A file that exists and is found, but cannot run: on POSIX it has no execute
  // bit, on Windows it is not a real executable at all.
  fs.writeFileSync(broken, "not a program");
  if (!isWin) fs.chmodSync(broken, 0o644);
  // A stale library from the broken install, and the model, which must survive.
  fs.writeFileSync(path.join(speech, isWin ? "stale.dll" : "stale.so"), "old");
  const model = fakeModel();
  fs.writeFileSync(path.join(speech, "ggml-small.bin"), model);

  // No release server is offered, so the reinstall it now attempts must fail —
  // which is the proof that it stopped trusting the broken copy and tried.
  // Stop as soon as it starts installing a replacement — carrying on means a
  // download or a full source build, neither of which this test is about.
  const r = await runInstaller(
    { JARVIS_HOME: home, JARVIS_WHISPER_RELEASES_API: "http://127.0.0.1:9/none", JARVIS_WHISPER_MODEL_BASE: "http://127.0.0.1:9" },
    60000,
    /Looking for the latest|has to be built here/i,
  );
  const out = r.out;

  assert.ok(!/already here, and it runs/.test(out), `it must not accept a program that cannot start:\n${out}`);
  assert.match(out, /cannot start/i, out);
  assert.match(out, /Replacing it/i, "and it must say it is replacing it");
  assert.ok(/Looking for the latest|has to be built here/i.test(out), `and then actually try to install one:\n${out}`);

  // The broken program and its stale library are gone; the big download is not.
  assert.equal(fs.existsSync(broken), false, "the broken program must be cleared out");
  assert.equal(fs.existsSync(path.join(speech, isWin ? "stale.dll" : "stale.so")), false, "and so must its stale libraries");
  assert.equal(fs.existsSync(path.join(speech, "ggml-small.bin")), true, "but the 466 MB model must be kept");
  assert.equal(fs.statSync(path.join(speech, "ggml-small.bin")).size, model.length);

  fs.rmSync(home, { recursive: true, force: true });
});

test("a model too poor for Hebrew is offered the better one, and the old file is left alone", async () => {
  // From a real machine: the wake phrase "תתעורר" came back as "תפקות". The
  // installer used to say "a speech model is already here" and stop, so the one
  // thing that would have fixed it was never mentioned. ggml-base is the size
  // where Hebrew stops working at all; small is offered as the replacement
  // because it answers in about a second, which is what talking needs.
  const home = tmp();
  const speech = path.join(home, "speech");
  fs.mkdirSync(speech, { recursive: true });
  workingEngine(speech);
  const weak = path.join(speech, "ggml-base.bin");
  fs.writeFileSync(weak, fakeModel());

  const model = fakeModel();
  const serveModel = (_req, res) => { res.writeHead(200, { "content-length": String(model.length) }).end(model); };
  const s = await serve(Object.fromEntries(MODEL_FILES.map((f) => [`/${f}`, serveModel])));
  try {
    // stdin is closed, so the prompt reads EOF and takes its default — which
    // must be the upgrade, not "leave it as it was".
    const r = await runInstaller({ JARVIS_HOME: home, JARVIS_WHISPER_MODEL_BASE: s.base, JARVIS_WHISPER_RELEASES_API: "http://127.0.0.1:9/none" });
    assert.match(r.out, /wrong more often than not/, r.out);
    assert.match(r.out, /ggml-small\.bin/, "it must name the model it offers");
    const better = path.join(speech, "ggml-small.bin");
    assert.equal(fs.existsSync(better), true, `the better model was not installed. Output:\n${r.out}`);
    const cfg = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
    assert.equal(cfg.voice.whisperModel, better, "the config must point at the model that hears Hebrew");
    assert.equal(fs.existsSync(weak), true, "the old model is the user's file — deleting it is not ours to do");
    assert.match(r.out, /delete it yourself/i, "and it says how to get the space back");
  } finally {
    s.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("re-running the installer keeps the model JARVIS is already set to use", async () => {
  // With both models installed, picking one by the order of a list would move
  // someone who chose accuracy onto the fast one, or the reverse — silently,
  // just for running the installer again.
  const home = tmp();
  const speech = path.join(home, "speech");
  fs.mkdirSync(speech, { recursive: true });
  const binName = workingEngine(speech);
  const small = path.join(speech, "ggml-small.bin");
  const turbo = path.join(speech, "ggml-large-v3-turbo.bin");
  fs.writeFileSync(small, fakeModel());
  fs.writeFileSync(turbo, fakeModel());
  // JARVIS is set to the big one on purpose.
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ voice: { enabled: true, whisperPath: path.join(speech, binName), whisperModel: turbo } }));

  const r = await runInstaller({ JARVIS_HOME: home, JARVIS_WHISPER_RELEASES_API: "http://127.0.0.1:9/none" });
  const cfg = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
  assert.equal(cfg.voice.whisperModel, turbo, `the configured model must survive. Output:\n${r.out}`);
  assert.match(r.out, /the one JARVIS is set to use/, r.out);
  // Both are listed, with the one in use marked — switching between them is a
  // choice to make here, not a 1.6 GB file to delete. (The prompt itself is not
  // asserted: with stdin closed, readline never echoes it.)
  assert.match(r.out, /Also installed here/, r.out);
  assert.match(r.out, /turbo/, "the one in use");
  assert.match(r.out, /small/, "and the one it is not using");
  assert.equal(fs.existsSync(small), true, "nothing is deleted");
  fs.rmSync(home, { recursive: true, force: true });
});
