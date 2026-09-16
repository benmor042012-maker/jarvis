// JARVIS relay — a blind message pipe so a phone can reach the PC agent from
// anywhere, without exposing the agent's port to the internet.
//
// What this is NOT: it is not a server that can control the computer. Every
// frame it carries is AES-256-GCM sealed under a secret shared only by the
// paired phone and the agent, and every command inside is HMAC-signed with that
// same secret. The relay has neither key. It can delay or drop traffic; it can
// never read a command, forge one, or approve an action.
//
// Transport is long-polling rather than WebSockets so the agent needs no extra
// dependency and works unchanged inside Electron's Node runtime. One Durable
// Object per room keeps the agent's poll and the phone's send in the same
// place, which is what makes request/response matching correct.
//
// Free plan: one room polling every 25s costs ~3.5k requests/day against the
// 100k/day Workers free allowance.

const ROOM_RE = /^[a-f0-9]{32}$/;
const MAX_FRAME_BYTES = 128 * 1024;
const AGENT_ONLINE_MS = 60_000;
const POLL_HOLD_MS = 25_000;
const SEND_WAIT_MS = 30_000;
const MAX_QUEUE = 16;
const MESSAGE_TTL_MS = 60_000;

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...cors(), ...extra },
  });

// The relay is reached from the GitHub Pages UI and from phones, so it cannot
// use an origin allowlist. That is safe here precisely because possessing a
// room id grants no authority: every frame still has to survive the agent's
// signature check.
const cors = () => ({
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
});

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors() });

    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

    if (parts.length === 0 || parts[0] === "health") {
      return json({ ok: true, service: "jarvis-relay", version: 1 });
    }
    // /r/:room/:action
    if (parts[0] !== "r" || parts.length < 3) return json({ error: "not_found" }, 404);

    const room = parts[1];
    const action = parts[2];
    if (!ROOM_RE.test(room)) return json({ error: "bad_room" }, 400);
    if (!["poll", "reply", "send", "presence"].includes(action)) return json({ error: "not_found" }, 404);

    const id = env.ROOM.idFromName(room);
    return env.ROOM.get(id).fetch(new Request(`https://room/${action}`, request));
  },
};

export class Room {
  constructor(state) {
    this.state = state;
    // In-memory only. A relay that forgets everything on eviction is correct:
    // the agent retries, and nothing here is worth persisting.
    this.queue = []; // { id, frame, at }
    this.waitingAgent = null; // resolve fn for a held poll
    this.waitingSenders = new Map(); // messageId -> resolve fn
    this.agentSeenAt = 0;
  }

  async fetch(request) {
    const action = new URL(request.url).pathname.slice(1);
    try {
      if (action === "presence") return this.presence();
      if (action === "poll") return await this.poll();
      if (action === "send") return await this.send(request);
      if (action === "reply") return await this.reply(request);
      return json({ error: "not_found" }, 404);
    } catch (e) {
      // Never echo the request body: it is sealed, but the error text is not.
      return json({ error: "relay_error", detail: e?.name || "error" }, 500);
    }
  }

  agentOnline() {
    return Date.now() - this.agentSeenAt < AGENT_ONLINE_MS;
  }

  presence() {
    return json({
      agent_online: this.agentOnline(),
      last_seen_ms_ago: this.agentSeenAt ? Date.now() - this.agentSeenAt : null,
      queued: this.queue.length,
    });
  }

  async readFrame(request) {
    const raw = await request.text();
    if (raw.length > MAX_FRAME_BYTES) throw Object.assign(new Error("too_large"), { tooLarge: true });
    return JSON.parse(raw);
  }

  // The agent holds this open. Returning promptly with an empty list is fine
  // too — the agent simply polls again.
  async poll() {
    this.agentSeenAt = Date.now();
    this.sweep();
    if (this.queue.length) return json({ messages: this.take() });

    const messages = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.waitingAgent === resolve) this.waitingAgent = null;
        resolve([]);
      }, POLL_HOLD_MS);
      this.waitingAgent = (msgs) => {
        clearTimeout(timer);
        this.waitingAgent = null;
        resolve(msgs);
      };
    });
    this.agentSeenAt = Date.now();
    return json({ messages });
  }

  take() {
    const out = this.queue;
    this.queue = [];
    return out;
  }

  sweep() {
    const now = Date.now();
    this.queue = this.queue.filter((m) => now - m.at < MESSAGE_TTL_MS);
  }

  // A phone sends a sealed envelope and waits for the agent's sealed reply.
  async send(request) {
    let frame;
    try {
      frame = await this.readFrame(request);
    } catch (e) {
      return json({ error: e.tooLarge ? "too_large" : "malformed" }, e.tooLarge ? 413 : 400);
    }
    if (!frame || typeof frame !== "object") return json({ error: "malformed" }, 400);
    if (!this.agentOnline()) return json({ error: "agent_offline", detail: "The JARVIS computer is not connected." }, 503);

    this.sweep();
    if (this.queue.length >= MAX_QUEUE) return json({ error: "busy" }, 429);

    const id = crypto.randomUUID();
    const message = { id, frame, at: Date.now() };

    if (this.waitingAgent) this.waitingAgent([message]);
    else this.queue.push(message);

    const reply = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waitingSenders.delete(id);
        resolve(null);
      }, SEND_WAIT_MS);
      this.waitingSenders.set(id, (value) => {
        clearTimeout(timer);
        this.waitingSenders.delete(id);
        resolve(value);
      });
    });

    if (!reply) return json({ error: "timeout", detail: "The computer did not answer in time." }, 504);
    return json({ ok: true, frame: reply });
  }

  // The agent posts the sealed reply for one message id.
  async reply(request) {
    this.agentSeenAt = Date.now();
    let body;
    try {
      body = await this.readFrame(request);
    } catch (e) {
      return json({ error: e.tooLarge ? "too_large" : "malformed" }, e.tooLarge ? 413 : 400);
    }
    const waiter = this.waitingSenders.get(body?.id);
    if (!waiter) return json({ ok: true, delivered: false });
    waiter(body.frame);
    return json({ ok: true, delivered: true });
  }
}
