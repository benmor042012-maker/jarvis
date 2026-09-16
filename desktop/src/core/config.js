// Runtime settings. No secrets live here: there are no API keys in this
// product. Device secrets are in devices.js (optionally OS-encrypted).
const paths = require("./paths");

const MODES = ["safe", "assistant", "advanced"];
const POLICY_VALUES = ["allowed", "ask_every_time", "allowed_for_task", "blocked"];

const DEFAULTS = {
  version: 2,
  mode: "assistant",
  language: "he",
  autoStart: false,
  hotkeys: { emergencyStop: "CommandOrControl+Shift+Escape" },
  server: { port: 8765, lanEnabled: false },
  offlineMode: false,
  ai: {
    provider: "auto", // auto | ollama | localai | mock
    ollamaUrl: "http://127.0.0.1:11434",
    localaiUrl: "http://127.0.0.1:8080",
    model: "",
    timeoutMs: 90000,
  },
  approvedFolders: [paths.WORKSPACE],
  extraApps: [], // [{ id, path }] user-added executables
  allowedUrlHosts: ["*"],
  toolPolicies: {}, // advanced mode: tool -> policy value
  tts: { enabled: true, lang: "he-IL" },
  voice: {
    // Voice-first operation. The microphone is only opened after you accept the
    // permission screen, audio is transcribed by a local engine, and nothing is
    // uploaded or kept.
    enabled: true,
    language: "he",
    wakePhrases: ["תתעורר", "hey jarvis"],
    stopPhrases: ["עצור", "תעצור", "חירום", "stop", "emergency"],
    quietHours: { enabled: false, start: "22:00", end: "07:00" },
    maxListenMs: 15000,
    keepAudio: false,
    whisperPath: "",
    whisperModel: "",
    voskModel: "",
    transcribeTimeoutMs: 120000,
    speakReplies: true,
  },
  alerts: {
    enabled: true,
    scanIntervalMs: 120000,
    channels: { notification: true, sound: true, speech: true, phone: true },
    speakDetails: false, // never read private customer detail aloud by default
    quietHours: { enabled: false, start: "22:00", end: "07:00" },
  },
  phone: {
    // Alerting a paired phone over your own Wi-Fi, and handing a number to its
    // dialer after you approve. No external messaging, no cloud, no provider.
    enabled: true,
    simulation: false, // forced on automatically when no phone is connected
    allowDialer: true,
  },
  drafts: { senderName: "", businessName: "" },
  deviceExpiryDays: 30,
  privacy: { keepAuditDays: 90 },
};

function validateQuietHours(q, label) {
  for (const field of ["start", "end"]) {
    if (q[field] === undefined) continue;
    if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(String(q[field]).trim())) throw new Error(`${label}.${field} must be a time like 22:00`);
  }
}

function deepMerge(base, extra) {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    if (v && typeof v === "object" && !Array.isArray(v) && base[k] && typeof base[k] === "object" && !Array.isArray(base[k])) out[k] = deepMerge(base[k], v);
    else if (v !== undefined) out[k] = v;
  }
  return out;
}

let cache = null;

function load() {
  paths.ensureDirs();
  if (cache) return cache;
  cache = deepMerge(DEFAULTS, paths.readJson(paths.CONFIG, {}));
  if (!MODES.includes(cache.mode)) cache.mode = "assistant";
  return cache;
}

function save(cfg) {
  cache = cfg;
  paths.writeJson(paths.CONFIG, cfg);
  return cfg;
}

