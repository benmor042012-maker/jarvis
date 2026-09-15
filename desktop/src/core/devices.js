// Device identity: pairing by one-time code, per-device secret (HMAC key),
// expiry, revocation and rate limits. The "owner" device is the JARVIS window
// on this computer; "remote" devices are phones/browsers that paired.
const paths = require("./paths");
const { randomHex, timingEqual, uuid, nowMs } = require("./util");

const PAIR_CODE_TTL_MS = 5 * 60 * 1000;
const PAIR_ATTEMPTS_PER_10MIN = 8;
const DEFAULT_RATE_PER_MIN = 90;

class DeviceStore {
  constructor({ encrypt, decrypt } = {}) {
    // encrypt/decrypt are optional hooks (Electron safeStorage). Without them,
    // secrets are stored in a 0600 file inside the user's profile.
    this.encrypt = encrypt || null;
    this.decrypt = decrypt || null;
    this.devices = new Map();
    this.pairCodes = new Map(); // code -> { created, name }
    this.pairAttempts = new Map(); // ip -> [timestamps]
    this.rate = new Map(); // deviceId -> [timestamps]
    this.load();
  }

  load() {
    const data = paths.readJson(paths.DEVICES, { devices: [] });
    this.devices.clear();
    for (const d of data.devices || []) {
      const dev = { ...d };
      if (dev.secret_enc && this.decrypt) {
        try { dev.secret = this.decrypt(dev.secret_enc); } catch { dev.secret = null; }
      }
      if (dev.secret) this.devices.set(dev.id, dev);
    }
  }

  save() {
    const devices = [...this.devices.values()].map((d) => {
      const { secret, ...rest } = d;
      if (this.encrypt) {
        try { return { ...rest, secret_enc: this.encrypt(secret) }; } catch { /* fall through to plain */ }
      }
      return { ...rest, secret };
    });
    paths.writeJson(paths.DEVICES, { devices });
  }

  // --- pairing -------------------------------------------------------------
  createPairCode() {
    // 8 digits, single use, 5 minutes.
    for (const [code, info] of this.pairCodes) if (nowMs() - info.created > PAIR_CODE_TTL_MS) this.pairCodes.delete(code);
    const code = String(Math.floor(10000000 + Math.random() * 90000000));
    this.pairCodes.set(code, { created: nowMs() });
    return { code, expires_at: nowMs() + PAIR_CODE_TTL_MS };
  }

  _pairAttempt(ip) {
    const now = nowMs();
    const list = (this.pairAttempts.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
    list.push(now);
    this.pairAttempts.set(ip, list);
    return list.length <= PAIR_ATTEMPTS_PER_10MIN;
  }

  pair({ code, name, ip, role = "remote", expiryDays = 30, user = "" }) {
    if (!this._pairAttempt(ip || "unknown")) return { ok: false, reason: "rate_limited" };
    const info = this.pairCodes.get(String(code || ""));
    if (!info || nowMs() - info.created > PAIR_CODE_TTL_MS) return { ok: false, reason: "invalid_or_expired_code" };
    this.pairCodes.delete(String(code));
    return { ok: true, device: this.create({ name, role, expiryDays, ip, user }) };
  }

  create({ name, role = "remote", expiryDays = 30, ip = "", user = "" }) {
    const device = {
      id: uuid(),
      name: String(name || "device").slice(0, 60),
      role,
      user: String(user || "").slice(0, 60),
      secret: randomHex(32),
      created_at: nowMs(),
      expires_at: expiryDays ? nowMs() + expiryDays * 86400000 : null,
      last_seen: null,
      last_ip: ip,
      revoked: false,
    };
    this.devices.set(device.id, device);
    this.save();
    return device;
  }

  get(id) {
    return this.devices.get(id) || null;
  }

  // Returns { ok, reason?, device? }
  check(id) {
    const d = this.get(id);
    if (!d) return { ok: false, reason: "unknown_device" };
    if (d.revoked) return { ok: false, reason: "revoked" };
    if (d.expires_at && nowMs() > d.expires_at) return { ok: false, reason: "device_expired" };
    return { ok: true, device: d };
  }

  touch(id, ip) {
    const d = this.get(id);
    if (!d) return;
    d.last_seen = nowMs();
    if (ip) d.last_ip = ip;
    // Persist last_seen at most every 30s to avoid hammering the disk.
    if (!d._savedAt || nowMs() - d._savedAt > 30000) { d._savedAt = nowMs(); this.save(); }
  }

  revoke(id) {
    const d = this.get(id);
    if (!d) return false;
    d.revoked = true;
    d.revoked_at = nowMs();
    this.save();
    return true;
  }

  rename(id, name) {
    const d = this.get(id);
    if (!d) return false;
    d.name = String(name || d.name).slice(0, 60);
    this.save();
    return true;
  }

  rateLimited(id, perMin = DEFAULT_RATE_PER_MIN) {
    const now = nowMs();
    const list = (this.rate.get(id) || []).filter((t) => now - t < 60000);
    list.push(now);
    this.rate.set(id, list);
    return list.length > perMin;
  }

  list() {
    return [...this.devices.values()].map((d) => ({
      id: d.id, name: d.name, role: d.role, user: d.user, created_at: d.created_at, expires_at: d.expires_at,
      last_seen: d.last_seen, last_ip: d.last_ip, revoked: !!d.revoked,
      online: !!d.last_seen && nowMs() - d.last_seen < 45000,
    }));
  }

  verifySecret(id, secret) {
    const d = this.get(id);
    return !!d && timingEqual(d.secret, secret);
  }
}

module.exports = { DeviceStore, PAIR_CODE_TTL_MS };
