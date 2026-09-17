#!/usr/bin/env node
// Set up local speech recognition — free, open source, and entirely on this
// computer.
//
//   npm run voice        (or double-click INSTALL-VOICE.bat on Windows)
//
// It downloads the whisper.cpp engine and a multilingual model into
// ~/.jarvis/speech, points JARVIS at them, and then asks JARVIS itself whether
// it can hear you now — so the "ready" at the end is something it checked, not
// something this script hopes.
//
// Nothing here needs an account, a key or a payment. You run it once,
// deliberately: JARVIS never downloads anything by itself, and once these files
// are on the machine no audio ever leaves it.
import { createRequire } from "node:module";
import { createInterface } from "node:readline/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { download, findBinary, fmtMb, installFrom, looksLikeModel, pickWindowsAsset, UNIX_BIN_NAMES, WINDOWS_BIN_NAMES } from "./lib/whisper-install.mjs";
import { runSync, WIN } from "./spawn-compat.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(pathToFileURL(path.join(ROOT, "desktop", "package.json")));
const paths = require("./src/core/paths.js");
const config = require("./src/core/config.js");
const stt = require("./src/core/voice/stt.js");

const C = { r: "\x1b[0m", b: "\x1b[1m", dim: "\x1b[2m", g: "\x1b[32m", y: "\x1b[33m", red: "\x1b[31m", c: "\x1b[36m" };
const say = (m) => { console.log(`${C.c}▸${C.r} ${m}`); };
const ok = (m) => { console.log(`${C.g}✔${C.r} ${m}`); };
const warn = (m) => { console.log(`${C.y}!${C.r} ${m}`); };
const bad = (m) => { console.log(`${C.red}✕${C.r} ${m}`); };

// Where JARVIS looks. Keep this in step with desktop/src/core/voice/stt.js.
const SPEECH_DIR = path.join(paths.HOME, "speech");
const BIN_NAMES = WIN ? WINDOWS_BIN_NAMES : UNIX_BIN_NAMES;

// Overridable so the tests can point the whole thing at a local server.
const RELEASES_API = process.env.JARVIS_WHISPER_RELEASES_API ?? "https://api.github.com/repos/ggml-org/whisper.cpp/releases";
const MODEL_BASE = process.env.JARVIS_WHISPER_MODEL_BASE ?? "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

// Models, largest first. A model without ".en" in its name is multilingual and
// understands Hebrew; the ".en" builds cannot, at any size.
const MODELS = [
  { id: "medium", file: "ggml-medium.bin", mb: 1533, needsGb: 16, why: "most accurate Hebrew, slower on an older PC" },
  { id: "small", file: "ggml-small.bin", mb: 466, needsGb: 8, why: "good Hebrew, comfortable on most computers" },
  { id: "base", file: "ggml-base.bin", mb: 148, needsGb: 4, why: "quick, but misses words more often" },
  { id: "tiny", file: "ggml-tiny.bin", mb: 75, needsGb: 2, why: "fastest and least accurate — for trying it out" },
];

const GB = 1024 ** 3;

function ask(rl, q) {
  return process.stdin.isTTY ? rl.question(q) : Promise.resolve("");
}

function progress(label) {
  let last = 0;
  return (got, total) => {
    const now = Date.now();
    if (!process.stdout.isTTY || now - last < 200) return;
    last = now;
    const pct = total ? `${String(Math.floor((got / total) * 100)).padStart(3)}%` : "";
    process.stdout.write(`\r  ${label} ${pct} ${fmtMb(got)}${total ? ` / ${fmtMb(total)}` : ""}   `);
  };
}

function clearLine() {
  if (process.stdout.isTTY) process.stdout.write("\r\x1b[K");
}

/** Windows ships an unzip inside PowerShell; elsewhere use the unzip command. */
function unzip(zip, into) {
  fs.mkdirSync(into, { recursive: true });
  const r = WIN
    ? runSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${into}' -Force`], { stdio: "inherit" })
    : runSync("unzip", ["-o", "-q", zip, "-d", into], { stdio: "inherit" });
  if (r.status !== 0) throw new Error(WIN ? "Windows could not unpack the download." : "Unpacking needs the `unzip` command. Install it and run this again.");
}

