// Local HTTP server: serves the UI, the signed command API and an SSE event
// stream. Bound to 127.0.0.1 unless LAN access is enabled in settings. Never
// exposed to the public internet by design: no relay, no tunnel.
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { Verifier } = require("./protocol");
const { redact, isPrivateHost, randomHex, nowMs } = require("./util");
const audit = require("./audit");
const paths = require("./paths");

const MAX_BODY = 1024 * 1024;
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json; charset=utf-8", ".woff2": "font/woff2", ".woff": "font/woff", ".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8", ".webmanifest": "application/manifest+json" };

function json(res, status, body, extra = {}) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...extra });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > MAX_BODY) { reject(new Error("body too large")); req.destroy(); return; } chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

class Server {
  constructor(agent) {
    this.agent = agent;
    this.verifier = new Verifier(agent.devices);
    this.routes = new Map();
    this.sseClients = new Set();
    this.shortTokens = new Map(); // token -> { device_id, expires, purpose }
    this.server = null;
    this.listening = null;
    this.staticRoot = null;
    this._defineRoutes();
  }

  // --- static UI -------------------------------------------------------------
  setStaticRoot(dir) { this.staticRoot = dir && fs.existsSync(path.join(dir, "index.html")) ? dir : null; }

  // --- routes ----------------------------------------------------------------
  route(name, handler, { owner = false } = {}) { this.routes.set(name, { handler, owner }); }

