// Local speech-to-text. Audio never leaves this computer and is never sent to
// a cloud service: recognition runs against a speech engine installed on the
// machine (whisper.cpp or Vosk). When no engine is installed we say exactly
// which component is missing and the exact free step to install it — we never
// fall back to a cloud recogniser and never pretend to have understood.
const fs = require("fs");
const os = require("os");
const path = require("path");

const paths = require("../paths");
const procs = require("../procs");

const IS_WIN = os.platform() === "win32";

// Where a user is likely to have put an engine, in the order we try.
function whisperCandidates(cfg) {
  const configured = cfg.voice?.whisperPath?.trim();
  const home = paths.HOME;
  const names = IS_WIN ? ["whisper-cli.exe", "main.exe", "whisper.exe"] : ["whisper-cli", "main", "whisper"];
  const dirs = [path.join(home, "speech"), path.join(home, "whisper"), path.join(os.homedir(), "whisper.cpp"), path.join(os.homedir(), "whisper.cpp", "build", "bin")];
  // A configured path wins, except for one trap: recent whisper.cpp releases
  // ship main.exe as a stub that says "the binary 'main.exe' is deprecated,
  // please use 'whisper-cli.exe' instead" and exits 1. An install done before
  // that change wrote main.exe into the config, so prefer the working program
  // beside it rather than failing on every word the user says.
  const out = configured ? preferSupported(configured) : [];
  for (const d of dirs) for (const n of names) out.push(path.join(d, n));
  // Also whatever is on PATH.
  out.push(IS_WIN ? "whisper-cli.exe" : "whisper-cli");
  return out;
}

// The deprecated stub, and the program that replaced it.
const DEPRECATED = IS_WIN ? ["main.exe", "whisper.exe"] : ["main", "whisper"];

function preferSupported(configured) {
  if (!DEPRECATED.includes(path.basename(configured).toLowerCase())) return [configured];
  const replacement = path.join(path.dirname(configured), IS_WIN ? "whisper-cli.exe" : "whisper-cli");
  try {
    if (fs.statSync(replacement).isFile()) return [replacement, configured];
  } catch {
    /* it is not there; the configured one is all we have */
  }
  return [configured];
}

// Models that cannot do Hebrew well enough to be worth running, and the ones
// to reach for instead when one is sitting beside them.
//
// ggml-small is deliberately NOT in the weak list any more. It was, and the
// self-heal it triggered then took a machine that had been set to small and
// quietly ran it on the large model instead — several seconds a sentence on an
// ordinary PC, which is the difference between an assistant and a wait. What
// small gets wrong is a letter here and there, and a near miss still wakes
// JARVIS. A choice that was made on purpose is not a fault to correct.
const BETTER_MODELS = ["ggml-small.bin", "ggml-large-v3-turbo.bin", "ggml-large-v3.bin", "ggml-medium.bin"];
const WEAK_MODELS = ["ggml-base.bin", "ggml-tiny.bin"];

function modelCandidates(cfg) {
  const configured = cfg.voice?.whisperModel?.trim();
  // A better model that arrived next to a weak configured one wins, the same
  // way a working program beside a retired one does: someone who downloaded it
  // should not have to edit config.json to get the Hebrew they came for.
  if (configured && WEAK_MODELS.includes(path.basename(configured).toLowerCase())) {
    const dir = path.dirname(configured);
    for (const name of BETTER_MODELS) {
      const better = path.join(dir, name);
      try {
        if (fs.statSync(better).isFile()) return [better, configured];
      } catch {
        /* not there; keep looking */
      }
    }
  }
  if (configured) return [configured];
  const dirs = [path.join(paths.HOME, "speech"), path.join(paths.HOME, "models"), path.join(os.homedir(), "whisper.cpp", "models")];
  // Multilingual models only: the ".en" builds cannot transcribe Hebrew at all.
  const names = ["ggml-large-v3-turbo.bin", "ggml-large-v3.bin", "ggml-medium.bin", "ggml-small.bin", "ggml-base.bin", "ggml-tiny.bin"];
  const out = [];
  for (const d of dirs) for (const n of names) out.push(path.join(d, n));
  return out;
}

