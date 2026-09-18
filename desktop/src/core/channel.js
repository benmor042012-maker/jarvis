// End-to-end sealing for anything that travels through the relay.
//
// The relay is a dumb pipe that must learn nothing. Every frame is encrypted
// with AES-256-GCM under a key derived from the paired device's shared secret,
// which the relay never sees. The agent's protocol verifier still runs on the
// decrypted envelope, so sealing adds confidentiality without weakening the
// existing authentication: a relay operator can drop or delay frames, but can
// neither read them nor forge one the agent will accept.
const crypto = require("crypto");

const VERSION = 1;
const MAX_PLAINTEXT = 1024 * 1024; // 1 MiB — screenshots go over the local link
const MAX_AGE_MS = 5 * 60 * 1000;

// Separate keys for the two directions so a frame can never be reflected back
// at its sender and accepted.
function channelKey(secret, direction) {
  if (typeof secret !== "string" || secret.length < 32) throw new Error("channel secret too short");
  if (direction !== "to_agent" && direction !== "to_device") throw new Error("bad direction");
  return crypto.hkdfSync("sha256", Buffer.from(secret, "utf8"), Buffer.from("jarvis.relay.v1"), Buffer.from(direction, "utf8"), 32);
}

// Seal an arbitrary JSON value. `deviceId` travels in the clear because the
// agent needs it to pick the right key, and it is not a secret — it is a random
// UUID that identifies which paired device is talking.
function seal(secret, direction, value, { deviceId = "" } = {}) {
  const plaintext = Buffer.from(JSON.stringify({ v: VERSION, at: Date.now(), body: value }), "utf8");
  if (plaintext.length > MAX_PLAINTEXT) throw new Error("frame too large");
  const key = channelKey(secret, direction);
  const iv = crypto.randomBytes(12);
  const aad = Buffer.from(`${VERSION}|${direction}|${deviceId}`, "utf8");
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    v: VERSION,
    device_id: deviceId,
    dir: direction,
    iv: iv.toString("base64"),
    ct: ct.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

// Open a sealed frame. Throws on any tampering, wrong key, wrong direction or
// a frame older than MAX_AGE_MS (which bounds how long a captured frame is
// useful even before the protocol's own replay guard sees it).
function open(secret, direction, frame) {
  if (!frame || typeof frame !== "object") throw new Error("malformed frame");
  if (frame.v !== VERSION) throw new Error("unsupported frame version");
  if (frame.dir !== direction) throw new Error("wrong direction");
  for (const k of ["iv", "ct", "tag"]) {
    if (typeof frame[k] !== "string" || !frame[k]) throw new Error(`missing ${k}`);
  }
  const key = channelKey(secret, direction);
  const aad = Buffer.from(`${VERSION}|${direction}|${frame.device_id || ""}`, "utf8");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(frame.iv, "base64"));
  decipher.setAAD(aad);
  decipher.setAuthTag(Buffer.from(frame.tag, "base64"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(frame.ct, "base64")), decipher.final()]);
  const parsed = JSON.parse(plaintext.toString("utf8"));
  if (!parsed || parsed.v !== VERSION) throw new Error("unsupported payload version");
  if (typeof parsed.at !== "number" || Math.abs(Date.now() - parsed.at) > MAX_AGE_MS) throw new Error("frame expired");
  return parsed.body;
}

module.exports = { seal, open, channelKey, VERSION, MAX_PLAINTEXT, MAX_AGE_MS };