  _defineRoutes() {
    const A = this.agent;
    const r = (n, h, o) => this.route(n, h, o);

    r("status", async () => A.status());
    r("events/token", async ({ device }) => ({ token: this._shortToken(device.id, "events", 60000) }));
    r("preview/token", async ({ device }) => ({ token: this._shortToken(device.id, "preview", 10 * 60000) }));

    r("command", async ({ params, device, session }) => {
      const command = String(params.command || "").trim();
      if (!command) throw httpError(400, "command is required");
      if (command.length > 4000) throw httpError(400, "command is too long");
      // The window names each request, so the words that stream back while
      // the model is still writing land on the right line and never on an
      // older one. Only the device that asked is told; nobody else's screen
      // fills with half a sentence meant for someone else.
      const requestId = typeof params.request_id === "string" ? params.request_id.slice(0, 64) : null;
      const onPartial = requestId
        ? (message) => { A.emit("event", { type: "plan_progress", at: Date.now(), request_id: requestId, device_id: device?.id ?? null, message }); }
        : undefined;
      const plan = await A.executor.plan(command, { device, session, forceMock: !!params.force_mock, onPartial });
      return { plan: A.executor.publicPlan(plan) };
    });
    r("plans/pending", async () => ({ plans: A.executor.pendingPlans() }));
    r("plans/get", async ({ params }) => { const p = A.executor.getPlan(String(params.plan_id || "")); if (!p) throw httpError(404, "unknown plan"); return { plan: A.executor.publicPlan(p) }; });
    r("plans/approve", async ({ params, device }) => {
      const res = await A.executor.approve(String(params.plan_id || ""), { actions_hash: String(params.actions_hash || ""), decision: params.decision === "approve" ? "approve" : "reject", scope: params.scope === "task" ? "task" : "once", device });
      if (!res.ok) throw httpError(res.status || 400, res.reason, res.detail);
      if (params.decision === "approve" && params.execute !== false) {
        const ex = A.executor.execute(res.plan.plan_id, { device });
        if (!ex.ok) throw httpError(ex.status || 400, ex.reason);
        return { plan: A.executor.publicPlan(A.executor.getPlan(res.plan.plan_id)), job: ex.job };
      }
      return { plan: res.plan };
    });
    r("plans/execute", async ({ params, device }) => {
      const ex = A.executor.execute(String(params.plan_id || ""), { device });
      if (!ex.ok) throw httpError(ex.status || 400, ex.reason);
      return { job: ex.job };
    });
    r("jobs/get", async ({ params }) => { const j = A.executor.getJob(String(params.job_id || "")); if (!j) throw httpError(404, "unknown job"); return { job: A.executor.publicJob(j) }; });
    r("jobs/cancel", async ({ params, device }) => { const j = A.executor.cancel(String(params.job_id || ""), { device }); if (!j) throw httpError(404, "unknown job"); return { job: j }; });

    r("emergency-stop", async ({ device }) => ({ stopped: A.emergencyStop(`device:${device.name}`) }));
    r("emergency-clear", async ({ device }) => { A.clearEmergency(device); return A.status(); }, { owner: true });
    r("pause", async ({ params }) => { A.state.setPaused(!!params.paused); return A.status(); }, { owner: true });
    r("mode", async ({ params, device }) => { A.setMode(String(params.mode || ""), device); return A.status(); }, { owner: true });

    r("settings/get", async () => ({ settings: A.settingsView() }));
    r("settings/update", async ({ params, device }) => ({ settings: A.updateSettings(params.settings || {}, device) }), { owner: true });
    r("tools/list", async () => ({ tools: A.toolsView() }));
    r("tools/policy", async ({ params, device }) => ({ tools: A.setToolPolicy(String(params.tool || ""), String(params.policy || ""), device) }), { owner: true });
    r("apps/list", async () => ({ apps: require("./tools/apps").catalog(A.cfg()) }));
    r("ai/detect", async ({ params }) => A.aiStatus(!!params.force));
    // Read-only numbers for the Command Center: battery, disk, memory, uptime.
    // The same tool a spoken "מצב המחשב" runs, without a plan in the way.
    r("system/status", async () => {
      const tool = A.registry.get("system_status");
      const out = await tool.run({}, { cfg: A.cfg(), signal: new AbortController().signal });
      return out.data;
    });

    r("devices/list", async () => ({ devices: A.devices.list() }));
    r("devices/pair-code", async ({ device }) => { const c = A.devices.createPairCode(); audit.log({ event: "pair_code_created", device: device.name }); return { ...c, urls: A.lanUrls() }; }, { owner: true });
    r("devices/revoke", async ({ params, device }) => {
      const id = String(params.device_id || "");
      if (device.role !== "owner" && id !== device.id) throw httpError(403, "forbidden", "Only the owner can revoke other devices.");
      if (!A.devices.revoke(id)) throw httpError(404, "unknown device");
      audit.log({ event: "device_revoked", device: device.name, detail: { revoked: id } });
      this._dropSse(id);
      A.emit("event", { type: "devices", at: nowMs(), devices: A.devices.list() });
      return { devices: A.devices.list() };
    });
    r("devices/rename", async ({ params, device }) => { if (!A.devices.rename(String(params.device_id || device.id), String(params.name || ""))) throw httpError(404, "unknown device"); return { devices: A.devices.list() }; });

    r("audit/read", async ({ params }) => ({ entries: audit.read({ limit: Math.min(1000, Number(params.limit) || 200), days: Math.min(90, Number(params.days) || 7) }) }));
    r("audit/export", async () => ({ files: audit.exportAll() }), { owner: true });
    r("data/export", async () => A.exportData(), { owner: true });
    r("data/delete", async ({ params, device }) => A.deleteData(params, device), { owner: true });

    r("drafts/templates", async ({ params }) => ({ templates: A.drafts.templates(params.language), label: require("./drafts").LABEL }));
    r("drafts/create", async ({ params, device }) => ({ draft: await A.drafts.create(params, { device }) }));
    r("drafts/list", async () => ({ drafts: A.drafts.list(), optout: A.drafts.optOut() }));
    r("drafts/update", async ({ params }) => { const d = A.drafts.update(String(params.id || ""), params); if (!d) throw httpError(404, "unknown draft"); return { draft: d }; });
    r("drafts/delete", async ({ params }) => ({ deleted: A.drafts.remove(String(params.id || "")) }));
    r("drafts/export", async ({ params }) => { const f = A.drafts.exportDraft(String(params.id || "")); if (!f) throw httpError(404, "unknown draft"); return { path: f }; });
    r("drafts/optout", async ({ params }) => ({ optout: params.remove ? A.drafts.removeOptOut(params.recipient) : A.drafts.addOptOut(params.recipient) }));

    r("projects/templates", async () => ({ templates: A.projects.templates() }));
    r("projects/list", async () => ({ projects: A.projects.list() }));
    r("projects/plan", async ({ params }) => ({ task: await A.projects.plan(params) }));
    r("projects/get", async ({ params }) => { const t = A.projects.get(String(params.task_id || "")); if (!t) throw httpError(404, "unknown task"); return { task: t }; });
    r("projects/run", async ({ params, device }) => { const res = A.projects.run(String(params.task_id || ""), { hash: String(params.hash || ""), device }); if (!res.ok) throw httpError(res.status, res.reason); return { task: res.task }; });
    r("projects/cancel", async ({ params }) => { const t = A.projects.cancel(String(params.task_id || "")); if (!t) throw httpError(404, "unknown task"); return { task: t }; });

    // --- voice -----------------------------------------------------------
    r("voice/status", async ({ params }) => A.voice.status({ force: !!params.force }));
    r("voice/microphone", async ({ params, device }) => { A.voice.setMicGranted(!!params.granted); audit.log({ event: "microphone_permission", device: device?.name, detail: { granted: !!params.granted } }); return A.voice.status(); }, { owner: true });
    // The window's own wake-word detector heard the phrase. Owner only: the
    // computer JARVIS runs on decides when it starts listening, and a paired
    // phone saying "he woke" is not evidence of anything.
    r("voice/wake", async ({ params, device }) => {
      const out = A.voice.wakeLocally({ device, source: "window", durationMs: Number(params.ms) || 0, distance: Number.isFinite(params.distance) ? Number(params.distance) : null });
      // Awaited: status() is async, and a promise spread into the body reaches
      // the page as {} — which is a voice status with no engine in it.
      return { ...out, status: await A.voice.status() };
    }, { owner: true });
    r("voice/pause", async ({ params }) => { A.voice.setPaused(!!params.paused); return A.voice.status(); });
    r("voice/mute", async ({ params }) => { A.voice.setMuted(!!params.muted); return A.voice.status(); });
    r("voice/done-speaking", async () => { A.voice.doneSpeaking(); return A.voice.status(); });
    r("voice/history", async ({ params }) => ({ history: A.voice.history.slice(-Math.min(200, Number(params.limit) || 50)).reverse() }));
    // The audio itself is uploaded to /api/voice/utterance (below) — it is
    // binary and would not survive the JSON envelope.
    r("voice/upload-token", async ({ device }) => ({ token: this._shortToken(device.id, "voice", 60000) }));

    // --- customer alerts --------------------------------------------------
    r("alerts/list", async ({ params }) => ({ alerts: A.alerts.list({ includeResolved: !!params.all }), label: require("./alerts").LABEL }));
    r("alerts/history", async ({ params }) => ({ alerts: A.alerts.history(Math.min(500, Number(params.limit) || 100)) }));
    r("alerts/scan", async ({ device }) => A.alerts.scan({ device, force: true }));
    r("alerts/acknowledge", async ({ params, device }) => { const a = A.alerts.acknowledge(String(params.id || ""), { device }); if (!a) throw httpError(404, "unknown alert"); return { alert: a }; });
    r("alerts/snooze", async ({ params, device }) => { const a = A.alerts.snooze(String(params.id || ""), params.minutes, { device }); if (!a) throw httpError(404, "unknown alert"); return { alert: a }; });
    r("alerts/resolve", async ({ params, device }) => { const a = A.alerts.resolve(String(params.id || ""), { device }); if (!a) throw httpError(404, "unknown alert"); return { alert: a }; });
    r("alerts/retry", async ({ params, device }) => { const a = A.alerts.retry(String(params.id || ""), { device }); if (!a) throw httpError(404, "unknown alert"); return { alert: a }; });
    r("alerts/raise", async ({ params, device }) => ({ alert: A.alerts.raiseManual({ customer_id: String(params.customer_id || ""), headline: params.headline }, { device }) }));
    r("customers/list", async () => ({ customers: A.alerts.customers() }));
    r("customers/save", async ({ params, device }) => ({ customer: A.alerts.upsertCustomer(params.customer || {}, { device }) }));
    r("customers/delete", async ({ params, device }) => ({ deleted: A.alerts.removeCustomer(String(params.id || ""), { device }) }));

    // --- phone ------------------------------------------------------------
    r("phone/capabilities", async () => A.phone.capabilities({ devices: A.devices.list() }));
    r("phone/request", async ({ params, device }) => ({ call: A.phone.request({ to: params.to, reason: params.reason, customer_id: params.customer_id || null, simulate: !!params.simulate }, { device, devices: A.devices.list() }) }));
    r("phone/decide", async ({ params, device }) => ({ call: A.phone.decide(String(params.id || ""), { decision: params.decision === "approve" ? "approve" : "reject", hash: String(params.hash || ""), device }) }));
    r("phone/dialer-opened", async ({ params, device }) => ({ call: A.phone.dialerOpened(String(params.id || ""), { device }) }));
    r("phone/outcome", async ({ params, device }) => ({ call: A.phone.setOutcome(String(params.id || ""), { outcome: String(params.outcome || ""), note: params.note, device }) }));
    r("phone/stop", async ({ params, device }) => { const c = A.phone.stop(String(params.id || ""), { device }); if (!c) throw httpError(404, "unknown call"); return { call: c }; });
    r("phone/note", async ({ params, device }) => ({ call: A.phone.addTranscript(String(params.id || ""), { text: params.text, speaker: params.speaker, device }) }));
    r("phone/draft", async ({ params }) => ({ call: A.phone.setDraft(String(params.id || ""), params.text) }));
    r("phone/list", async () => ({ calls: A.phone.list() }));
    r("phone/answer", async () => { A.phone.answerIncoming(); });
  }