async function latestWindowsAsset() {
  const res = await fetch(`${RELEASES_API}?per_page=10`, { headers: { "user-agent": "jarvis-installer", accept: "application/vnd.github+json" } });
  if (!res.ok) throw new Error(`Could not read the whisper.cpp release list (HTTP ${String(res.status)}).`);
  const asset = pickWindowsAsset(await res.json());
  if (!asset) throw new Error("No ready-made Windows build was found in the recent whisper.cpp releases.");
  return asset;
}

function buildFromSource(into) {
  const has = (c) => runSync(c, ["--version"], { stdio: "ignore" }).status === 0;
  if (!has("git") || !has("cmake")) return { ok: false, reason: "Building needs `git` and `cmake`, and at least one of them is missing." };
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-build-"));
  const src = path.join(work, "whisper.cpp");
  say("Building whisper.cpp from source. This takes a few minutes.");
  if (runSync("git", ["clone", "--depth", "1", "https://github.com/ggml-org/whisper.cpp", src], { stdio: "inherit" }).status !== 0) return { ok: false, reason: "The source could not be downloaded." };
  if (runSync("cmake", ["-B", path.join(src, "build"), "-S", src], { stdio: "inherit" }).status !== 0) return { ok: false, reason: "cmake could not configure the build." };
  if (runSync("cmake", ["--build", path.join(src, "build"), "--config", "Release", "-j"], { stdio: "inherit" }).status !== 0) return { ok: false, reason: "The build failed." };
  const built = findBinary(path.join(src, "build"), BIN_NAMES);
  if (!built) return { ok: false, reason: "The build finished but produced no whisper program." };
  const { installed } = installFrom(built, into);
  try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* leave the build behind */ }
  return { ok: true, installed };
}

function manualSteps() {
  const steps = WIN ? stt.INSTALL_STEPS.whisper.windows : stt.INSTALL_STEPS.whisper.other;
  console.log(`\n${C.b}You can do exactly the same thing by hand:${C.r}`);
  for (const [i, s] of steps.entries()) console.log(`  ${String(i + 1)}. ${s}`);
  console.log("");
}

// --- run --------------------------------------------------------------------
const ramGb = Math.max(1, Math.round(os.totalmem() / GB));
console.log(`\n${C.b}JARVIS — speech recognition setup${C.r} ${C.dim}(free, open source, offline once installed)${C.r}`);
console.log(`${C.dim}Everything goes into ${SPEECH_DIR}${C.r}\n`);

const rl = createInterface({ input: process.stdin, output: process.stdout });
let exitCode = 0;

