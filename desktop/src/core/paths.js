// Where JARVIS keeps its local data. Everything lives under ~/.jarvis; nothing
// is written anywhere else unless the user adds an approved folder.
const path = require("path");
const os = require("os");
const fs = require("fs");

const HOME = process.env.JARVIS_HOME || path.join(os.homedir(), ".jarvis");
const P = {
  HOME,
  CONFIG: path.join(HOME, "config.json"),
  DEVICES: path.join(HOME, "devices.json"),
  WORKSPACE: path.join(HOME, "workspace"),
  LOGS: path.join(HOME, "logs"),
  DRAFTS: path.join(HOME, "drafts"),
  PROJECTS: path.join(HOME, "projects"),
  TRASH: path.join(HOME, "trash"),
  MEMORY: path.join(HOME, "memory.json"),
  REMINDERS: path.join(HOME, "reminders.json"),
  CONTACTS: path.join(HOME, "contacts.json"),
  OPTOUT: path.join(HOME, "optout.json"),
  TEMP: path.join(HOME, "temp"),
};

function ensureDirs() {
  for (const d of [P.HOME, P.WORKSPACE, P.LOGS, P.DRAFTS, P.PROJECTS, P.TRASH, P.TEMP]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, data, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: "utf8", mode });
  fs.renameSync(tmp, file);
}

module.exports = { ...P, ensureDirs, readJson, writeJson };
