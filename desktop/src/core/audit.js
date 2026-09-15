// Redacted, append-only audit log: one JSON line per event, one file per day.
// Never stores clipboard contents, typed text, file contents or screenshots —
// tools describe what to keep through their `redact` policy before we get here.
const fs = require("fs");
const path = require("path");
const paths = require("./paths");
const { redact } = require("./util");

const MAX_LINE = 4000;

function fileFor(date = new Date()) {
  return path.join(paths.LOGS, `audit-${date.toISOString().slice(0, 10)}.jsonl`);
}

function log(entry) {
  paths.ensureDirs();
  const record = redact({
    time: new Date().toISOString(),
    event: entry.event || "unknown",
    tool: entry.tool || null,
    risk: entry.risk || null,
    device: entry.device || null,
    request_id: entry.request_id || null,
    plan_id: entry.plan_id || null,
    status: entry.status || null,
    params: entry.params || null,
    detail: entry.detail || null,
  });
  let line = JSON.stringify(record);
  if (line.length > MAX_LINE) line = JSON.stringify({ ...record, params: "[truncated]", detail: "[truncated]" });
  try {
    fs.appendFileSync(fileFor(), line + "\n", { encoding: "utf8", mode: 0o600 });
  } catch (e) {
    // Losing an audit line must not take an action down; report it once on stderr.
    process.stderr.write(`audit write failed: ${e.message}\n`);
  }
  return record;
}

function listFiles() {
  try {
    return fs.readdirSync(paths.LOGS).filter((f) => /^audit-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
  } catch {
    return [];
  }
}

function read({ limit = 200, days = 7 } = {}) {
  const files = listFiles().slice(-days);
  const out = [];
  for (const f of files) {
    let text = "";
    try { text = fs.readFileSync(path.join(paths.LOGS, f), "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* skip a torn line */ }
    }
  }
  return out.slice(-limit);
}

function exportAll() {
  const files = listFiles();
  return files.map((f) => ({ file: f, content: fs.readFileSync(path.join(paths.LOGS, f), "utf8") }));
}

function deleteAll() {
  let n = 0;
  for (const f of listFiles()) {
    try { fs.unlinkSync(path.join(paths.LOGS, f)); n++; } catch { /* ignore */ }
  }
  return n;
}

function prune(keepDays) {
  const files = listFiles();
  const cutoff = new Date(Date.now() - keepDays * 86400000).toISOString().slice(0, 10);
  let n = 0;
  for (const f of files) {
    const day = f.slice(6, 16);
    if (day < cutoff) { try { fs.unlinkSync(path.join(paths.LOGS, f)); n++; } catch { /* ignore */ } }
  }
  return n;
}

module.exports = { log, read, exportAll, deleteAll, prune, fileFor };