// Only absolute-ish candidates; bare names are probed on PATH separately.
function firstExisting(list) {
  for (const p of list) {
    if (!p || !p.includes(path.sep)) continue;
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

async function onPath(binary) {
  try {
    const r = await procs.run(binary, ["--help"], { timeoutMs: 5000 });
    return r.code === 0 || /usage|whisper/i.test(r.stdout + r.stderr);
  } catch {
    return false;
  }
}

async function voskAvailable(cfg) {
  const dir = cfg.voice?.voskModel?.trim() || path.join(paths.HOME, "speech", "vosk-model");
  try {
    if (!fs.existsSync(path.join(dir, "am")) && !fs.existsSync(path.join(dir, "conf"))) return { available: false, dir };
  } catch {
    return { available: false, dir };
  }
  // The Node binding is optional; without it the model alone cannot transcribe.
  let binding = null;
  try {
    binding = require("vosk");
  } catch {
    binding = null;
  }
  return { available: !!binding, dir, binding: !!binding };
}

// Initial prompts, per language: ordinary sentences, no command words.
const PROMPTS = {
  he: "שלום. זו הקלטה קצרה בעברית של משפט אחד.",
  en: "Hello. This is a short recording of one sentence in English.",
};

const INSTALL_STEPS = {
  whisper: {
    what: "whisper.cpp (a free, open-source speech engine that runs on your computer)",
    windows: [
      "Download the ready-made Windows build: https://github.com/ggml-org/whisper.cpp/releases (file whisper-bin-x64.zip)",
      `Unzip it into ${path.join(paths.HOME, "speech")}`,
      `Download a multilingual model into the same folder: https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin (about 466 MB, understands Hebrew)`,
      "Reopen JARVIS — it finds them on its own. Nothing else is needed, and nothing is paid for.",
    ],
    other: [
      "git clone https://github.com/ggml-org/whisper.cpp && cd whisper.cpp && cmake -B build && cmake --build build -j",
      "sh ./models/download-ggml-model.sh small",
      `Or copy the built binary and the model into ${path.join(paths.HOME, "speech")}`,
    ],
  },
};

let cache = { at: 0, value: null };

// How long each model has been taking on this computer, and the point past
// which a spoken assistant stops being one. Nobody waits fifteen seconds to be
// told the time.
const TARGET_MS = 2500;
const speed = new Map();

function remember(modelPath, tookMs) {
  const seen = speed.get(modelPath) ?? { runs: 0, avg: 0 };
  // A running average over the last few runs: the first one includes the cost
  // of loading the model from disk and is not representative.
  seen.avg = seen.runs === 0 ? tookMs : seen.avg * 0.6 + tookMs * 0.4;
  seen.runs += 1;
  speed.set(modelPath, seen);
}

/** Every multilingual model sitting beside this one, smallest file first. */
function modelsBeside(modelPath) {
  const dir = path.dirname(modelPath);
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => /^ggml-.*\.bin$/i.test(n) && !/\.en\.bin$/i.test(n) && !/-tiny/i.test(n));
  } catch {
    return [];
  }
  return names
    .map((n) => ({ file: path.join(dir, n), size: (() => { try { return fs.statSync(path.join(dir, n)).size; } catch { return Infinity; } })() }))
    .sort((a, b) => a.size - b.size);
}

/**
 * The model to actually run.
 *
 * The configured one, until this computer has shown twice that it cannot keep
 * up with it — then the largest one beside it that can. This is never silent:
 * status() reports which model is in use and why it changed. Nothing is
 * downloaded and nothing is deleted; it only chooses between what is already
 * installed.
 */
function chooseModel(chosen, seen, seenFor = () => null) {
  if (!seen || seen.runs < 2 || seen.avg <= TARGET_MS) return { model: chosen, fallback: null };
  let size = Infinity;
  try { size = fs.statSync(chosen).size; } catch { /* keep Infinity */ }
  const smaller = modelsBeside(chosen).filter((m) => m.size < size);
  // The biggest of the ones that are smaller: as much accuracy as the computer
  // can afford, rather than the smallest and least accurate.
  let pick = smaller.at(-1);
  if (!pick) return { model: chosen, fallback: null };
  const already = seenFor(pick.file);
  if (already && already.runs >= 2 && already.avg > TARGET_MS && smaller.length > 1) {
    pick = smaller.at(-2); // even that one cannot keep up
  }
  return { model: pick.file, fallback: { from: path.basename(chosen), to: path.basename(pick.file), ms: Math.round(seen.avg) } };
}

/**
 * The model to run, for the mode asked for.
 *
 * fast: the smallest installed model that still does Hebrew — what you want
 * when you are talking to it. accurate: what is configured, however heavy, and
 * no automatic downshift: someone who picks accuracy means it.
 */
