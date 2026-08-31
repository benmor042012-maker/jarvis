// Local bridge: the Chrome tab is JARVIS's ears (Hebrew speech recognition
// works there and cannot work inside Electron), this process is its hands.
//
// SECURITY: any page the user has open can reach localhost, so an open bridge
// would be a remote-control backdoor for the whole machine. Hence: bound to
// loopback only, a shared token on every command, and CORS echoed only for
// explicitly configured origins.

const http = require("http");
const crypto = require("crypto");
const { log } = require("./audit");

const MAX_BODY = 64 * 1024;
const WINDOW_MS = 60_000;
const RATE_LIMIT = 30;

let server = null;
let hits = { start: 0, count: 0 };

function rateLimited() {
  const now = Date.now();
  if (now - hits.start > WINDOW_MS) hits = { start: now, count: 0 };
  hits.count++;
  return hits.count > RATE_LIMIT;
}

function tokenMatches(given, expected) {
  if (typeof given !== "string" || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on length mismatch, so compare lengths first.
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function corsFor(origin, allowedOrigins) {
  const headers = {
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,X-Jarvis-Token",
    "Access-Control-Max-Age": "600",
  };
  // Never "*" — that would let any site drive the computer.
  if (origin && allowedOrigins.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

function send(res, status, body, headers) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// onCommand(text, history) -> { reply, toolTrace, aborted }
function start(getConfig, onCommand) {
  stop();
  const cfg = getConfig();
  const port = cfg.bridgePort || 8765;

  server = http.createServer(async (req, res) => {
    const current = getConfig();
    const origin = req.headers.origin || "";
    const cors = corsFor(origin, current.bridgeOrigins || []);

    if (req.method === "OPTIONS") {
      res.writeHead(204, cors);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://127.0.0.1:${port}`);

    // Unauthenticated liveness probe so the page can show a connected dot.
    // Deliberately reveals nothing but "JARVIS is running here".
    if (req.method === "GET" && url.pathname === "/health") {
      send(res, 200, { ok: true, app: "jarvis-desktop" }, cors);
      return;
    }

    if (req.method === "POST" && url.pathname === "/command") {
      if (rateLimited()) return send(res, 429, { error: "rate limit" }, cors);

      if (!tokenMatches(req.headers["x-jarvis-token"], current.bridgeToken)) {
        log({ action: "bridge_auth_failed", tool: "bridge", target: origin, result: "BLOCKED" });
        return send(res, 401, { error: "bad token" }, cors);
      }

      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return send(res, 400, { error: "bad json" }, cors);
      }

      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!text) return send(res, 400, { error: "text required" }, cors);

      const history = Array.isArray(body.history) ? body.history.slice(-20) : [];
      log({ action: "bridge_command", tool: "bridge", target: text.slice(0, 200), result: "RECEIVED" });

      try {
        const out = await onCommand(text, history);
        return send(res, 200, out, cors);
      } catch (e) {
        return send(res, 500, { error: String(e.message || e) }, cors);
      }
    }

    send(res, 404, { error: "not found" }, cors);
  });

  server.on("error", (e) => {
    console.error("bridge error:", e.message);
    log({ action: "bridge_error", tool: "bridge", result: "ERROR", detail: { error: String(e.message) } });
  });

  // Loopback only. Binding 0.0.0.0 would expose the machine to the network.
  server.listen(port, "127.0.0.1");
  return server;
}

function stop() {
  if (server) {
    try { server.close(); } catch {}
    server = null;
  }
}

module.exports = { start, stop, tokenMatches, corsFor };
