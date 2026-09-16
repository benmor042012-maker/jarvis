// Browser half of the sealed relay channel. Mirrors desktop/src/core/channel.js
// byte for byte: HKDF-SHA256 to split the device secret into two direction keys,
// then AES-256-GCM with the frame header as additional authenticated data.
//
// The relay forwards these frames and can read none of them. WebCrypto keeps the
// derived keys non-extractable, so nothing in the page can read them back out
// either.
const VERSION = 1;
const MAX_AGE_MS = 5 * 60 * 1000;
const SALT = "jarvis.relay.v1";

export type Direction = "to_agent" | "to_device";

export interface SealedFrame {
  v: number;
  device_id: string;
  dir: Direction;
  iv: string;
  ct: string;
  tag: string;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function unb64(text: string): Uint8Array {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const keyCache = new Map<string, Promise<CryptoKey>>();

async function channelKey(secret: string, direction: Direction): Promise<CryptoKey> {
  if (secret.length < 32) throw new Error("channel secret too short");
  const cacheKey = `${secret}|${direction}`;
  let pending = keyCache.get(cacheKey);
  if (!pending) {
    pending = (async () => {
      const ikm = await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, ["deriveKey"]);
      return crypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt: enc.encode(SALT), info: enc.encode(direction) },
        ikm,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      );
    })();
    keyCache.set(cacheKey, pending);
  }
  return pending;
}

const aadFor = (direction: Direction, deviceId: string) => enc.encode(`${String(VERSION)}|${direction}|${deviceId}`);

export async function seal(secret: string, direction: Direction, value: unknown, deviceId: string): Promise<SealedFrame> {
  const key = await channelKey(secret, direction);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = enc.encode(JSON.stringify({ v: VERSION, at: Date.now(), body: value }));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aadFor(direction, deviceId), tagLength: 128 }, key, plaintext),
  );
  // WebCrypto appends the 16-byte tag; Node's API keeps it separate, so split it
  // here to keep the wire format identical on both sides.
  const split = sealed.length - 16;
  return {
    v: VERSION,
    device_id: deviceId,
    dir: direction,
    iv: b64(iv),
    ct: b64(sealed.subarray(0, split)),
    tag: b64(sealed.subarray(split)),
  };
}

export async function open<T>(secret: string, direction: Direction, frame: SealedFrame): Promise<T> {
  if (!frame || typeof frame !== "object") throw new Error("malformed frame");
  if (frame.v !== VERSION) throw new Error("unsupported frame version");
  if (frame.dir !== direction) throw new Error("wrong direction");
  const key = await channelKey(secret, direction);
  const ct = unb64(frame.ct);
  const tag = unb64(frame.tag);
  const joined = new Uint8Array(ct.length + tag.length);
  joined.set(ct, 0);
  joined.set(tag, ct.length);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: unb64(frame.iv), additionalData: aadFor(direction, frame.device_id || ""), tagLength: 128 },
    key,
    joined,
  );
  const parsed = JSON.parse(dec.decode(plaintext)) as { v?: number; at?: number; body?: T };
  if (parsed.v !== VERSION) throw new Error("unsupported payload version");
  if (typeof parsed.at !== "number" || Math.abs(Date.now() - parsed.at) > MAX_AGE_MS) throw new Error("frame expired");
  return parsed.body as T;
}

export { VERSION, MAX_AGE_MS };
