const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const JARVIS_HOME = path.join(os.homedir(), ".jarvis");
const CONFIG_PATH = path.join(JARVIS_HOME, "config.json");
const WORKSPACE = path.join(JARVIS_HOME, "workspace");
const LOGS_DIR = path.join(JARVIS_HOME, "logs");

const WORKSPACE_DIRS = ["files", "downloads", "projects", "temp"];

const DEFAULTS = {
  backendUrl: "https://jarvis-proxi.ben-mor-04-2012.workers.dev",
  userId: "effi",
  anthropicApiKey: "",
  model: "claude-opus-5",
  // Assistant, not safe: safe mode refuses every click and keystroke, so a
  // fresh install would look broken. The ASK/CONFIRM/HIGH_RISK/BLOCKED gates
  // are what keep this safe, not the mode.
  mode: "assistant",
  wakeWordEnabled: true,
  wakeWords: ["jarvis", "ג'רביס", "גרביס"],
  autoStart: false,
  hotkeys: { emergencyStop: "CommandOrControl+Shift+Escape" },
  ttsEnabled: true,
  ttsLang: "he-IL",
  sttLang: "he-IL",

  // Local bridge: the Chrome tab does Hebrew speech recognition and posts
  // commands here. Token-gated — see bridge.js.
  bridgePort: 8765,
  bridgeToken: "",
  bridgeOrigins: [
    "https://benmor042012-maker.github.io",
    "http://localhost:8080",
    "http://127.0.0.1:8080",
  ],

  // Messaging credentials. Local only — never sent anywhere but the provider.
  telegramBotToken: "",
  telegramDefaultChatId: "",
  gmailAddress: "",
  gmailAppPassword: "",
};

function ensureDirs() {
  for (const d of [JARVIS_HOME, WORKSPACE, LOGS_DIR, ...WORKSPACE_DIRS.map((s) => path.join(WORKSPACE, s))]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

// Model IDs that the API no longer serves. A saved config overrides DEFAULTS,
// so without this a config written by an older build keeps sending a dead model
// and every request comes back "Error: model: <id>".
const RETIRED_MODELS = new Set([
  "claude-sonnet-4-20250514",
  "claude-3-5-sonnet-20241022",
  "claude-3-5-haiku-20241022",
  "claude-3-opus-20240229",
  "claude-haiku-4-5-20251001",
]);

function load() {
  ensureDirs();
  let cfg;
  try {
    cfg = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) };
  } catch {
    cfg = { ...DEFAULTS };
  }

  let dirty = false;
  if (!cfg.bridgeToken) {
    cfg.bridgeToken = crypto.randomBytes(24).toString("hex");
    dirty = true;
  }
  if (!cfg.model || RETIRED_MODELS.has(cfg.model)) {
    cfg.model = DEFAULTS.model;
    dirty = true;
  }
  if (dirty) {
    try { save(cfg); } catch {}
  }
  return cfg;
}

function save(cfg) {
  ensureDirs();
  const safe = { ...cfg };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(safe, null, 2), "utf8");
}

function update(partial) {
  const cfg = load();
  Object.assign(cfg, partial);
  save(cfg);
  return cfg;
}

module.exports = { load, save, update, JARVIS_HOME, WORKSPACE, LOGS_DIR, CONFIG_PATH };
