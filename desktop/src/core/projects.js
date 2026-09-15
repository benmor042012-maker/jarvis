// Local project builder. Deterministic templates + optional local model,
// isolated workspaces under ~/.jarvis/projects, git checkpoints, tests/builds
// through tracked child processes, secret + dependency scans, progress
// streaming and cancellation. Nothing is published: there is no upload path.
const fs = require("fs");
const path = require("path");
const EventEmitter = require("events");
const paths = require("./paths");
const procs = require("./procs");
const audit = require("./audit");
const { uuid, nowMs, paramsHash, userError } = require("./util");
const local = require("./planner/local-model");
const templates = require("./project-templates");

const SECRET_PATTERNS = [
  [/sk-(?!ant-)[A-Za-z0-9_\-]{16,}/, "OpenAI-style key"], [/sk-ant-[A-Za-z0-9_\-]{16,}/, "Anthropic key"], [/ghp_[A-Za-z0-9]{20,}/, "GitHub token"],
  [/AKIA[0-9A-Z]{16}/, "AWS access key"], [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, "private key"], [/xox[baprs]-[A-Za-z0-9\-]{10,}/, "Slack token"],
  [/(?:api[_-]?key|secret|password|token)\s*[:=]\s*["'][^"']{8,}["']/i, "hard-coded credential"],
];
const DANGEROUS_DEPS = new Set(["event-stream", "flatmap-stream", "ua-parser-js@0.7.29", "coa@2.0.3", "rc@1.2.9", "colors@1.4.1", "faker@6.6.6", "node-ipc@10.1.1"]);
const ALLOWED_LICENSES = /^(MIT|ISC|BSD-[23]-Clause|Apache-2\.0|0BSD|Unlicense|CC0-1\.0|MPL-2\.0|Python-2\.0|BlueOak-1\.0\.0|\(MIT OR CC0-1\.0\)|\(MIT OR Apache-2\.0\)|\(Apache-2\.0 OR MPL-1\.1\)|\(BSD-3-Clause OR GPL-2\.0\))$/;