  _shortToken(deviceId, purpose, ttl) {
    for (const [t, v] of this.shortTokens) if (v.expires < nowMs()) this.shortTokens.delete(t);
    const token = randomHex(24);
    this.shortTokens.set(token, { device_id: deviceId, purpose, expires: nowMs() + ttl });
    return token;
  }

  _useShortToken(token, purpose, { consume = false } = {}) {
    const v = this.shortTokens.get(String(token || ""));
    if (!v || v.purpose !== purpose || v.expires < nowMs()) return null;
    const chk = this.agent.devices.check(v.device_id);
    if (!chk.ok) return null;
    if (consume) this.shortTokens.delete(token);
    return chk.device;
  }

  // --- request handling ------------------------------------------------------
  async handle(req, res) {
    const ip = req.socket.remoteAddress || "";
    const hostHeader = String(req.headers.host || "");
    const hostName = hostHeader.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
    // DNS-rebinding defence: only accept Host values that are local/private.
    if (hostName && !isPrivateHost(hostName)) return json(res, 421, { error: "misdirected", detail: "JARVIS only answers on local/private hostnames." });

    const url = new URL(req.url, `http://${hostHeader || "127.0.0.1"}`);
    const p = url.pathname;
    const origin = String(req.headers.origin || "");

    if (req.method === "OPTIONS") {
      const headers = this._cors(origin, p);
      res.writeHead(headers ? 204 : 403, headers || {});
      return res.end();
    }

    try {
      if (p === "/api/health") {
        const cors = this._cors(origin, p) || {};
        const A = this.agent;
        return json(res, 200, { ok: true, app: "jarvis-agent", version: A.version, protocol: 1, state: A.state.state, mode: A.cfg().mode, lan: !!A.cfg().server.lanEnabled, offline_mode: !!A.cfg().offlineMode, requires_pairing: true, time: nowMs() }, cors);
      }
      if (p === "/api/pair" && req.method === "POST") {
        let body;
        try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: "malformed" }); }
        const result = this.agent.devices.pair({ code: body.code, name: body.name, user: body.user, ip, role: "remote", expiryDays: this.agent.cfg().deviceExpiryDays });
        if (!result.ok) {
          audit.log({ event: "pair_failed", status: result.reason, detail: { ip } });
          return json(res, result.reason === "rate_limited" ? 429 : 401, { error: result.reason });
        }
        const d = result.device;
        audit.log({ event: "device_paired", device: d.name, detail: { id: d.id, ip } });
        this.agent.emit("event", { type: "devices", at: nowMs(), devices: this.agent.devices.list() });
        return json(res, 200, { device_id: d.id, secret: d.secret, name: d.name, role: d.role, expires_at: d.expires_at, protocol: 1 });
      }
      if (p === "/api/voice/utterance" && req.method === "POST") return await this._utterance(req, res, url, ip);
      if (p === "/api/events" && req.method === "GET") return this._sse(req, res, url);
      if (p === "/api/files/screenshot" && req.method === "GET") return this._screenshot(req, res, url);
      if (p.startsWith("/preview/") && req.method === "GET") return this._preview(req, res, url);
      if (p.startsWith("/api/")) {
        if (req.method !== "POST") return json(res, 405, { error: "method_not_allowed" });
        return await this._api(req, res, p.slice(5), ip, origin);
      }
      return this._static(req, res, p);
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) audit.log({ event: "server_error", detail: { path: p, error: redact(String(e.message)) } });
      return json(res, status, { error: e.code || (status >= 500 ? "internal_error" : "bad_request"), detail: redact(String(e.detail || e.message || "error")).slice(0, 500) });
    }
  }

  _cors(origin, p) {
    if (!origin) return {};
    if (p === "/api/health") return { "access-control-allow-origin": origin, "access-control-allow-methods": "GET,OPTIONS", vary: "Origin" };
    // The UI is served from this very server; other origins get nothing.
    let o;
    try { o = new URL(origin); } catch { return null; }
    if (isPrivateHost(o.hostname) && (this.listening && Number(o.port || (o.protocol === "https:" ? 443 : 80)) === this.listening.port)) {
      return { "access-control-allow-origin": origin, "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "content-type", vary: "Origin" };
    }
    return null;
  }

  async _api(req, res, name, ip, origin) {
    const route = this.routes.get(name);
    if (!route) return json(res, 404, { error: "not_found" });
    const cors = this._cors(origin, "/api/" + name);
    if (origin && !cors) return json(res, 403, { error: "forbidden_origin" });
    let body;
    try { body = JSON.parse(await readBody(req)); } catch (e) { return json(res, e.message === "body too large" ? 413 : 400, { error: "malformed", detail: e.message === "body too large" ? "body too large" : "invalid JSON" }); }
    const v = this.verifier.verify(body, "POST", "/api/" + name, ip);
    if (!v.ok) {
      if (v.reason !== "rate_limited") audit.log({ event: "request_rejected", status: v.reason, detail: { path: name, ip, detail: v.detail } });
      return json(res, v.status, { error: v.reason, detail: v.detail }, cors || {});
    }
    if (route.owner && v.device.role !== "owner") return json(res, 403, { error: "forbidden", detail: "This action is only available from the JARVIS computer itself." }, cors || {});
    const result = await route.handler({ params: v.params, device: v.device, envelope: v.envelope, session: v.envelope.session || null, ip });
    return json(res, 200, { ok: true, request_id: v.envelope.id, ...result }, cors || {});
  }

  /**
   * One captured utterance, as a raw WAV body.
   *
   * It is authorised by a short-lived token from voice/upload-token rather than
   * the JSON envelope, because the body is binary. The audio is transcribed on
   * this computer and the temporary file is deleted straight after.
   */
  async _utterance(req, res, url, ip) {
    const device = this._useShortToken(url.searchParams.get("token"), "voice");
    if (!device) return json(res, 401, { error: "unauthorized", detail: "voice token missing or expired" });
    if (this.agent.devices.rateLimited(device.id, 240)) return json(res, 429, { error: "rate_limited" });
    const max = 8 * 1024 * 1024; // ~4 minutes of 16 kHz mono PCM
    const chunks = [];
    let size = 0;
    try {
      await new Promise((resolve, reject) => {
        req.on("data", (c) => {
          size += c.length;
          if (size > max) { reject(Object.assign(new Error("recording too large"), { status: 413 })); req.destroy(); return; }
          chunks.push(c);
        });
        req.on("end", resolve);
        req.on("error", reject);
      });
    } catch (e) {
      return json(res, e.status || 400, { error: "bad_request", detail: e.message });
    }
    const wav = Buffer.concat(chunks);
    this.agent.devices.touch(device.id, ip);
    try {
      const out = await this.agent.voice.handleUtterance(wav, {
        durationMs: Number(url.searchParams.get("ms")) || 0,
        device,
        source: device.role === "owner" ? "window" : "phone",
      });
      return json(res, 200, { ok: true, ...out });
    } catch (e) {
      const status = e.status || 500;
      return json(res, status, { error: e.code || "voice_error", detail: redact(String(e.message || e)).slice(0, 500), install: e.install || null });
    }
  }

  _sse(req, res, url) {
    const device = this._useShortToken(url.searchParams.get("token"), "events", { consume: true });
    if (!device) return json(res, 401, { error: "unauthorized", detail: "events token missing, used or expired" });
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
    res.write(`: connected\n\n`);
    const client = { res, device_id: device.id, role: device.role, since: nowMs() };
    this.sseClients.add(client);
    this.agent.devices.touch(device.id, req.socket.remoteAddress);
    const ping = setInterval(() => { try { res.write(`event: ping\ndata: ${nowMs()}\n\n`); this.agent.devices.touch(device.id); } catch { /* closed */ } }, 15000);
    req.on("close", () => { clearInterval(ping); this.sseClients.delete(client); this.agent.emit("event", { type: "devices", at: nowMs(), devices: this.agent.devices.list() }); });
    // Snapshot so a fresh client is consistent immediately.
    this._send(client, { type: "status", at: nowMs(), status: this.agent.status() });
    for (const plan of this.agent.executor.pendingPlans()) this._send(client, { type: "plan", at: nowMs(), plan });
    this.agent.emit("event", { type: "devices", at: nowMs(), devices: this.agent.devices.list() });
  }

  _send(client, event) {
    try { client.res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`); } catch { this.sseClients.delete(client); }
  }

  broadcast(event) {
    // "Alert my phones" is a setting, so an alert only reaches paired devices
    // when it is on. Everything else goes to every connected device.
    const phonesOff = event.type === "alert" && this.agent.cfg().alerts?.channels?.phone === false;
    for (const c of this.sseClients) {
      if (phonesOff && c.role !== "owner") continue;
      this._send(c, event);
    }
  }

  /** Paired devices other than this computer that are connected right now. */
  connectedRemotes() {
    const ids = new Set();
    for (const c of this.sseClients) if (c.role !== "owner") ids.add(c.device_id);
    return ids.size;
  }

  _dropSse(deviceId) {
    for (const c of this.sseClients) if (c.device_id === deviceId) { try { c.res.end(); } catch { /* ignore */ } this.sseClients.delete(c); }
  }

  connectedDevices() {
    return [...new Set([...this.sseClients].map((c) => c.device_id))];
  }

  _screenshot(req, res, url) {
    if (!this._useShortToken(url.searchParams.get("token"), "preview")) return json(res, 401, { error: "unauthorized" });
    const name = String(url.searchParams.get("name") || "");
    if (!/^screenshot-\d+\.png$/.test(name)) return json(res, 400, { error: "bad_name" });
    const file = path.join(paths.TEMP, name);
    if (!fs.existsSync(file)) return json(res, 404, { error: "not_found" });
    res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
    fs.createReadStream(file).pipe(res);
  }

  _preview(req, res, url) {
    if (!this._useShortToken(url.searchParams.get("token"), "preview")) return json(res, 401, { error: "unauthorized", detail: "preview token missing or expired" });
    const parts = url.pathname.split("/").slice(2).map(decodeURIComponent);
    const project = parts.shift();
    if (!project || !/^[a-z0-9֐-׿_-]+$/.test(project)) return json(res, 400, { error: "bad_project" });
    const root = path.join(paths.PROJECTS, project);
    const rel = parts.join("/") || "index.html";
    const file = path.resolve(root, rel);
    if (!file.startsWith(root + path.sep) || rel.split("/").includes("..") || rel.split("/").includes(".git")) return json(res, 403, { error: "forbidden" });
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return json(res, 404, { error: "not_found" });
    res.writeHead(200, { "content-type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream", "cache-control": "no-store", "content-security-policy": "default-src 'self' 'unsafe-inline' data: blob:; connect-src 'none'" });
    fs.createReadStream(file).pipe(res);
  }

  _static(req, res, p) {
    if (!this.staticRoot) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(`<!doctype html><meta charset="utf-8"><title>JARVIS</title><body style="font-family:system-ui;background:#050b18;color:#eaf6ff;padding:32px"><h1>JARVIS agent is running</h1><p>The web interface has not been built yet. Run <code>npm run build</code> in the project folder, then reload.</p><p>API health: <a href="/api/health" style="color:#3ecbff">/api/health</a></p></body>`);
    }
    let rel = decodeURIComponent(p);
    if (rel === "/" || rel === "") rel = "/index.html";
    const file = path.resolve(this.staticRoot, "." + rel);
    if (!file.startsWith(this.staticRoot)) return json(res, 403, { error: "forbidden" });
    const target = fs.existsSync(file) && fs.statSync(file).isFile() ? file : path.join(this.staticRoot, "index.html");
    const ext = path.extname(target).toLowerCase();
    const headers = { "content-type": MIME[ext] || "application/octet-stream", "cache-control": ext === ".html" ? "no-store" : "public, max-age=86400", "x-content-type-options": "nosniff" };
    if (ext === ".html") headers["content-security-policy"] = "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'";
    res.writeHead(200, headers);
    fs.createReadStream(target).pipe(res);
  }

  // --- lifecycle -------------------------------------------------------------
  start({ port, lan }) {
    return new Promise((resolve, reject) => {
      this.stop();
      const host = lan ? "0.0.0.0" : "127.0.0.1";
      this.server = http.createServer((req, res) => { this.handle(req, res).catch((e) => { try { json(res, 500, { error: "internal_error", detail: redact(String(e.message)) }); } catch { /* ignore */ } }); });
      this.server.keepAliveTimeout = 65000;
      this.server.on("error", (e) => { this.listening = null; reject(e); });
      this.server.listen(port, host, () => {
        this.listening = { port: this.server.address().port, host, lan: !!lan };
        resolve(this.listening);
      });
    });
  }

  stop() {
    if (!this.server) return;
    for (const c of this.sseClients) { try { c.res.end(); } catch { /* ignore */ } }
    this.sseClients.clear();
    try { this.server.close(); this.server.closeAllConnections?.(); } catch { /* ignore */ }
    this.server = null;
    this.listening = null;
  }
}

function httpError(status, code, detail) {
  const e = new Error(detail || code);
  e.status = status;
  e.code = code;
  e.detail = detail || code;
  return e;
}

function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === "IPv4" && !i.internal) out.push({ iface: name, address: i.address });
  }
  return out;
}

module.exports = { Server, httpError, lanAddresses };