function forMode(d, mode) {
  if (mode !== "fast") {
    fallback = null;
    return d.model;
  }
  const out = chooseModel(d.model, speed.get(d.model), (f) => speed.get(f) ?? null);
  fallback = out.fallback;
  return out.model;
}

// The switch that has been made, if any, so the window can say so.
let fallback = null;

function speedReport(cfg) {
  return {
    mode: cfg?.voice?.mode === "accurate" ? "accurate" : "fast",
    gpu: cfg?.voice?.gpu === "off" ? "off" : "auto",
    fallback,
    perModel: Object.fromEntries([...speed.entries()].map(([file, v]) => [path.basename(file), Math.round(v.avg)])),
    targetMs: TARGET_MS,
  };
}

/** What speech recognition is available right now, and if not — exactly why. */
async function detect(cfg, { force = false } = {}) {
  if (!force && cache.value && Date.now() - cache.at < 15000) return cache.value;

  const result = {
    engine: null,
    binary: null,
    model: null,
    languages: [],
    hebrew: false,
    available: false,
    reason: null,
    install: null,
    checked: { whisperBinaries: [], whisperModels: [], vosk: null },
  };

  const binCandidates = whisperCandidates(cfg);
  const modCandidates = modelCandidates(cfg);
  result.checked.whisperBinaries = binCandidates.slice(0, 6);
  result.checked.whisperModels = modCandidates.slice(0, 6);

  let binary = firstExisting(binCandidates);
  if (!binary) {
    const bare = binCandidates.find((p) => !p.includes(path.sep));
    if (bare && (await onPath(bare))) binary = bare;
  }
  const model = firstExisting(modCandidates);

  if (binary && model) {
    result.engine = "whisper.cpp";
    result.binary = binary;
    result.model = model;
    result.available = true;
    // Whisper models are multilingual unless the filename says ".en".
    result.hebrew = !/\.en\.bin$|-en\.bin$|\.en$/i.test(model);
    result.languages = result.hebrew ? ["he", "en", "…"] : ["en"];
    if (!result.hebrew) {
      result.available = false;
      result.reason = `The installed model (${path.basename(model)}) is the English-only build and cannot transcribe Hebrew.`;
      result.install = { ...INSTALL_STEPS.whisper, note: "Download a multilingual model (a filename without .en), for example ggml-small.bin." };
    }
    cache = { at: Date.now(), value: result };
    return result;
  }

  const vosk = await voskAvailable(cfg);
  result.checked.vosk = vosk;
  if (vosk.available) {
    result.engine = "vosk";
    result.model = vosk.dir;
    result.available = true;
    result.hebrew = /he|heb|hebrew/i.test(vosk.dir);
    result.languages = result.hebrew ? ["he"] : ["(depends on the installed model)"];
    cache = { at: Date.now(), value: result };
    return result;
  }

  result.reason = binary && !model
    ? "The whisper.cpp program is installed but no speech model was found."
    : !binary && model
      ? "A speech model was found but the whisper.cpp program is missing."
      : "No local speech engine is installed, so JARVIS cannot hear you yet.";
  result.install = INSTALL_STEPS.whisper;
  cache = { at: Date.now(), value: result };
  return result;
}

function resetCache() {
  cache = { at: 0, value: null };
}

// --- WAV handling ----------------------------------------------------------

/** Minimal 16-bit PCM WAV header check; we only ever accept what we ourselves record. */
function isWav(buf) {
  return Buffer.isBuffer(buf) && buf.length > 44 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WAVE";
}

function tempWavPath() {
  fs.mkdirSync(paths.TEMP, { recursive: true });
  return path.join(paths.TEMP, `speech-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`);
}

/**
 * Exactly what is handed to whisper.cpp, and why.
 *
 * Pulled out of transcribe() so the flags can be checked without a process:
 * they decide both the speed and the accuracy, and the stand-in engine a test
 * would otherwise need cannot be spawned on Windows at all.
 */