function safeName(name) {
  const n = String(name || "").trim().toLowerCase().replace(/[^a-z0-9֐-׿_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  if (!n) throw userError("Project name must contain letters or digits.");
  return n;
}

class Projects extends EventEmitter {
  constructor({ getConfig, state }) {
    super();
    this.getConfig = getConfig;
    this.state = state;
    this.tasks = new Map(); // task_id -> task
  }

  _emit(type, payload) { this.emit("event", { type, at: nowMs(), ...payload }); }

  templates() { return templates.list(); }

  list() {
    fs.mkdirSync(paths.PROJECTS, { recursive: true });
    return fs.readdirSync(paths.PROJECTS, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => {
      const meta = paths.readJson(path.join(paths.PROJECTS, e.name, ".jarvis-project.json"), {});
      return { name: e.name, template: meta.template || "unknown", created_at: meta.created_at || null, path: path.join(paths.PROJECTS, e.name), tasks: (meta.tasks || []).slice(-10) };
    });
  }

  // Step 1: a plan the user reads before approving. Nothing is written yet.
  async plan({ name, template, description = "", run_tests = true, run_build = true, existing = false }) {
    const cfg = this.getConfig();
    const pname = safeName(name);
    const tpl = templates.get(template);
    if (!tpl && !existing) throw userError(`Unknown template '${template}'. Available: ${templates.list().map((t) => t.id).join(", ")}.`);
    const dir = path.join(paths.PROJECTS, pname);
    if (!existing && fs.existsSync(dir)) throw userError(`A project named '${pname}' already exists. Choose another name or mark it as existing.`);
    if (existing && !fs.existsSync(dir)) throw userError(`Project '${pname}' does not exist.`);
    const resolved = await local.resolve(cfg);
    const files = tpl ? tpl.files({ name: pname, description }).map((f) => ({ path: f.path, bytes: Buffer.byteLength(f.content, "utf8") })) : [];
    const gitAvailable = await hasGit();
    const commands = [];
    if (tpl && tpl.install) commands.push({ step: "install", argv: tpl.install, needs_network: true, offline_blocked: !!cfg.offlineMode });
    if (run_tests && tpl && tpl.test) commands.push({ step: "test", argv: tpl.test, needs_network: false });
    if (run_build && tpl && tpl.build) commands.push({ step: "build", argv: tpl.build, needs_network: false });
    const task = {
      task_id: uuid(), created_at: nowMs(), expires_at: nowMs() + 15 * 60 * 1000, status: "planned",
      name: pname, template: tpl ? tpl.id : "existing", description: description.slice(0, 2000), workspace: dir, existing,
      prompt: description, model: resolved.provider === "mock" ? null : `${resolved.provider}:${resolved.model}`, mock: resolved.provider === "mock",
      model_note: resolved.provider === "mock" ? "No local model: deterministic template only (MOCK MODE). The description is stored in README, not interpreted." : local.CAPABILITY_WARNING,
      files, commands, git: gitAvailable ? "checkpoints via git" : "git not installed: no checkpoints (files are still isolated in the project folder)",
      tools: ["write files inside the project folder", ...(commands.length ? ["run listed commands with the tracked process manager"] : []), "secret scan", "dependency/license check"],
      permissions: ["writes only inside " + dir, "no network except package install (if listed)", "no publishing, no upload"],
      expected_changes: tpl ? `${files.length} new file(s) in ${dir}` : "files generated by the local model inside the project folder",
      publish: cfg.offlineMode ? "disabled (offline mode)" : "disabled (not part of the self-contained product)",
      progress: [], changed_files: [], scan: null, checkpoints: [], hash: null,
    };
    task.hash = paramsHash({ name: task.name, template: task.template, description: task.description, commands: task.commands, files: task.files });
    this.tasks.set(task.task_id, task);
    audit.log({ event: "project_planned", detail: { task_id: task.task_id, name: pname, template: task.template } });
    return this.publicTask(task);
  }

  publicTask(t) { const { controller, ...rest } = t; return rest; }
  get(id) { const t = this.tasks.get(id); return t ? this.publicTask(t) : null; }

  // Step 2: run after explicit approval bound to the plan hash.
  run(taskId, { hash, device }) {
    const task = this.tasks.get(taskId);
    if (!task) return { ok: false, status: 404, reason: "unknown_task" };
    if (task.status !== "planned") return { ok: false, status: 409, reason: `task_${task.status}` };
    if (nowMs() > task.expires_at) { task.status = "expired"; return { ok: false, status: 410, reason: "expired" }; }
    if (hash !== task.hash) return { ok: false, status: 400, reason: "modified" };
    if (this.state.emergency) return { ok: false, status: 423, reason: "emergency_stopped" };
    task.status = "running";
    task.controller = new AbortController();
    task.approved_by = device?.name || null;
    audit.log({ event: "project_started", device: device?.name, detail: { task_id: taskId, name: task.name } });
    this._execute(task).catch((e) => { task.status = "failed"; this._log(task, `fatal: ${e.message}`); });
    return { ok: true, task: this.publicTask(task) };
  }

  cancel(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    if (task.status === "running") { task.controller.abort(); task.status = "cancelling"; }
    return this.publicTask(task);
  }

  cancelAll() { for (const t of this.tasks.values()) if (t.status === "running") { t.controller.abort(); t.status = "cancelling"; } }

  _log(task, text, extra = {}) {
    const entry = { at: nowMs(), text: String(text).slice(0, 2000), ...extra };
    task.progress.push(entry);
    if (task.progress.length > 500) task.progress.splice(0, task.progress.length - 500);
    this._emit("project", { task_id: task.task_id, status: task.status, entry });
  }

  async _execute(task) {
    const cfg = this.getConfig();
    const signal = task.controller.signal;
    this.state.beginBusy();
    try {
      fs.mkdirSync(task.workspace, { recursive: true });
      const meta = paths.readJson(path.join(task.workspace, ".jarvis-project.json"), { template: task.template, created_at: nowMs(), tasks: [] });
      const git = await hasGit();
      if (git) await this._checkpoint(task, "before");

      // Files: template first, then (optionally) the local model.
      const tpl = templates.get(task.template);
      if (tpl && !task.existing) {
        for (const f of tpl.files({ name: task.name, description: task.description })) {
          if (signal.aborted) throw new Error("cancelled");
          const full = safeJoin(task.workspace, f.path);
          fs.mkdirSync(path.dirname(full), { recursive: true });
          fs.writeFileSync(full, f.content, "utf8");
          task.changed_files.push(f.path);
          this._log(task, `wrote ${f.path}`);
        }
      }
      if (!task.mock && task.description) await this._modelEdit(task, cfg, signal);

      // Scans before any command runs.
      task.scan = scanProject(task.workspace);
      this._log(task, `secret scan: ${task.scan.secrets.length} finding(s); dependencies: ${task.scan.dependencies.length} checked, ${task.scan.dangerous.length} dangerous, ${task.scan.unknown_license.length} unknown license`);
      if (task.scan.secrets.length) throw new Error("Secret-looking values found in generated files; refusing to continue. See scan results.");
      if (task.scan.dangerous.length) throw new Error(`Dangerous dependencies found: ${task.scan.dangerous.join(", ")}`);

      for (const cmd of task.commands) {
        if (signal.aborted) throw new Error("cancelled");
        if (cmd.needs_network && cfg.offlineMode) { this._log(task, `skipped ${cmd.step}: offline mode (needs network)`); continue; }
        this._log(task, `running ${cmd.step}: ${cmd.argv.join(" ")}`);
        const res = await procs.run(cmd.argv[0], cmd.argv.slice(1), { cwd: task.workspace, timeoutMs: 10 * 60 * 1000, signal });
        const out = (res.stdout + "\n" + res.stderr).trim().slice(-4000);
        if (res.cancelled) throw new Error("cancelled");
        if (res.timedOut) throw new Error(`${cmd.step} timed out`);
        this._log(task, `${cmd.step} exit ${res.code}\n${out}`, { step: cmd.step, code: res.code });
        if (res.code !== 0) {
          if (cmd.step === "install") throw new Error(`install failed (exit ${res.code}). Are you online? Is npm installed?`);
          if (!task.mock && cmd.step !== "install") {
            const fixed = await this._modelFix(task, cfg, signal, cmd, out);
            if (fixed) {
              const again = await procs.run(cmd.argv[0], cmd.argv.slice(1), { cwd: task.workspace, timeoutMs: 10 * 60 * 1000, signal });
              this._log(task, `${cmd.step} (after fix) exit ${again.code}\n${(again.stdout + again.stderr).trim().slice(-2000)}`, { step: cmd.step, code: again.code });
              if (again.code === 0) continue;
            }
          }
          throw new Error(`${cmd.step} failed (exit ${res.code})`);
        }
      }
      task.scan = scanProject(task.workspace);
      if (git) await this._checkpoint(task, "after");
      task.changed_files = [...new Set(task.changed_files)];
      task.preview = previewFor(task);
      task.status = "completed";
      meta.tasks.push({ task_id: task.task_id, at: nowMs(), status: "completed", description: task.description.slice(0, 200) });
      paths.writeJson(path.join(task.workspace, ".jarvis-project.json"), { ...meta, template: task.template });
      this._log(task, `completed. ${task.changed_files.length} file(s) changed.`);
    } catch (e) {
      task.status = signal.aborted ? "cancelled" : "failed";
      task.error = e.message;
      this._log(task, task.status === "cancelled" ? "cancelled by user" : `failed: ${e.message}`);
    } finally {
      this.state.endBusy();
      task.finished_at = nowMs();
      audit.log({ event: "project_finished", status: task.status, detail: { task_id: task.task_id, name: task.name, files: task.changed_files.length, error: task.error || null } });
      this._emit("project", { task_id: task.task_id, status: task.status, done: true });
    }
  }

  async _checkpoint(task, label) {
    const cwd = task.workspace;
    if (!fs.existsSync(path.join(cwd, ".git"))) {
      await procs.run("git", ["init", "-q"], { cwd, timeoutMs: 20000 });
      await procs.run("git", ["config", "user.email", "jarvis@local"], { cwd, timeoutMs: 10000 });
      await procs.run("git", ["config", "user.name", "JARVIS"], { cwd, timeoutMs: 10000 });
    }
    await procs.run("git", ["add", "-A"], { cwd, timeoutMs: 60000 });
    const r = await procs.run("git", ["commit", "-q", "-m", `jarvis checkpoint (${label}) ${task.task_id.slice(0, 8)}`], { cwd, timeoutMs: 60000 });
    if (r.code === 0) {
      const rev = await procs.run("git", ["rev-parse", "--short", "HEAD"], { cwd, timeoutMs: 10000 });
      task.checkpoints.push({ label, commit: rev.stdout.trim() });
      this._log(task, `git checkpoint (${label}): ${rev.stdout.trim()}`);
    }
    if (label === "after") {
      const st = await procs.run("git", ["show", "--stat", "--name-status", "--format=", "HEAD"], { cwd, timeoutMs: 10000 });
      for (const line of st.stdout.split("\n")) { const m = line.match(/^[AMDR]\d*\t(.+)$/); if (m) task.changed_files.push(m[1]); }
    }
  }

  async _modelEdit(task, cfg, signal) {
    const resolved = await local.resolve(cfg);
    if (resolved.provider === "mock") { task.mock = true; this._log(task, "local model became unavailable; template only"); return; }
    this._log(task, `asking local model ${resolved.model} to implement: ${task.description.slice(0, 100)}`);
    const existing = listFiles(task.workspace).slice(0, 30).map((f) => `--- ${f}\n${fs.readFileSync(path.join(task.workspace, f), "utf8").slice(0, 4000)}`).join("\n");
    const sys = `You generate project files. Reply with ONE JSON object: {"files":[{"path":"relative/path","content":"..."}],"notes":"..."}. Only relative paths inside the project. No secrets, no API keys, no network calls to paid services, no telemetry. Keep the existing structure.`;
    let out;
    try { out = await local.generate(cfg, resolved, sys, `Project '${task.name}' (${task.template}). Task: ${task.description}\n\nCurrent files:\n${existing}`, { signal, json: true }); } catch (e) { this._log(task, `local model failed: ${e.message}`); return; }
    let data;
    try { data = local.extractJson(out); } catch { this._log(task, "local model did not return valid JSON; template kept as is"); return; }
    const files = Array.isArray(data.files) ? data.files.slice(0, 40) : [];
    for (const f of files) {
      if (!f || typeof f.path !== "string" || typeof f.content !== "string") continue;
      let full;
      try { full = safeJoin(task.workspace, f.path); } catch { this._log(task, `skipped unsafe path ${f.path}`); continue; }
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, f.content, "utf8");
      task.changed_files.push(f.path);
      this._log(task, `model wrote ${f.path}`);
    }
    if (data.notes) this._log(task, `model notes: ${String(data.notes).slice(0, 500)}`);
  }

  async _modelFix(task, cfg, signal, cmd, output) {
    const resolved = await local.resolve(cfg);
    if (resolved.provider === "mock") return false;
    this._log(task, `asking local model to fix ${cmd.step} failure`);
    const files = listFiles(task.workspace).slice(0, 30).map((f) => `--- ${f}\n${fs.readFileSync(path.join(task.workspace, f), "utf8").slice(0, 4000)}`).join("\n");
    let out;
    try { out = await local.generate(cfg, resolved, `You fix build/test failures. Reply with ONE JSON object {"files":[{"path":"...","content":"..."}]} containing only files that must change.`, `Command: ${cmd.argv.join(" ")}\nOutput:\n${output}\n\nFiles:\n${files}`, { signal, json: true }); } catch { return false; }
    let data;
    try { data = local.extractJson(out); } catch { return false; }
    let n = 0;
    for (const f of Array.isArray(data.files) ? data.files.slice(0, 20) : []) {
      if (!f || typeof f.path !== "string" || typeof f.content !== "string") continue;
      let full;
      try { full = safeJoin(task.workspace, f.path); } catch { continue; }
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, f.content, "utf8");
      task.changed_files.push(f.path);
      n++;
    }
    const scan = scanProject(task.workspace);
    if (scan.secrets.length) { this._log(task, "model fix introduced secret-looking values; reverting is left to git checkpoint"); return false; }
    return n > 0;
  }
}

