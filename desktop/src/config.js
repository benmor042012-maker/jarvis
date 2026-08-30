const fs = require("fs");
const path = require("path");
const os = require("os");

const JARVIS_HOME = path.join(os.homedir(), ".jarvis");
const CONFIG_PATH = path.join(JARVIS_HOME, "config.json");
const WORKSPACE = path.join(JARVIS_HOME, "workspace");
const LOGS_DIR = path.join(JARVIS_HOME, "logs");

const WORKSPACE_DIRS = ["files", "downloads", "projects", "temp"];

const DEFAULTS = {
  backendUrl: "https://jarvis-proxi.ben-mor-04-2012.workers.dev",
  userId: "effi",
  anthropicApiKey: "",
  model: "claude-sonnet-4-20250514",
  mode: "safe",
  wakeWordEnabled: true,
  wakeWords: ["jarvis", "ג'רביס", "גרביס"],
  autoStart: false,
  hotkeys: { emergencyStop: "CommandOrControl+Shift+Escape" },
  ttsEnabled: true,
  ttsLang: "he-IL",
  sttLang: "he-IL",
};

function ensureDirs() {
  for (const d of [JARVIS_HOME, WORKSPACE, LOGS_DIR, ...WORKSPACE_DIRS.map((s) => path.join(WORKSPACE, s))]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

function load() {
  ensureDirs();
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
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