function sanitizePartial(partial) {
  const p = { ...partial };
  if (p.mode !== undefined && !MODES.includes(p.mode)) throw new Error(`mode must be one of ${MODES.join(", ")}`);
  if (p.toolPolicies !== undefined) {
    for (const [tool, val] of Object.entries(p.toolPolicies)) {
      if (!POLICY_VALUES.includes(val)) throw new Error(`policy for ${tool} must be one of ${POLICY_VALUES.join(", ")}`);
    }
  }
  if (p.server?.port !== undefined) {
    const port = Number(p.server.port);
    // 0 = ephemeral port (used by tests and by "pick any free port").
    if (!Number.isInteger(port) || (port !== 0 && (port < 1024 || port > 65535))) throw new Error("port must be between 1024 and 65535");
    p.server.port = port;
  }
  if (p.approvedFolders !== undefined) {
    if (!Array.isArray(p.approvedFolders) || !p.approvedFolders.every((f) => typeof f === "string" && f.trim())) throw new Error("approvedFolders must be a list of paths");
  }
  if (p.allowedUrlHosts !== undefined) {
    if (!Array.isArray(p.allowedUrlHosts)) throw new Error("allowedUrlHosts must be a list");
    p.allowedUrlHosts = p.allowedUrlHosts.map((h) => String(h).trim().toLowerCase()).filter(Boolean);
  }
  if (p.voice) {
    if (p.voice.wakePhrases !== undefined) {
      if (!Array.isArray(p.voice.wakePhrases) || !p.voice.wakePhrases.length) throw new Error("At least one wake phrase is required");
      p.voice.wakePhrases = p.voice.wakePhrases.map((w) => String(w).trim()).filter(Boolean);
      if (!p.voice.wakePhrases.length) throw new Error("At least one wake phrase is required");
      // A one-letter wake phrase would fire on almost any speech.
      for (const w of p.voice.wakePhrases) if (w.length < 3) throw new Error(`Wake phrase "${w}" is too short to be safe`);
    }
    if (p.voice.stopPhrases !== undefined) {
      if (!Array.isArray(p.voice.stopPhrases) || !p.voice.stopPhrases.length) throw new Error("At least one stop phrase is required");
      p.voice.stopPhrases = p.voice.stopPhrases.map((w) => String(w).trim()).filter(Boolean);
      if (!p.voice.stopPhrases.length) throw new Error("At least one stop phrase is required");
    }
    if (p.voice.maxListenMs !== undefined) {
      const ms = Number(p.voice.maxListenMs);
      if (!Number.isFinite(ms) || ms < 2000 || ms > 120000) throw new Error("maxListenMs must be between 2000 and 120000");
      p.voice.maxListenMs = Math.round(ms);
    }
    for (const key of ["quietHours"]) {
      const q = p.voice[key];
      if (q && (q.start !== undefined || q.end !== undefined)) validateQuietHours(q, `voice.${key}`);
    }
  }
  if (p.alerts?.quietHours) validateQuietHours(p.alerts.quietHours, "alerts.quietHours");
  if (p.alerts?.scanIntervalMs !== undefined) {
    const ms = Number(p.alerts.scanIntervalMs);
    if (!Number.isFinite(ms) || ms < 30000 || ms > 3600000) throw new Error("scanIntervalMs must be between 30000 and 3600000");
    p.alerts.scanIntervalMs = Math.round(ms);
  }
  if (p.ai) {
    for (const key of ["ollamaUrl", "localaiUrl"]) {
      if (p.ai[key] !== undefined) {
        const { isPrivateHost } = require("./util");
        let u;
        try { u = new URL(p.ai[key]); } catch { throw new Error(`${key} is not a valid URL`); }
        if (!/^https?:$/.test(u.protocol) || !isPrivateHost(u.hostname)) throw new Error(`${key} must point to this computer or the local network (no cloud endpoints)`);
      }
    }
    if (p.ai.provider !== undefined && !["auto", "ollama", "localai", "mock"].includes(p.ai.provider)) throw new Error("ai.provider is invalid");
  }
  return p;
}

function update(partial) {
  const cfg = deepMerge(load(), sanitizePartial(partial));
  return save(cfg);
}

function reset() {
  cache = null;
}

module.exports = { load, save, update, reset, DEFAULTS, MODES, POLICY_VALUES, deepMerge };
