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

import { LADDER, pickFastest } from "./lib/pick-model.mjs";
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
const current = cfg0.voice?.whisperModel?.trim() || LADDER.map((m) => join(speechDir, m.file)).find(existsSync) || "";
if (!current) console.log(`${C.y}No model is installed yet — the smaller ones will be tried from scratch.${C.r}`);

const out = await pickFastest({
  current,
  speechDir,
  join,
  targetMs: TARGET_MS,
  exists: existsSync,
  measure: (model) => measure(engine, model, cfg0, sample),
  fetchModel: async (file, dest) => {
    try {
      await download(`${MODEL_BASE}/${file}`, dest, { label: file });
      console.log("done");
    } catch (e) {
      // A half-written file would look installed next time round.
      try { if (existsSync(dest)) unlinkSync(dest); } catch { /* nothing to clean */ }
      throw e;
    }
  },
  onStep: (step) => {
    if (step.kind === "measured") {
      console.log(`  ${step.file.padEnd(24)} ${step.ok ? C.g : C.y}${ms(step.ms).padStart(8)}${C.r} per sentence${step.hebrew ? `  ${C.dim}${step.hebrew}${C.r}` : ""}`);
      if (!step.ok && step.file === basename(current)) console.log(`\n${C.dim}Too slow for talking to. Trying the smaller models below it.${C.r}`);
    } else if (step.kind === "downloading") {
      process.stdout.write(`  downloading ${step.file} (${String(step.mb)} MB, free)… `);
    } else if (step.kind === "download_failed") {
      console.log(`${C.y}could not download: ${step.error.slice(0, 100)}${C.r}`);
    } else if (step.kind === "failed") {
      console.log(`  ${C.red}${step.file}: could not run it — ${step.error.slice(0, 100)}${C.r}`);
    }
  },
});

if (!out.model) {
  console.log(`\n${C.red}Nothing could be measured, so nothing was changed.${C.r}\n`);
  whisperServer.stop("done");
  process.exit(1);
}

if (!out.changed && out.before !== null && out.before <= TARGET_MS) {
  config.update({ voice: { mode: "fast", keepModelLoaded: true } });
  console.log(`\n${C.g}${C.b}Already fast:${C.r} ${basename(out.model)} answers in ${secs(out.took)} here.`);
  console.log(`Model kept in memory: on. Fast mode: on. Nothing else to change.\n`);
  whisperServer.stop("done");
  process.exit(0);
}

// Pinned, so the agent does not promote this machine back to a model it has
// just been measured as unable to run in time.
config.update({ voice: { whisperModel: out.model, modelPinned: true, mode: "fast", keepModelLoaded: true, gpu: "auto" } });
const size = Math.round(statSync(out.model).size / 1024 / 1024);

console.log(`\n${C.b}Now set to ${basename(out.model)}${C.r} ${C.dim}(${String(size)} MB)${C.r}`);
if (out.changed && out.before !== null) {
  console.log(`  ${basename(current)}: ${C.y}${secs(out.before)}${C.r}   →   ${basename(out.model)}: ${C.g}${secs(out.took)}${C.r} per sentence, measured here`);
} else {
  console.log(`  ${secs(out.took)} per sentence, measured here`);
}
console.log(`  Model kept in memory: on · Fast mode: on`);

if (out.step && /base|tiny/.test(out.step.file)) {
  console.log(`\n${C.y}What this costs:${C.r} ${out.step.hebrew}. It will mishear Hebrew more often than the model you had.`);
  console.log(`${C.dim}The wake word is unaffected — it is matched in the window itself, in about a millisecond,`);
  console.log(`and never reaches the model. To go back: npm run voice, and choose small.${C.r}`);
}
if (out.took > TARGET_MS) {
  console.log(`\n${C.y}Even the fastest model needs ${secs(out.took)} on this processor.${C.r}`);
  console.log(`${C.dim}That is the hardware, not a setting: whisper.cpp has no partial results to show while it works.${C.r}`);
}
console.log(`\nRestart JARVIS for this to take effect:  ${C.c}npm start${C.r}\n`);
whisperServer.stop("done");
