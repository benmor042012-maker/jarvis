// The one place a secret is kept: ~/.jarvis/secrets.json, readable by this
// user only. Not config.json — that file is shown in Settings, exported with
// "Export my data" and read by paired devices. Nothing in here is ever sent to
// the window, written to the audit log, or included in an export: routes
// report only whether a secret is set and, for a webhook, its host.
const fs = require("fs");
const path = require("path");
const paths = require("./paths");

const FILE = path.join(paths.HOME, "secrets.json");

function readAll() {
  return paths.readJson(FILE, {});
}

function writeAll(data) {
  paths.writeJson(FILE, data, 0o600);
  // writeJson creates with 0600; an existing file keeps its mode, so set it.
  try { fs.chmodSync(FILE, 0o600); } catch { /* Windows: ACLs, not modes */ }
}

function get(name) {
  const v = readAll()[name];
  return v === undefined ? null : v;
}

function set(name, value) {
  const all = readAll();
  if (value === null || value === undefined) delete all[name];
  else all[name] = value;
  writeAll(all);
}

function has(name) {
  const v = get(name);
  return Array.isArray(v) ? v.length > 0 : !!v;
}

function wipe() {
  try { fs.unlinkSync(FILE); } catch { /* none */ }
}

module.exports = { get, set, has, wipe, FILE };
