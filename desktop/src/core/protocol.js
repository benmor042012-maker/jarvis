// Versioned command protocol (v1).
//
// Every authenticated request carries an envelope:
//   { v:1, id, device_id, ts, expires, nonce, params, params_hash, session, user }
// and an HMAC-SHA256 signature over
//   v \n id \n device_id \n ts \n expires \n nonce \n METHOD \n path \n params_hash
// keyed with the device secret. The server rejects anything malformed,
// expired, replayed (nonce seen), duplicated (request id seen), unauthorized
// (unknown/revoked/expired device or bad signature) or modified (hash mismatch).
const { paramsHash, hmac, timingEqual, nowMs } = require("./util");

const PROTOCOL_VERSION = 1;
const MAX_SKEW_MS = 120000;
const MAX_TTL_MS = 5 * 60 * 1000;
const NONCE_TTL_MS = 10 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function signingString({ v, id, device_id, ts, expires, nonce }, method, path, hash) {
  return [v, id, device_id, ts, expires, nonce, method.toUpperCase(), path, hash].join("\n");
}

function sign(envelope, secret, method, path) {
  const hash = paramsHash(envelope.params);
  return { ...envelope, params_hash: hash, signature: hmac(secret, signingString(envelope, method, path, hash)) };
}

class ReplayGuard {
  constructor() {
    this.seen = new Map(); // key -> expiry
  }
  _sweep() {
    const now = nowMs();
    if (this.seen.size < 5000 && this._lastSweep && now - this._lastSweep < 30000) return;
    this._lastSweep = now;
    for (const [k, exp] of this.seen) if (exp < now) this.seen.delete(k);
  }
  claim(key, ttl = NONCE_TTL_MS) {
    this._sweep();
    if (this.seen.has(key)) return false;
    this.seen.set(key, nowMs() + ttl);
    return true;
  }
}

class Verifier {
  constructor(devices, { now = nowMs } = {}) {
    this.devices = devices;
    this.now = now;
    this.guard = new ReplayGuard();
  }

  // Returns { ok:true, device, envelope } or { ok:false, reason, status }
  verify(body, method, path, ip) {
    const env = body;
    if (!env || typeof env !== "object") return fail("malformed", 400);
    if (env.v !== PROTOCOL_VERSION) return fail("malformed", 400, "unsupported protocol version");
    for (const key of ["id", "device_id", "nonce", "signature", "params_hash"]) {
      if (typeof env[key] !== "string" || !env[key]) return fail("malformed", 400, `missing ${key}`);
    }
    if (!UUID_RE.test(env.id)) return fail("malformed", 400, "request id must be a UUID");
    if (typeof env.ts !== "number" || typeof env.expires !== "number") return fail("malformed", 400, "ts/expires must be numbers");
    if (env.params !== undefined && (typeof env.params !== "object" || env.params === null || Array.isArray(env.params))) return fail("malformed", 400, "params must be an object");
    const now = this.now();
    if (Math.abs(now - env.ts) > MAX_SKEW_MS) return fail("expired", 401, "clock skew too large");
    if (env.expires <= now) return fail("expired", 401);
    if (env.expires - env.ts > MAX_TTL_MS || env.expires < env.ts) return fail("malformed", 400, "invalid expiry window");

    const chk = this.devices.check(env.device_id);
    if (!chk.ok) return fail("unauthorized", 401, chk.reason);
    const device = chk.device;

    const hash = paramsHash(env.params || {});
    if (!timingEqual(hash, env.params_hash)) return fail("modified", 400, "params hash mismatch");
    const expected = hmac(device.secret, signingString(env, method, path, hash));
    if (!timingEqual(expected, env.signature)) return fail("unauthorized", 401, "bad signature");

    if (this.devices.rateLimited(device.id)) return fail("rate_limited", 429);
    if (!this.guard.claim(`id:${device.id}:${env.id}`)) return fail("duplicated", 409, "request id already used");
    if (!this.guard.claim(`nonce:${device.id}:${env.nonce}`)) return fail("replayed", 409, "nonce already used");

    this.devices.touch(device.id, ip);
    return { ok: true, device, envelope: env, params: env.params || {} };
  }
}

function fail(reason, status, detail) {
  return { ok: false, reason, status, detail: detail || reason };
}

module.exports = { Verifier, ReplayGuard, sign, signingString, PROTOCOL_VERSION, MAX_TTL_MS };
