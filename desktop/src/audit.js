const fs = require("fs");
const path = require("path");
const { LOGS_DIR } = require("./config");
const { levelLabel, getLevel } = require("./permissions");

const MAX_LOG_SIZE = 5 * 1024 * 1024;

function logPath() {
  const d = new Date().toISOString().slice(0, 10);
  return path.join(LOGS_DIR, `jarvis-${d}.log`);
}

function log(entry) {
  const record = {
    time: new Date().toISOString(),
    action: entry.action || "unknown",
    tool: entry.tool || null,
    target: entry.target || null,
    result: entry.result || "pending",
    level: levelLabel(getLevel(entry.action)),
    userApproval: entry.userApproval ?? null,
    detail: entry.detail || null,
  };
  const line = JSON.stringify(record) + "\n";
  try {
    const p = logPath();
    const stat = fs.existsSync(p) ? fs.statSync(p) : null;
    if (stat && stat.size > MAX_LOG_SIZE) {
      fs.renameSync(p, p + ".old");
    }
    fs.appendFileSync(p, line, "utf8");
  } catch {}
  return record;
}

function readToday(limit = 100) {
  try {
    const lines = fs.readFileSync(logPath(), "utf8").trim().split("\n");
    return lines.slice(-limit).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

function undoStack() {
  return readToday().filter((r) => r.result === "SUCCESS" && r.detail?.undoable);
}

module.exports = { log, readToday, undoStack };
