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
  const out = configured ? [configured] : [];
  for (const d of dirs) for (const n of names) out.push(path.join(d, n));
  // Also whatever is on PATH.
  out.push(IS_WIN ? "whisper-cli.exe" : "whisper-cli");
  return out;
}

function modelCandidates(cfg) {
  const configured = cfg.voice?.whisperModel?.trim();
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
  const file = tempWavPath();
  fs.writeFileSync(file, wav, { mode: 0o600 });
  const keep = !!cfg.voice?.keepAudio;
  try {
    if (d.engine === "whisper.cpp") {
      const args = ["-m", d.model, "-f", file, "-l", language || "auto", "-otxt", "-of", file.replace(/\.wav$/, ""), "-np", "-nt", "-t", String(Math.max(1, Math.min(8, os.cpus().length - 1)))];
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
      return { text: cleanup(text), engine: d.engine, model: path.basename(d.model), language };
    }
    // Vosk, when the optional binding is installed.
    const vosk = require("vosk");
    vosk.setLogLevel(-1);
    const model = new vosk.Model(d.model);
    const rec = new vosk.Recognizer({ model, sampleRate: 16000 });
    rec.acceptWaveform(wav.subarray(44));
    const out = rec.finalResult();
    rec.free();
    model.free();
    return { text: cleanup(out.text || ""), engine: d.engine, model: path.basename(d.model), language };
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
  if (said) {
    return Object.assign(new Error(`The speech engine failed (exit ${String(code)}): ${said.slice(0, 300)}`), { status: 500, code: "speech_engine_failed", exit: code });
  }
  // Windows uses these for "could not load" rather than printing anything.
  const loader = code === 3221225781 || code === -1073741515; // STATUS_DLL_NOT_FOUND
  const illegal = code === 3221225501 || code === -1073741795; // STATUS_ILLEGAL_INSTRUCTION
  const why = loader
    ? `${path.basename(d.binary)} could not start because a library it needs is missing from ${path.dirname(d.binary)}. The whisper.cpp download ships .dll files that must sit next to the program.`
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

function cleanup(text) {
  return String(text || "")
    .replace(/\[[^\]]*\]/g, " ") // [BLANK_AUDIO], [Music] …
    .replace(/\([^)]*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

module.exports = { detect, transcribe, resetCache, isWav, cleanup, INSTALL_STEPS };
