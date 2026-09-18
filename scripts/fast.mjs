#!/usr/bin/env node
// Make JARVIS answer as fast as this computer can, and say the real numbers.
//
// The wait when you talk to JARVIS is almost entirely one thing: the speech
// engine turning your sentence into text. How long that takes depends on the
// model and on the processor in front of it — ggml-small answers in about a
// second on a current laptop and in twelve on a modest one, and no setting
// changes that arithmetic.
//
// So this does not promise anything. It measures the models on THIS computer,
// downloads a smaller one (free, from the whisper.cpp model repository) if what
// is installed cannot keep up, picks the fastest that still understands Hebrew,
// switches the model into memory so it is not re-read from disk every sentence,
// and prints what it measured before and after. If the fastest possible here is
// still slow, it says so in seconds rather than pretending.
//
// Run: npm run fast
import { existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { cpus, totalmem } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { download } from "./lib/whisper-install.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const C = { r: "\x1b[0m", b: "\x1b[1m", dim: "\x1b[2m", g: "\x1b[32m", y: "\x1b[33m", c: "\x1b[36m", red: "\x1b[31m" };
const require = createRequire(pathToFileURL(join(ROOT, "desktop", "package.json")));

const paths = require("./src/core/paths.js");
const config = require("./src/core/config.js");
const stt = require("./src/core/voice/stt.js");
const whisperServer = require("./src/core/voice/whisper-server.js");

const MODEL_BASE = process.env.JARVIS_WHISPER_MODEL_BASE ?? "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

// What "fast enough to talk to" means: a sentence understood inside this, and
// the wake word is already instant in the window whatever this says.
const TARGET_MS = 1200;
const ROUNDS = 3;

// Multilingual models only — the ".en" builds cannot do Hebrew at any size.
// Ordered fastest last: this walks down only as far as it has to.
const LADDER = [
  { file: "ggml-large-v3-turbo.bin", mb: 1624, hebrew: "the best Hebrew there is" },
  { file: "ggml-medium.bin", mb: 1533, hebrew: "very good Hebrew" },
  { file: "ggml-small.bin", mb: 466, hebrew: "good Hebrew, drops a letter now and then" },
  { file: "ggml-base.bin", mb: 148, hebrew: "rough Hebrew — gets short words wrong" },
  { file: "ggml-tiny.bin", mb: 75, hebrew: "poor Hebrew — short commands only" },
];

const ms = (n) => `${String(Math.round(n))} ms`;
const secs = (n) => `${String(Math.round(n / 100) / 10)}s`;
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/** A second of speech-shaped sound — a wobbling tone, not silence. */
function sampleWav(seconds = 1.2, rate = 16000) {
  const n = Math.round(seconds * rate);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write("WAVEfmt ", 8, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const wobble = 1 + 0.3 * Math.sin((2 * Math.PI * 7 * i) / rate);
    const v = Math.sin((2 * Math.PI * 320 * wobble * i) / rate) * 0.35;
    buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(v * 32767))), 44 + i * 2);
  }
  return buf;
}

/**
 * How long this model really takes here, as JARVIS runs it: fast mode, the
 * model held in memory. The first run pays for loading it and is dropped,
 * because that cost is paid once and not per sentence.
 */
async function measure(engine, model, cfg0, sample) {
  // modelPinned, or the agent's own "a better model is sitting beside this weak
  // one" rule would quietly measure ggml-small three times over.
  const cfg = { ...cfg0, voice: { ...cfg0.voice, whisperPath: engine, whisperModel: model, modelPinned: true, mode: "fast", keepModelLoaded: true } };
  const runs = [];
  for (let i = 0; i < ROUNDS + 1; i++) {
    stt.resetCache();
    const out = await stt.transcribe(sample, { cfg, language: cfg0.voice?.language || "he" });
    if (i > 0) runs.push(out.tookMs);
  }
  return median(runs);
}

console.log(`\n${C.b}JARVIS — as fast as this computer can answer${C.r}`);
console.log(`${C.dim}Measured here, on this processor. Nothing is downloaded unless it is needed.${C.r}\n`);

const cfg0 = config.load();
const engine = cfg0.voice?.whisperPath?.trim();
const speechDir = join(paths.HOME, "speech");

if (!engine || !existsSync(engine)) {
  console.log(`${C.y}The speech engine is not installed yet, so there is nothing to measure.${C.r}`);
  console.log(`Install it first (free):  ${C.c}npm run voice${C.r}\n`);
  process.exit(0);
}
mkdirSync(speechDir, { recursive: true });

const cores = cpus().length;
const ramGb = Math.round(totalmem() / 1024 ** 3);
console.log(`${C.dim}This computer: ${String(cores)} processor cores, ${String(ramGb)} GB memory · engine ${basename(engine)}${C.r}\n`);

const sample = sampleWav();
const installed = (f) => existsSync(join(speechDir, f));
const current = cfg0.voice?.whisperModel?.trim() || LADDER.map((m) => join(speechDir, m.file)).find(existsSync) || "";

// --- 1. what it does now -----------------------------------------------------
let before = null;
if (current && existsSync(current)) {
  process.stdout.write(`  measuring ${basename(current)}… `);
  try {
    before = await measure(engine, current, cfg0, sample);
    console.log(`${before <= TARGET_MS ? C.g : C.y}${ms(before)}${C.r} per sentence`);
  } catch (e) {
    console.log(`${C.red}could not run it: ${e.message.slice(0, 120)}${C.r}`);
  }
} else {
  console.log(`${C.y}No model is installed yet.${C.r}`);
}

if (before !== null && before <= TARGET_MS) {
  config.update({ voice: { mode: "fast", keepModelLoaded: true } });
  console.log(`\n${C.g}${C.b}Already fast:${C.r} ${basename(current)} answers in ${secs(before)} here.`);
  console.log(`Model kept in memory: on. Fast mode: on. Nothing else to change.\n`);
  whisperServer.stop("done");
  process.exit(0);
}

// --- 2. walk down the ladder until one keeps up ------------------------------
const startAt = current ? LADDER.findIndex((m) => m.file.toLowerCase() === basename(current).toLowerCase()) : -1;
const below = LADDER.slice(startAt >= 0 ? startAt + 1 : LADDER.length - 2);

if (!below.length) {
  console.log(`\n${C.y}${basename(current)} is already the smallest model there is, and it needs ${secs(before ?? 0)} here.${C.r}`);
  console.log(`That is this processor's speed, not a setting. The wake word stays instant either way.\n`);
  whisperServer.stop("done");
  process.exit(0);
}

console.log(`\n${C.dim}Too slow for talking to. Trying the smaller models below it.${C.r}`);

let best = before !== null ? { model: current, took: before } : null;
for (const step of below) {
  const dest = join(speechDir, step.file);
  if (!installed(step.file)) {
    process.stdout.write(`  downloading ${step.file} (${String(step.mb)} MB, free)… `);
    try {
      await download(`${MODEL_BASE}/${step.file}`, dest, { label: step.file });
      console.log("done");
    } catch (e) {
      console.log(`${C.y}could not download: ${e.message.slice(0, 100)}${C.r}`);
      try { if (existsSync(dest)) unlinkSync(dest); } catch { /* nothing to clean */ }
      continue;
    }
  }
  process.stdout.write(`  measuring ${step.file}… `);
  let took;
  try {
    took = await measure(engine, dest, cfg0, sample);
  } catch (e) {
    console.log(`${C.red}could not run it: ${e.message.slice(0, 100)}${C.r}`);
    continue;
  }
  console.log(`${took <= TARGET_MS ? C.g : C.y}${ms(took)}${C.r}  ${C.dim}${step.hebrew}${C.r}`);
  if (!best || took < best.took) best = { model: dest, took, step };
  if (took <= TARGET_MS) break;
}

// --- 3. keep the fastest, and say what it cost -------------------------------
if (!best) {
  console.log(`\n${C.red}Nothing could be measured, so nothing was changed.${C.r}\n`);
  whisperServer.stop("done");
  process.exit(1);
}

// Pinned, so the agent does not promote the machine back to a model it has
// just been measured as unable to run in time.
config.update({ voice: { whisperModel: best.model, modelPinned: true, mode: "fast", keepModelLoaded: true, gpu: "auto" } });
const size = Math.round(statSync(best.model).size / 1024 / 1024);

console.log(`\n${C.b}Now set to ${basename(best.model)}${C.r} ${C.dim}(${String(size)} MB)${C.r}`);
if (before !== null && best.model !== current) {
  console.log(`  ${basename(current)}: ${C.y}${secs(before)}${C.r}   →   ${basename(best.model)}: ${C.g}${secs(best.took)}${C.r} per sentence, measured here`);
} else {
  console.log(`  ${secs(best.took)} per sentence, measured here`);
}
console.log(`  Model kept in memory: on · Fast mode: on`);

if (best.step && /base|tiny/.test(best.step.file)) {
  console.log(`\n${C.y}What this costs:${C.r} ${best.step.hebrew}. It will mishear Hebrew more often than ggml-small did.`);
  console.log(`${C.dim}The wake word is unaffected — it is matched in the window itself, in about a millisecond,`);
  console.log(`and never reaches the model. To go back: npm run voice, and choose small.${C.r}`);
}
if (best.took > TARGET_MS) {
  console.log(`\n${C.y}Even the fastest model needs ${secs(best.took)} on this processor.${C.r}`);
  console.log(`${C.dim}That is the hardware, not a setting: whisper.cpp has no partial results to show while it works.${C.r}`);
}
console.log(`\nRestart JARVIS for this to take effect:  ${C.c}npm start${C.r}\n`);
whisperServer.stop("done");