try {
  fs.mkdirSync(SPEECH_DIR, { recursive: true });

  // 1. The engine.
  let binary = findBinary(SPEECH_DIR, BIN_NAMES);
  if (binary) {
    ok(`The speech engine is already here: ${binary}`);
  } else if (WIN) {
    say("Looking for the latest ready-made Windows build of whisper.cpp…");
    const asset = await latestWindowsAsset();
    ok(`Found ${asset.name}${asset.tag ? ` (${asset.tag})` : ""}.`);
    const zip = path.join(SPEECH_DIR, asset.name);
    await download(asset.url, zip, { label: "engine", onProgress: progress("engine") });
    clearLine();
    const staging = path.join(SPEECH_DIR, ".unpack");
    fs.rmSync(staging, { recursive: true, force: true });
    unzip(zip, staging);
    const found = findBinary(staging, BIN_NAMES);
    if (!found) {
      fs.rmSync(staging, { recursive: true, force: true });
      fs.rmSync(zip, { force: true });
      throw new Error("The download unpacked, but there is no whisper program inside it. Nothing was installed.");
    }
    const { installed, files } = installFrom(found, SPEECH_DIR);
    fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(zip, { force: true });
    binary = installed;
    ok(`Engine installed (${String(files.length)} files): ${binary}`);
  } else {
    warn("whisper.cpp publishes ready-made programs for Windows only, so it has to be built here.");
    const built = buildFromSource(SPEECH_DIR);
    if (!built.ok) throw new Error(built.reason);
    binary = built.installed;
    ok(`Engine built and installed: ${binary}`);
  }

  // 2. The model.
  const already = MODELS.map((m) => path.join(SPEECH_DIR, m.file)).find((f) => fs.existsSync(f) && looksLikeModel(f));
  let modelFile = already ?? null;
  if (modelFile) {
    ok(`A speech model is already here: ${path.basename(modelFile)}`);
  } else {
    const fits = MODELS.filter((m) => m.needsGb <= ramGb);
    const suggested = fits.find((m) => m.id === "small") ?? fits[0] ?? MODELS[MODELS.length - 1];
    console.log(`\n  This computer has about ${String(ramGb)} GB of RAM. Models that understand Hebrew:`);
    for (const m of MODELS) {
      const mark = m.id === suggested.id ? `${C.g}→${C.r}` : " ";
      console.log(`  ${mark} ${C.b}${m.id.padEnd(7)}${C.r} ${String(m.mb).padStart(5)} MB  ${C.dim}${m.why}${C.r}`);
    }
    const answer = (await ask(rl, `\n  Which one? [${suggested.id}] `)).trim().toLowerCase();
    const chosen = MODELS.find((m) => m.id === answer) ?? suggested;
    const dest = path.join(SPEECH_DIR, chosen.file);
    say(`Downloading ${chosen.file} (about ${String(chosen.mb)} MB). This is the long part.`);
    await download(`${MODEL_BASE}/${chosen.file}`, dest, { label: "model", onProgress: progress("model") });
    clearLine();
    if (!looksLikeModel(dest)) {
      fs.rmSync(dest, { force: true });
      throw new Error("What came back is not a speech model — the file does not start with the GGML marker. Nothing was kept.");
    }
    modelFile = dest;
    ok(`Model installed: ${path.basename(modelFile)} (${fmtMb(fs.statSync(modelFile).size)})`);
  }

  // 3. Point JARVIS at exactly these two files, so nothing depends on guessing.
  config.update({ voice: { enabled: true, whisperPath: binary, whisperModel: modelFile } });
  stt.resetCache();

  // 4. Ask JARVIS itself. Anything else would be this script telling you it worked.
  say("Asking JARVIS whether it can hear you now…");
  const d = await stt.detect(config.load(), { force: true });
  if (!d.available) {
    bad(`JARVIS still cannot use it: ${d.reason ?? "unknown reason"}`);
    manualSteps();
    exitCode = 1;
  } else if (!d.hebrew) {
    warn(`The engine works, but ${path.basename(d.model)} is the English-only build, so Hebrew will not work.`);
    console.log(`  Delete it from ${SPEECH_DIR} and run this again to choose a multilingual model.`);
    exitCode = 1;
  } else {
    console.log("");
    ok(`${C.b}Ready.${C.r} Engine: ${d.engine} · model: ${path.basename(d.model)} · Hebrew: yes`);
    console.log(`\n  ${C.b}What to do now:${C.r}`);
    console.log(`  1. Start JARVIS  ${C.dim}(npm start, or the JARVIS shortcut on your desktop)${C.r}`);
    console.log(`  2. Press ${C.b}Enable microphone${C.r} and allow it`);
    console.log(`  3. Say ${C.b}"תתעורר"${C.r}, wait for LISTENING, then say what you want`);
    console.log(`\n  ${C.dim}"עצור" stops everything at any time. No recording ever leaves this computer.${C.r}\n`);
  }
} catch (e) {
  bad(e.message);
  console.log(`\n  ${C.dim}Nothing was left half-installed: the engine and the model are each kept only once they arrive complete.${C.r}`);
  manualSteps();
  exitCode = 1;
} finally {
  rl.close();
}

process.exit(exitCode);