function whisperArgs({ model, file, language, mode = "fast", gpu = "auto", seconds = 0 }) {
  // Accurate mode always searches; fast mode only does so on a small model,
  // where the search is cheap and the model needs the help. On a large model in
  // fast mode it multiplies the slowest part of the run, on exactly the
  // computers that can least afford it.
  const big = /large|medium/i.test(path.basename(model));
  const beam = mode === "accurate" ? "5" : big ? "1" : "5";
  const args = ["-m", model, "-f", file, "-l", language || "auto", "-otxt", "-of", String(file).replace(/\.wav$/, ""), "-np", "-nt", "-bs", beam, "-t", String(Math.max(1, Math.min(8, os.cpus().length - 1)))];
  // The engine uses a GPU when the build has support and the machine has one,
  // and falls back to the CPU by itself when either is missing. -ng is the only
  // lever there is: it forces the CPU.
  if (gpu === "off") args.push("-ng");
  // whisper always looks at a thirty-second window, so a one-second command
  // costs the same as half a minute of speech unless it is told otherwise. -ac
  // trims the encoder to the audio that exists — the single biggest saving on
  // short commands, which is all JARVIS ever gets. Accurate mode keeps the
  // whole window: trimming it is a speed trade, and that is the one trade
  // accurate mode is not making.
  if (mode === "fast" && seconds > 0 && seconds < 20) {
    const ctx = Math.max(256, Math.min(1500, Math.ceil((((seconds + 1.5) / 30) * 1500) / 64) * 64));
    args.push("-ac", String(ctx));
  }
  // A one-word clip gives the model almost nothing to go on, and it will guess
  // at the language and the spelling. A plain sentence in the target language
  // as the initial prompt settles both. The wake phrase itself is deliberately
  // NOT in here: whisper repeats its prompt when the audio is unclear, which
  // would turn every cough into a wake word.
  const hint = PROMPTS[(language || "").slice(0, 2)];
  if (hint) args.push("--prompt", hint);
  return args;
}

/**
 * Transcribe a WAV buffer locally.
 *
 * The audio is written to a temp file only because the engines read files, and
 * the file is deleted in `finally` whatever happens. Nothing is uploaded and
 * nothing is kept unless the user turned on keepAudio explicitly.
 */
async function transcribe(wav, { cfg, language = "he", signal, timeoutMs } = {}) {
  if (!isWav(wav)) throw Object.assign(new Error("Expected a WAV recording."), { status: 400 });
  const d = await detect(cfg);
  if (!d.available) {
    const e = new Error(d.reason || "No local speech engine is installed.");
    e.status = 503;
    e.code = "speech_engine_missing";
    e.install = d.install;
    throw e;
  }
  const mode = cfg.voice?.mode === "accurate" ? "accurate" : "fast";
  const model = forMode(d, mode);
  const file = tempWavPath();
  const startedAt = Date.now();
  fs.writeFileSync(file, wav, { mode: 0o600 });
  const keep = !!cfg.voice?.keepAudio;
  try {
    if (d.engine === "whisper.cpp") {
      // -bs 5: beam search rather than the single greedy pass. It costs a
      // little time per utterance and is the difference between a Hebrew word
      // coming back right and coming back as something that rhymes with it.
      // Beam search is worth its cost on a small model, which needs the help.
      // On a large one it multiplies the slowest part of the run on exactly the
      // computers that can least afford it - and a wake phrase that arrives
      // forty seconds late is the same as one that never arrives.
      const args = whisperArgs({ model, file, language, mode, gpu: cfg.voice?.gpu, seconds: (wav.length - 44) / (16000 * 2) });
      const res = await procs.run(d.binary, args, { timeoutMs: timeoutMs ?? cfg.voice?.transcribeTimeoutMs ?? 120000, signal });
      if (res.cancelled) throw Object.assign(new Error("cancelled"), { code: "cancelled" });
      if (res.timedOut) throw Object.assign(new Error("Local transcription timed out."), { status: 504 });
      if (res.code !== 0) throw engineFailure(res, d);
      const txtFile = file.replace(/\.wav$/, ".txt");
      let text = "";
      try {
        text = fs.readFileSync(txtFile, "utf8");
      } catch {
        text = res.stdout;
      } finally {
        try { fs.unlinkSync(txtFile); } catch { /* already gone */ }
      }
      const tookMs = Date.now() - startedAt;
      remember(model, tookMs);
      return { text: cleanup(text), engine: d.engine, model: path.basename(model), language, tookMs };
    }
    // Vosk, when the optional binding is installed.
    const vosk = require("vosk");
    vosk.setLogLevel(-1);
    // Named apart from the chosen model path above: one `model` in this block
    // shadowing the other put the whisper branch in a temporal dead zone.
    const voskModel = new vosk.Model(d.model);
    const rec = new vosk.Recognizer({ model: voskModel, sampleRate: 16000 });
    rec.acceptWaveform(wav.subarray(44));
    const out = rec.finalResult();
    rec.free();
    voskModel.free();
    return { text: cleanup(out.text || ""), engine: d.engine, model: path.basename(d.model), language, tookMs: Date.now() - startedAt };
  } finally {
    if (!keep) {
      try { fs.unlinkSync(file); } catch { /* already gone */ }
    }
  }
}

