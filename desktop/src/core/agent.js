// Wires the core together: config, state, devices, registry, executor,
// drafts, projects, server, reminders and the emergency stop.
const EventEmitter = require("events");
const path = require("path");
const fs = require("fs");
const config = require("./config");
const paths = require("./paths");
const { AgentState } = require("./state");
const { DeviceStore } = require("./devices");
const { buildRegistry } = require("./tools");
const { Executor } = require("./executor");
const { Drafts } = require("./drafts");
const { Projects } = require("./projects");
const { VoiceSession } = require("./voice/session");
const stt = require("./voice/stt");
const { Alerts } = require("./alerts");
const { Phone } = require("./phone");
const { Server, lanAddresses } = require("./server");
const audit = require("./audit");
const procs = require("./procs");
const local = require("./planner/local-model");
const { dueReminders } = require("./tools/info");
const { nowMs } = require("./util");

const VERSION = require("../../package.json").version;

class Agent extends EventEmitter {
  constructor({ host = {}, encrypt, decrypt } = {}) {
    super();
    this.version = VERSION;
    this.host = host;
    this.state = new AgentState();
    this.devices = new DeviceStore({ encrypt, decrypt });
    this.registry = buildRegistry();
    this.executor = new Executor({ registry: this.registry, state: this.state, getConfig: () => this.cfg(), host });
    this.drafts = new Drafts({ getConfig: () => this.cfg() });
    this.projects = new Projects({ getConfig: () => this.cfg(), state: this.state });
    this.alerts = new Alerts({
      getConfig: () => this.cfg(),
      host: {
        notify: (title, body) => host.notify?.(title, body),
        sound: () => host.alertSound?.(),
        speak: (text) => host.speak?.(text),
        // How many paired phones are connected to this agent over your own
        // Wi-Fi right now. They receive the alert on the event stream they are
        // already holding open — there is no push service involved.
        phones: () => this.server.connectedRemotes(),
      },
    });
    this.phone = new Phone({ getConfig: () => this.cfg(), host });
    this.voice = new VoiceSession({
      getConfig: () => this.cfg(),
      host,
      // A voice command goes through exactly the same plan → approval → execute
      // path as a typed one. Voice is an input, not a way around the gates.
      onCommand: async (text, meta) => {
        const plan = await this.executor.plan(text, { device: meta.device, session: `voice:${meta.source}` });
        const pub = this.executor.publicPlan(plan);
        if (!plan.requires_approval && plan.actions.length && !plan.denied) {
          const ex = this.executor.execute(plan.plan_id, { device: meta.device });
          return { plan: pub, job: ex.ok ? ex.job : null, error: ex.ok ? null : ex.reason };
        }
        return { plan: pub, job: null };
      },
      onStop: (source) => this.emergencyStop(source),
    });
    this.server = new Server(this);
    this.emergencySource = null;
    this.hotkeyInfo = { requested: this.cfg().hotkeys.emergencyStop, active: null, error: null };

    const forward = (e) => { this.emit("event", e); };
    this.executor.on("event", forward);
    this.projects.on("event", forward);
    this.alerts.on("event", forward);
    this.phone.on("event", forward);
    this.voice.on("event", forward);
    this.voice.on("change", (c) => this.emit("event", { type: "voice_state", at: nowMs(), state: c.state, reason: c.reason }));
    this.state.on("change", (c) => this.emit("event", { type: "status", at: nowMs(), status: this.status(), reason: c.reason }));
    this.on("event", (e) => this.server.broadcast(e));
  }

  cfg() { return config.load(); }

  // --- lifecycle -------------------------------------------------------------
  async start({ staticRoot } = {}) {
    paths.ensureDirs();
    audit.prune(this.cfg().privacy.keepAuditDays);
    this.server.setStaticRoot(staticRoot || path.join(__dirname, "..", "..", "..", "client", "dist"));
    const { port, lanEnabled } = this.cfg().server;
    const info = await this.server.start({ port, lan: lanEnabled });
    this.reminderTimer = setInterval(() => this._tickReminders(), 15000);
    this.alerts.start();
    this.alertWakeTimer = setInterval(() => { try { this.alerts.wakeSnoozed(); } catch { /* keep the agent alive */ } }, 30000);
    if (this.alertWakeTimer.unref) this.alertWakeTimer.unref();
    audit.log({ event: "agent_started", detail: { port: info.port, lan: info.lan, version: VERSION } });
    return info;
  }

  async restartServer() {
    const { port, lanEnabled } = this.cfg().server;
    return this.server.start({ port, lan: lanEnabled });
  }

  stop() {
    clearInterval(this.reminderTimer);
    clearInterval(this.alertWakeTimer);
    this.alerts.stop();
    this.server.stop();
    procs.killAll();
    audit.log({ event: "agent_stopped" });
  }

  _tickReminders() {
    for (const r of dueReminders()) {
      this.emit("event", { type: "reminder", at: nowMs(), reminder: r });
      if (typeof this.host.notify === "function") { try { this.host.notify("JARVIS reminder", r.text); } catch { /* ignore */ } }
    }
  }

