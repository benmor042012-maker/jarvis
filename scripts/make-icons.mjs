#!/usr/bin/env node
// Draws the JARVIS icons: the window/app icon and the tray icon in each state.
//
// They are generated rather than hand-drawn so the look lives in code next to
// the interface it belongs to, and so a colour change is one line rather than a
// new set of opaque binaries. Pure Node: a small PNG writer (zlib is built in),
// no image library and nothing downloaded.
//
// Run: node scripts/make-icons.mjs
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "desktop", "assets");

// The orb in the window, as colours: a deep core, a bright ring, a faint halo.
// Each tray state keeps the same shape and changes only the light, so the icon
// is recognisable at 16 px and still says which state JARVIS is in.
const STATES = {
  connected: { ring: [86, 214, 255], core: [235, 252, 255], glow: [40, 120, 190] },
  listening: { ring: [120, 255, 200], core: [240, 255, 250], glow: [30, 150, 120] },
  busy: { ring: [255, 196, 96], core: [255, 246, 226], glow: [170, 110, 20] },
  paused: { ring: [150, 165, 190], core: [235, 240, 248], glow: [70, 80, 100] },
  offline: { ring: [110, 120, 140], core: [190, 198, 212], glow: [45, 50, 62] },
  emergency_stopped: { ring: [255, 104, 104], core: [255, 232, 232], glow: [150, 30, 30] },
};

const SS = 4; // supersampling: drawn big, averaged down, so the rings stay smooth

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** RGBA pixels (Uint8Array, w*h*4) to a PNG buffer. */
function png(pixels, w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    Buffer.from(pixels.buffer, y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const mix = (a, b, t) => a + (b - a) * t;

/**
 * One pixel of the orb, as a distance from the centre in 0..1 units of radius.
 * Everything is a function of that distance: the disc, the two rings, the core
 * and the halo outside the disc. Anything beyond the halo is transparent.
 */
function sample(d, c, ang) {
  if (d > 1.02) return [0, 0, 0, 0];
  const bg = [8, 18, 34];
  let rgb = [...bg];
  let a = 0;

  if (d <= 0.98) {
    // The disc: dark at the rim, lifting towards the middle.
    const lift = Math.max(0, 1 - d * 1.15);
    rgb = bg.map((v, i) => mix(v, c.glow[i], lift * 0.55));
    a = 255;
  } else {
    // A thin bright edge, then nothing.
    const edge = 1 - Math.min(1, (d - 0.98) / 0.04);
    rgb = c.ring.map((v, i) => mix(c.glow[i], v, edge));
    a = Math.round(235 * edge);
  }

  // Two rings, the outer one brighter, as in the interface.
  for (const [at, width, strength] of [[0.86, 0.055, 1], [0.6, 0.04, 0.72]]) {
    const near = 1 - Math.min(1, Math.abs(d - at) / width);
    if (near > 0) {
      const t = near ** 1.6 * strength;
      rgb = rgb.map((v, i) => mix(v, c.ring[i], t));
      a = Math.max(a, Math.round(255 * t));
    }
  }

  // Twelve short spokes between the rings, the detail that makes it read as an
  // instrument rather than a target.
  if (d > 0.62 && d < 0.84) {
    const step = (Math.PI * 2) / 12;
    const off = Math.abs(((ang % step) + step) % step - step / 2);
    const near = 1 - Math.min(1, off / (step * 0.16));
    if (near > 0) {
      const t = near ** 1.5 * 0.5;
      rgb = rgb.map((v, i) => mix(v, c.ring[i], t));
      a = Math.max(a, Math.round(255 * t));
    }
  }

  // The core.
  const core = 1 - Math.min(1, d / 0.2);
  if (core > 0) {
    const t = core ** 1.3;
    rgb = rgb.map((v, i) => mix(v, c.core[i], t));
    a = 255;
  }

  return [rgb[0], rgb[1], rgb[2], a];
}

function draw(size, c) {
  const big = size * SS;
  const pixels = new Uint8Array(size * size * 4);
  const half = big / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x * SS + sx + 0.5;
          const py = y * SS + sy + 0.5;
          const d = Math.hypot(px - half, py - half) / (half * 0.96);
          const s = sample(d, c, Math.atan2(py - half, px - half));
          // Premultiplied while averaging, so a transparent neighbour cannot
          // drag a colour towards black along the edge.
          r += s[0] * s[3];
          g += s[1] * s[3];
          b += s[2] * s[3];
          a += s[3];
        }
      }
      const i = (y * size + x) * 4;
      pixels[i] = a ? Math.round(r / a) : 0;
      pixels[i + 1] = a ? Math.round(g / a) : 0;
      pixels[i + 2] = a ? Math.round(b / a) : 0;
      pixels[i + 3] = Math.round(a / (SS * SS));
    }
  }
  return png(pixels, size, size);
}

mkdirSync(OUT, { recursive: true });
const written = [];
function write(name, buf) {
  writeFileSync(join(OUT, name), buf);
  written.push(`${name} (${String(buf.length)} bytes)`);
}

// The window and taskbar icon: the connected orb, large.
write("icon.png", draw(256, STATES.connected));
for (const [state, c] of Object.entries(STATES)) {
  write(`tray-${state}.png`, draw(16, c));
  write(`tray-${state}-32.png`, draw(32, c));
  write(`tray-${state}-256.png`, draw(256, c));
}
console.log(`Wrote ${String(written.length)} icons into ${OUT}`);
for (const w of written) console.log(`  ${w}`);