/**
 * Why the engine failed, in words that lead somewhere.
 *
 * A program that dies without printing anything is the common Windows case —
 * usually a missing DLL next to the executable, or a build the processor
 * cannot run. "The speech engine failed:" followed by nothing tells the user
 * nothing at all, so there is always an exit code and a likely cause here.
 */
function engineFailure(res, d) {
  const said = String(res.stderr || res.stdout || "").trim();
  const code = res.code;
  // whisper.cpp's own words for "you are running the retired program". It never
  // transcribes anything, so echoing the warning alone would leave the user
  // reading a deprecation notice with nothing to do about it.
  if (/\bdeprecated\b/i.test(said) && /whisper-cli/i.test(said)) {
    const e = new Error(`The speech engine failed: ${path.basename(d.binary)} is the retired whisper.cpp program and only prints a deprecation notice. The one to use is ${IS_WIN ? "whisper-cli.exe" : "whisper-cli"} in ${path.dirname(d.binary)}. If it is not there, run  npm run voice  to fetch it (free, no account).`);
    e.status = 500;
    e.code = "speech_engine_failed";
    e.exit = code;
    return e;
  }
  if (said) {
    return Object.assign(new Error(`The speech engine failed (exit ${String(code)}): ${said.slice(0, 300)}`), { status: 500, code: "speech_engine_failed", exit: code });
  }
  // Windows uses these for "could not load" rather than printing anything.
  const loader = code === 3221225781 || code === -1073741515; // STATUS_DLL_NOT_FOUND
  const illegal = code === 3221225501 || code === -1073741795; // STATUS_ILLEGAL_INSTRUCTION
  const why = loader
    ? `${path.basename(d.binary)} could not start because a library it needs is missing. Most often this is the Microsoft Visual C++ Redistributable, which Windows programs expect but the whisper.cpp download does not include — install it (free, from Microsoft) with:  winget install --id Microsoft.VCRedist.2015+.x64 -e   If that is already installed, the missing library is one of the .dll files that belong next to the program in ${path.dirname(d.binary)}.`
    : illegal
      ? `${path.basename(d.binary)} was built for a newer processor than this one and cannot run here.`
      : `${path.basename(d.binary)} stopped with exit code ${String(code)} without printing anything, which usually means it could not start at all — most often a missing library beside it.`;
  const e = new Error(`The speech engine failed: ${why}`);
  e.status = 500;
  e.code = "speech_engine_failed";
  e.exit = code;
  e.install = INSTALL_STEPS.whisper;
  return e;
}

/**
 * What the engine prints, turned into what the person said.
 *
 * Whisper annotates: [BLANK_AUDIO], (music), ♪ for anything it thinks is not
 * speech. On a short Hebrew clip it also loops — "פתח פתח פתח" — and wraps the
 * whole line in quotes when the initial prompt was a sentence. None of that is
 * what was said, and all of it breaks a phrase match.
 */
function cleanup(text) {
  let out = String(text || "")
    .replace(/\[[^\]]*\]/g, " ") // [BLANK_AUDIO], [Music] …
    .replace(/\([^)]*\)/g, " ")
    .replace(/[♪♫]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // A line the engine wrapped in quotes, opened and closed. Quotes inside a
  // sentence are left alone.
  const quoted = /^["'\u201c\u201d\u05f4](.+)["'\u201c\u201d\u05f4]$/.exec(out);
  if (quoted) out = quoted[1].trim();
  // The stutter a short clip produces: the same word three or more times in a
  // row becomes one. Two in a row can be real speech ("כן כן"), so it stays.
  out = out.replace(/(^|\s)(\S+)(\s+\2){2,}(?=\s|$)/g, "$1$2");
  return out.trim();
}

module.exports = {
  speedReport, whisperArgs, chooseModel, TARGET_MS, detect, transcribe, resetCache, isWav, cleanup, engineFailure, INSTALL_STEPS };