  // --- owner device ----------------------------------------------------------
  ownerDevice() {
    const existing = [...this.devices.devices.values()].find((d) => d.role === "owner" && !d.revoked);
    if (existing) return existing;
    return this.devices.create({ name: "This computer", role: "owner", expiryDays: 0, user: require("os").userInfo().username });
  }

  // --- emergency stop --------------------------------------------------------
  emergencyStop(source = "unknown") {
    const cancelled = this.executor.cancelAll();
    this.projects.cancelAll();
    const calls = this.phone.stopAll(source);
    this.voice.reset("emergency_stop");
    const killed = procs.killAll();
    // Set the source first: stopping the state machine emits the status event
    // straight away, and that event has to name what stopped everything.
    this.emergencySource = source;
    this.state.emergencyStop(source);
    audit.log({ event: "emergency_stop", detail: { source, cancelled_jobs: cancelled, killed_processes: killed, stopped_calls: calls } });
    if (typeof this.host.onEmergencyStop === "function") { try { this.host.onEmergencyStop(source); } catch { /* ignore */ } }
    return { cancelled_jobs: cancelled, killed_processes: killed, stopped_calls: calls };
  }

  clearEmergency(device) {
    this.state.clearEmergency();
    this.emergencySource = null;
    audit.log({ event: "emergency_cleared", device: device?.name });
  }

  setMode(mode, device) {
    config.update({ mode });
    audit.log({ event: "mode_changed", device: device?.name, detail: { mode } });
    this.emit("event", { type: "status", at: nowMs(), status: this.status() });
  }

  // --- views -----------------------------------------------------------------
  status() {
    const cfg = this.cfg();
    const connected = this.server.connectedDevices();
    return {
      version: VERSION,
      state: this.state.state,
      emergency: this.state.emergency,
      emergency_source: this.emergencySource,
      paused: this.state.paused,
      busy: this.state.busyCount > 0,
      mode: cfg.mode,
      offline_mode: !!cfg.offlineMode,
      lan: { enabled: !!cfg.server.lanEnabled, port: this.server.listening?.port || cfg.server.port, addresses: cfg.server.lanEnabled ? lanAddresses() : [] },
      hotkey: this.hotkeyInfo,
      cost_network: {
        local_ai_only: true,
        external_calls: 0,
        api_keys_configured: 0,
        payment_configured: false,
        outgoing_messages: 0,
        cloud_providers: "not implemented",
        data_leaving_computer: "none (local model servers on this machine/LAN only)",
      },
      devices: { connected: connected.length, paired: this.devices.list().filter((d) => !d.revoked).length },
      voice: { state: this.voice.state, enabled: !!cfg.voice?.enabled, microphone: this.voice.micGranted, paused: this.voice.paused, muted: this.voice.muted },
      alerts: { open: this.alerts.list().length, enabled: !!cfg.alerts?.enabled },
      phone: { enabled: !!cfg.phone?.enabled, can_answer_calls: false, open_calls: this.phone.list().filter((c) => ["pending_approval", "approved", "dialer_opened"].includes(c.status)).length },
      pending_plans: this.executor.pendingPlans().length,
      platform: process.platform,
      host: typeof this.host.confirmLocal === "function" ? "desktop" : "headless",
      uptime_ms: nowMs() - this.state.startedAt,
      time: nowMs(),
    };
  }

  async aiStatus(force) {
    const cfg = this.cfg();
    const detected = await local.detect(cfg, { force });
    const resolved = await local.resolve(cfg);
    return { detected, active: resolved, mock_mode: resolved.provider === "mock", capability_warning: local.CAPABILITY_WARNING, settings: cfg.ai };
  }

  settingsView() {
    const cfg = this.cfg();
    return { ...cfg, hotkeyActive: this.hotkeyInfo };
  }

