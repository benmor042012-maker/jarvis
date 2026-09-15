const test = require("node:test");
const assert = require("node:assert/strict");
const { isolate } = require("./helpers");
isolate();
const { DeviceStore } = require("../src/core/devices");
const { Verifier, sign } = require("../src/core/protocol");
const { uuid, randomHex } = require("../src/core/util");

function envelope(device, params = {}, over = {}) {
  const now = Date.now();
  return sign({ v: 1, id: uuid(), device_id: device.id, ts: now, expires: now + 60000, nonce: randomHex(8), params, ...over }, device.secret, "POST", "/api/x");
}

test("pairing: single-use code, expiry, rate limit", () => {
  const store = new DeviceStore();
  const { code } = store.createPairCode();
  const ok = store.pair({ code, name: "phone", ip: "1" });
  assert.ok(ok.ok && ok.device.secret.length === 64);
  assert.equal(store.pair({ code, name: "again", ip: "1" }).reason, "invalid_or_expired_code");
  for (let i = 0; i < 8; i++) store.pair({ code: "0", name: "x", ip: "2" });
  assert.equal(store.pair({ code: "0", name: "x", ip: "2" }).reason, "rate_limited");
});

test("verifier accepts a valid envelope and rejects tampering, replay, expiry, revocation", () => {
  const store = new DeviceStore();
  const dev = store.create({ name: "d" });
  const v = new Verifier(store);
  const good = envelope(dev, { a: 1 });
  assert.equal(v.verify(good, "POST", "/api/x", "ip").ok, true);
  assert.equal(v.verify(good, "POST", "/api/x", "ip").reason, "duplicated");
  const replayNonce = envelope(dev, {}, { nonce: good.nonce });
  assert.equal(v.verify(replayNonce, "POST", "/api/x", "ip").reason, "replayed");
  const modified = { ...envelope(dev, { a: 1 }), params: { a: 2 } };
  assert.equal(v.verify(modified, "POST", "/api/x", "ip").reason, "modified");
  const wrongPath = envelope(dev);
  assert.equal(v.verify(wrongPath, "POST", "/api/other", "ip").reason, "unauthorized");
  const expired = sign({ v: 1, id: uuid(), device_id: dev.id, ts: Date.now() - 70000, expires: Date.now() - 10000, nonce: randomHex(8), params: {} }, dev.secret, "POST", "/api/x");
  assert.equal(v.verify(expired, "POST", "/api/x", "ip").reason, "expired");
  const badSig = { ...envelope(dev), signature: "00" };
  assert.equal(v.verify(badSig, "POST", "/api/x", "ip").reason, "unauthorized");
  assert.equal(v.verify({ v: 2 }, "POST", "/api/x", "ip").reason, "malformed");
  assert.equal(v.verify(envelope(dev, {}, { id: "not-a-uuid" }), "POST", "/api/x", "ip").reason, "malformed");
  const tooLong = sign({ v: 1, id: uuid(), device_id: dev.id, ts: Date.now(), expires: Date.now() + 10 * 60000, nonce: randomHex(8), params: {} }, dev.secret, "POST", "/api/x");
  assert.equal(v.verify(tooLong, "POST", "/api/x", "ip").reason, "malformed");
  store.revoke(dev.id);
  assert.equal(v.verify(envelope(dev), "POST", "/api/x", "ip").detail, "revoked");
  const unknown = { ...envelope(dev), device_id: uuid() };
  assert.equal(v.verify(unknown, "POST", "/api/x", "ip").reason, "unauthorized");
});

test("device expiry and per-device rate limit", () => {
  const store = new DeviceStore();
  const dev = store.create({ name: "d", expiryDays: 1 });
  dev.expires_at = Date.now() - 1;
  assert.equal(store.check(dev.id).reason, "device_expired");
  const d2 = store.create({ name: "e" });
  const v = new Verifier(store);
  let limited = false;
  for (let i = 0; i < 95; i++) { const r = v.verify(envelope(d2), "POST", "/api/x", "ip"); if (r.reason === "rate_limited") { limited = true; break; } }
  assert.ok(limited);
});

test("device store persists and reloads", () => {
  const store = new DeviceStore();
  const dev = store.create({ name: "persist" });
  const again = new DeviceStore();
  assert.equal(again.get(dev.id).secret, dev.secret);
  assert.ok(again.list().some((d) => d.name === "persist"));
});
