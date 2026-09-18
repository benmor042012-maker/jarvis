// Outbound relay link, so a paired phone can reach this computer from anywhere.
//
// The agent dials out and long-polls; nothing listens on a public port. Every
// message is opened with the paired device's own secret, then handed to the
// *same* verifier that guards the local HTTP link — the relay path cannot skip
// a signature check, an expiry, a replay guard or a permission decision,
// because it reuses `server.dispatch` rather than re-implementing it.
const channel = require("./channel");
const audit = require("./audit");
const { nowMs } = require("./util");

const POLL_TIMEOUT_MS = 35_000;
const REPLY_TIMEOUT_MS = 15_000;
const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;
const ROOM_RE = /^[a-f0-9]{32}$/;

class RelayClient {
  constructor(agent, server, { fetchImpl } = {}) {
    this.agent = agent;
    this.server = server;
    this.fetch = fetchImpl || globalThis.fetch;
    this.running = false;
    this.attempt = 0;
    this.lastError = null;
    this.lastPollAt = null;
    this.connected = false;
    this._loop = null;
    this._abort = null;
  }

  status() {
    const cfg = this.agent.cfg();
    return {
      enabled: !!cfg.relay?.enabled,
      configured: !!(cfg.relay?.url && ROOM_RE.test(cfg.relay?.room || "")),
      running: this.running,
      connected: this.connected,
      url: cfg.relay?.url || null,
      last_poll: this.lastPollAt,
      last_error: this.lastError,
    };
  }

  start() {
    const cfg = this.agent.cfg();
    if (this.running) return this.status();
    if (!cfg.relay?.enabled) return this.status();
    if (!cfg.relay.url || !ROOM_RE.test(cfg.relay.room || "")) {
      this.lastError = "Relay is enabled but not configured.";
      return this.status();
    }
    this.running = true;
    this.attempt = 0;
    this.lastError = null;
    audit.log({ event: "relay_started", detail: { url: cfg.relay.url } });
    this._loop = this._run();
    return this.status();
  }

  async stop() {
    if (!this.running) return this.status();
    this.running = false;
    this.connected = false;
    try { this._abort?.abort(); } catch { /* already gone */ }
    try { await this._loop; } catch { /* the loop swallows its own errors */ }
    this._loop = null;
    audit.log({ event: "relay_stopped" });
    return this.status();
  }

  async restart() {
    await this.stop();
    return this.start();
  }

  _base() {
    const cfg = this.agent.cfg();
    return `${String(cfg.relay.url).replace(/\/+$/, "")}/r/${cfg.relay.room}`;
  }

  async _run() {
    while (this.running) {
      try {
        await this._pollOnce();
        this.attempt = 0;
        this.connected = true;
        this.lastError = null;
      } catch (e) {
        if (!this.running) break;
        this.connected = false;
        this.lastError = e?.message || String(e);
        const wait = Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** Math.min(this.attempt, 6));
        this.attempt++;
        // Full jitter: many agents reconnecting after an outage must not
        // synchronise into a thundering herd.
        await sleep(Math.random() * wait, () => !this.running);
      }
    }
    this.connected = false;
  }

  async _pollOnce() {
    this._abort = new AbortController();
    const res = await this.fetch(`${this._base()}/poll`, {
      method: "GET",
      signal: AbortSignal.any([this._abort.signal, AbortSignal.timeout(POLL_TIMEOUT_MS)]),
    });
    if (!res.ok) throw new Error(`relay poll failed (${res.status})`);
    const data = await res.json();
    // The link is up the moment the relay answers, not once the work it handed
    // over is finished — otherwise a long-running command reads as "offline".
    this.lastPollAt = nowMs();
    this.connected = true;
    this.lastError = null;
    const messages = Array.isArray(data?.messages) ? data.messages : [];
    for (const message of messages) await this._handle(message);
  }

  async _handle(message) {
    if (!message?.id || !message.frame) return;
    const deviceId = String(message.frame.device_id || "");
    const device = this.agent.devices.get(deviceId);

    // An unknown or revoked device gets no reply at all. Saying "unknown
    // device" to an unauthenticated caller would confirm which ids exist.
    if (!device || device.revoked) {
      audit.log({ event: "relay_rejected", status: "unknown_device", detail: { device_id: deviceId.slice(0, 8) } });
      return;
    }

    let reply;
    try {
      const request = channel.open(device.secret, "to_agent", message.frame);
      reply = await this._dispatch(request, device);
    } catch (e) {
      audit.log({ event: "relay_rejected", status: "unsealable", detail: { device_id: deviceId.slice(0, 8), reason: e?.message } });
      return;
    }

    try {
      const sealed = channel.seal(device.secret, "to_device", reply, { deviceId });
      await this.fetch(`${this._base()}/reply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: message.id, frame: sealed }),
        signal: AbortSignal.timeout(REPLY_TIMEOUT_MS),
      });
    } catch (e) {
      // The phone will time out and can retry; the command already ran, and the
      // protocol's duplicate-request guard makes a retry safe.
      this.lastError = `reply failed: ${e?.message || e}`;
    }
  }

  async _dispatch(request, device) {
    const path = String(request?.path || "");
    if (!/^[a-z0-9/_-]{1,64}$/i.test(path)) return { status: 400, body: { error: "malformed", detail: "bad path" } };
    // `via` is recorded so the audit log distinguishes a command that arrived
    // over the relay from one typed on this computer.
    return this.server.dispatch(path, request.body, { ip: `relay:${device.id.slice(0, 8)}`, via: "relay" });
  }
}

function sleep(ms, cancelled) {
  return new Promise((resolve) => {
    const step = 200;
    let waited = 0;
    const tick = () => {
      if (cancelled?.() || waited >= ms) return resolve();
      waited += step;
      setTimeout(tick, Math.min(step, ms - waited + step));
    };
    tick();
  });
}

module.exports = { RelayClient, ROOM_RE };