  updateSettings(partial, device) {
    const allowed = ["mode", "language", "autoStart", "hotkeys", "server", "offlineMode", "ai", "approvedFolders", "extraApps", "allowedUrlHosts", "toolPolicies", "tts", "voice", "alerts", "phone", "drafts", "deviceExpiryDays", "privacy"];
    const clean = {};
    for (const k of allowed) if (partial[k] !== undefined) clean[k] = partial[k];
    if (clean.approvedFolders) {
      clean.approvedFolders = clean.approvedFolders.map((f) => path.resolve(String(f)));
      for (const f of clean.approvedFolders) if (!fs.existsSync(f) || !fs.statSync(f).isDirectory()) throw Object.assign(new Error(`Folder does not exist: ${f}`), { status: 400 });
      // Canonical spelling: Windows reports the same folder as both a short
      // (RUNNER~1) and a long name, and a stored short name would never match a
      // resolved long one.
      clean.approvedFolders = [...new Set(clean.approvedFolders.map((f) => paths.canonicalDir(f)))];
      if (!clean.approvedFolders.includes(paths.WORKSPACE)) clean.approvedFolders.unshift(paths.WORKSPACE);
    }
    if (clean.extraApps) {
      clean.extraApps = clean.extraApps.filter((a) => a && a.id && a.path).map((a) => ({ id: String(a.id).toLowerCase().slice(0, 40), title: String(a.title || a.id).slice(0, 60), path: String(a.path) }));
    }
    const before = this.cfg();
    let cfg;
    try { cfg = config.update(clean); } catch (e) { throw Object.assign(e, { status: 400 }); }
    local.resetCache();
    stt.resetCache();
    audit.log({ event: "settings_updated", device: device?.name, detail: { fields: Object.keys(clean) } });
    if (typeof this.host.onSettingsChanged === "function") { try { this.host.onSettingsChanged(cfg, before); } catch { /* ignore */ } }
    if (before.server.port !== cfg.server.port || before.server.lanEnabled !== cfg.server.lanEnabled) {
      this.restartServer().catch((e) => audit.log({ event: "server_restart_failed", detail: { error: e.message } }));
    }
    // A new scan interval, or switching the watcher off, has to take effect now
    // rather than at the next restart.
    if (before.alerts.enabled !== cfg.alerts.enabled || before.alerts.scanIntervalMs !== cfg.alerts.scanIntervalMs) {
      this.alerts.stop();
      this.alerts.start();
    }
    if (clean.voice) this.voice.reset("settings_changed");
    this.emit("event", { type: "status", at: nowMs(), status: this.status() });
    return this.settingsView();
  }

  toolsView() {
    const cfg = this.cfg();
    return this.registry.list({ cfg }).map((t) => ({ ...t, policy: cfg.toolPolicies[t.name] || null }));
  }

  setToolPolicy(tool, policy, device) {
    if (!this.registry.get(tool)) throw Object.assign(new Error("unknown tool"), { status: 404 });
    const cfg = this.cfg();
    const toolPolicies = { ...cfg.toolPolicies };
    if (!policy || policy === "default") delete toolPolicies[tool]; else toolPolicies[tool] = policy;
    try { config.update({ toolPolicies }); } catch (e) { throw Object.assign(e, { status: 400 }); }
    audit.log({ event: "tool_policy_changed", device: device?.name, detail: { tool, policy } });
    return this.toolsView();
  }

  lanUrls() {
    const port = this.server.listening?.port || this.cfg().server.port;
    const urls = [`http://127.0.0.1:${port}/`];
    if (this.cfg().server.lanEnabled) for (const a of lanAddresses()) urls.push(`http://${a.address}:${port}/`);
    return urls;
  }

  exportData() {
    return {
      exported_at: new Date().toISOString(),
      config: this.cfg(),
      devices: this.devices.list(),
      audit: audit.exportAll(),
      memory: paths.readJson(paths.MEMORY, []),
      reminders: paths.readJson(paths.REMINDERS, []),
      drafts: this.drafts.list(),
      optout: this.drafts.optOut(),
      customers: this.alerts.customers(),
      alert_history: this.alerts.history(),
      voice_transcripts: this.voice.history,
      note: "Device secrets, screenshots and project sources are not included; they stay in ~/.jarvis.",
    };
  }

  deleteData({ audit: delAudit = true, memory = true, drafts = true, screenshots = true, trash = false, devices = false, alerts = true, customers = false, voice = true } = {}, device) {
    const done = {};
    if (delAudit) done.audit_files = audit.deleteAll();
    if (memory) { try { fs.unlinkSync(paths.MEMORY); } catch { /* none */ } try { fs.unlinkSync(paths.REMINDERS); } catch { /* none */ } done.memory = true; }
    if (drafts) { for (const d of this.drafts.list()) this.drafts.remove(d.id); try { fs.rmSync(paths.DRAFTS, { recursive: true, force: true }); } catch { /* ignore */ } fs.mkdirSync(paths.DRAFTS, { recursive: true }); done.drafts = true; }
    if (screenshots) { try { fs.rmSync(paths.TEMP, { recursive: true, force: true }); } catch { /* ignore */ } fs.mkdirSync(paths.TEMP, { recursive: true }); done.screenshots = true; }
    if (trash) { try { fs.rmSync(paths.TRASH, { recursive: true, force: true }); } catch { /* ignore */ } fs.mkdirSync(paths.TRASH, { recursive: true }); done.trash = true; }
    if (devices) { for (const d of this.devices.list()) if (d.role !== "owner") this.devices.revoke(d.id); done.devices_revoked = true; }
    if (alerts) { done.alerts_deleted = this.alerts.deleteAll(); }
    if (voice) { done.voice_transcripts = this.voice.history.length; this.voice.history.length = 0; }
    if (customers) { try { fs.unlinkSync(require("./alerts").CUSTOMERS_FILE); } catch { /* none */ } done.customers_deleted = true; }
    audit.log({ event: "data_deleted", device: device?.name, detail: done });
    return { deleted: done };
  }
}

module.exports = { Agent, VERSION };