function safeJoin(root, rel) {
  const full = path.resolve(root, rel);
  const relBack = path.relative(root, full);
  if (!relBack || relBack.startsWith("..") || path.isAbsolute(relBack) || relBack.split(path.sep).includes(".git")) throw new Error(`path escapes project: ${rel}`);
  return full;
}

function listFiles(root, depth = 0, acc = [], prefix = "") {
  if (depth > 6) return acc;
  let entries;
  try { entries = fs.readdirSync(path.join(root, prefix), { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    if (e.name === ".git" || e.name === "node_modules" || e.name === "dist") continue;
    const rel = prefix ? path.join(prefix, e.name) : e.name;
    if (e.isDirectory()) listFiles(root, depth + 1, acc, rel);
    else if (acc.length < 2000) acc.push(rel);
  }
  return acc;
}

function scanProject(root) {
  const result = { secrets: [], dependencies: [], dangerous: [], unknown_license: [] };
  for (const rel of listFiles(root)) {
    const full = path.join(root, rel);
    let text;
    try { if (fs.statSync(full).size > 512 * 1024) continue; text = fs.readFileSync(full, "utf8"); } catch { continue; }
    for (const [re, label] of SECRET_PATTERNS) if (re.test(text)) result.secrets.push({ file: rel, type: label });
  }
  const pkgFile = path.join(root, "package.json");
  if (fs.existsSync(pkgFile)) {
    const pkg = paths.readJson(pkgFile, {});
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    for (const [name, ver] of Object.entries(deps)) {
      const key = `${name}@${String(ver).replace(/^[\^~]/, "")}`;
      if (DANGEROUS_DEPS.has(name) || DANGEROUS_DEPS.has(key)) result.dangerous.push(key);
      let license = null;
      const installed = path.join(root, "node_modules", name, "package.json");
      if (fs.existsSync(installed)) {
        const ip = paths.readJson(installed, {});
        license = typeof ip.license === "string" ? ip.license : ip.license?.type || null;
        if (!license || !ALLOWED_LICENSES.test(license)) result.unknown_license.push(`${name} (${license || "no license field"})`);
      }
      result.dependencies.push({ name, version: ver, license });
    }
  }
  return result;
}

function previewFor(task) {
  const candidates = ["index.html", "public/index.html", "src/index.html", "README.md"];
  for (const c of candidates) if (fs.existsSync(path.join(task.workspace, c))) return { file: c, url: `/preview/${encodeURIComponent(task.name)}/${c}` };
  return null;
}

async function hasGit() {
  try { const r = await procs.run("git", ["--version"], { timeoutMs: 5000 }); return r.code === 0; } catch { return false; }
}

module.exports = { Projects, scanProject, safeJoin, listFiles };
