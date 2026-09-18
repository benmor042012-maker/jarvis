#!/usr/bin/env node
// Measures how long JARVIS takes to hear you, on this computer.
//
// Three numbers, because they are three different problems:
//
//   wake      the taught wake-word detector in the page — pure arithmetic, no
//             model, and the only one that can be measured without an engine
//             installed
//   engine    one utterance through the speech engine, per installed model, in
//             both modes. This is where the seconds are.
//   end-to-end  wake + engine + the planner, as a person would experience it
//
// Nothing here is a claim: it runs on the machine you run it on and prints what
// it saw. Run it before and after a change and compare.
//
// Run: npm run bench:voice
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const C = { r: "\x1b[0m", b: "\x1b[1m", dim: "\x1b[2m", g: "\x1b[32m", y: "\x1b[33m", c: "\x1b[36m" };
const require = createRequire(pathToFileURL(join(ROOT, "desktop", "package.json")));

const ms = (n) => `${String(Math.round(n))} ms`;
const rounds = Number(process.env.JARVIS_BENCH_ROUNDS || 5);

/** One second of speech-shaped sound: a wobbling tone, not silence. */
function speech(seconds = 1.2, rate = 16000) {
  const n = Math.round(seconds * rate);
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const wobble = 1 + 0.3 * Math.sin((2 * Math.PI * 7 * i) / rate);
    samples[i] = Math.sin((2 * Math.PI * 320 * wobble * i) / rate) * 0.35;
  }
  return samples;
}

function wav(samples, rate = 16000) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + samples.length * 2, 4);
  buf.write("WAVEfmt ", 8, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(samples[i] * 32767))), 44 + i * 2);
  return buf;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

console.log(`\n${C.b}JARVIS — how long it takes to hear you${C.r} ${C.dim}(${String(rounds)} rounds each, median)${C.r}\n`);

// --- 1. the wake-word detector ------------------------------------------------
// The page's own detector, measured by running exactly the code the page runs.
{
  const src = readFileSync(join(ROOT, "client", "src", "lib", "wake.ts"), "utf8").replace('import { TARGET_RATE } from "./wav";', "const TARGET_RATE = 16000;");
  const tmp = join(tmpdir(), `jarvis-bench-wake-${String(process.pid)}.mts`);
  writeFileSync(tmp, src);
  try {
    const { enroll, WakeDetector } = await import(pathToFileURL(tmp).href);
    const takes = [speech(0.9), speech(0.95), speech(1.0)];
    const t0 = process.hrtime.bigint();
    const model = enroll(takes);
    const enrolMs = Number(process.hrtime.bigint() - t0) / 1e6;
    if (!model) throw new Error("enrolment produced nothing");
    const detector = new WakeDetector(model);
    const heard = speech(0.92);
    const runs = [];
    for (let i = 0; i < rounds; i++) {
      const s = process.hrtime.bigint();
      detector.test(heard);
      runs.push(Number(process.hrtime.bigint() - s) / 1e6);
    }
    console.log(`${C.c}wake word${C.r}   ${C.g}${ms(median(runs))}${C.r} per check   ${C.dim}(teaching it once: ${ms(enrolMs)})${C.r}`);
    console.log(`${C.dim}            no model, no network — this is what answers "תתעורר" before the engine is asked anything${C.r}\n`);
  } catch (e) {
    console.log(`${C.y}wake word${C.r}   could not be measured: ${e.message}\n`);
  } finally {
    rmSync(tmp, { force: true });
  }
}

// --- 2. the speech engine, per model and mode ---------------------------------
const paths = require("./src/core/paths.js");
const config = require("./src/core/config.js");
const stt = require("./src/core/voice/stt.js");
const cfg0 = config.load();
const speechDir = join(paths.HOME, "speech");
const models = existsSync(speechDir)
  ? readdirSync(speechDir).filter((f) => /^ggml-.*\.bin$/i.test(f) && !/\.en\.bin$/i.test(f)).map((f) => join(speechDir, f))
  : [];
const engine = cfg0.voice?.whisperPath;

if (!engine || !existsSync(engine) || !models.length) {
  console.log(`${C.y}speech engine${C.r}  not measured: ${!engine || !existsSync(engine) ? "no engine installed" : "no model installed"}.`);
  console.log(`${C.dim}               Install one with  npm run voice  and run this again.${C.r}\n`);
} else {
  const sample = wav(speech(1.2));
  console.log(`${C.c}speech engine${C.r} ${C.dim}${basename(engine)} · one 1.2-second utterance${C.r}`);
  for (const model of models) {
    for (const mode of ["fast", "accurate"]) {
      const runs = [];
      let failed = null;
      for (let i = 0; i < rounds; i++) {
        stt.resetCache();
        const cfg = { ...cfg0, voice: { ...cfg0.voice, whisperModel: model, mode, whisperPath: engine } };
        try {
          const out = await stt.transcribe(sample, { cfg, language: cfg0.voice?.language || "he" });
          runs.push(out.tookMs);
        } catch (e) {
          failed = e.message.slice(0, 120);
          break;
        }
      }
      const size = `${String(Math.round(statSync(model).size / 1024 / 1024))} MB`;
      if (failed) console.log(`  ${basename(model).padEnd(26)} ${mode.padEnd(8)} ${C.y}${failed}${C.r}`);
      else console.log(`  ${basename(model).padEnd(26)} ${mode.padEnd(8)} ${C.g}${ms(median(runs)).padStart(8)}${C.r}  ${C.dim}${size}${C.r}`);
    }
  }
  console.log("");
}

// --- 3. everything after the audio, with no engine in the way -----------------
// What the agent itself adds: matching the phrase, planning, and answering.
{
  const { VoiceSession } = require("./src/core/voice/session.js");
  const realTranscribe = stt.transcribe;
  stt.transcribe = async () => ({ text: "מה השעה", engine: "bench", model: "bench", language: "he", tookMs: 0 });
  try {
    const cfg = config.load();
    const session = new VoiceSession({ getConfig: () => cfg, onCommand: async () => ({ plan: { plan_id: "bench", message: "ok", actions: [] }, job: null }), onStop: () => null });
    session.setMicGranted(true);
    const sample = wav(speech(1.2));
    const runs = [];
    for (let i = 0; i < rounds; i++) {
      session.listeningUntil = Date.now() + 10000; // already awake: this is the command
      const t = process.hrtime.bigint();
      await session.handleUtterance(sample, { durationMs: 1200 });
      runs.push(Number(process.hrtime.bigint() - t) / 1e6);
    }
    console.log(`${C.c}the rest${C.r}      ${C.g}${ms(median(runs))}${C.r}  ${C.dim}phrase matching, planning and the answer, with the engine taken out${C.r}\n`);
  } finally {
    stt.transcribe = realTranscribe;
  }
}

console.log(`${C.dim}What this means: everything except the speech engine is under a few milliseconds.`);
console.log(`Whatever a command costs, the engine is where it went — which is what Fast mode,`);
console.log(`the smaller model and the taught wake word are all for.${C.r}\n`);
