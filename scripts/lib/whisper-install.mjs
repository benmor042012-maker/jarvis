// The parts of the speech-engine installer that can be wrong: choosing the
// right release asset, downloading something complete, recognising a real
// model file, and installing a program together with the libraries it needs.
//
// They live here, apart from the command-line wrapper, so they can be tested
// against a local server instead of only against the internet.
import { createWriteStream } from "node:fs";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";

export const WINDOWS_BIN_NAMES = ["whisper-cli.exe", "main.exe", "whisper.exe"];
export const UNIX_BIN_NAMES = ["whisper-cli", "main", "whisper"];

// Release assets are named by whoever cut the release, so the right one is
// found at run time rather than hardcoded into a URL that will rot.
const WINDOWS_ASSET = /^whisper-bin-x64\.zip$/i;
const WINDOWS_ASSET_FALLBACK = /^whisper.*(bin|win).*x64.*\.zip$/i;

// GGML model files start with one of these four-byte markers. Checking them
// catches the commonest failure by far: a proxy page, a rate-limit notice or an
// HTML error saved under the name of a model.
const GGML_MAGIC = ["ggml", "lmgg"];

export function fmtMb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Pick the ready-made Windows build out of a GitHub release list. Releases
 * without one are skipped rather than guessed at.
 */
export function pickWindowsAsset(releases) {
  for (const rel of Array.isArray(releases) ? releases : []) {
    const assets = Array.isArray(rel?.assets) ? rel.assets : [];
    const hit = assets.find((a) => WINDOWS_ASSET.test(a?.name ?? "")) ?? assets.find((a) => WINDOWS_ASSET_FALLBACK.test(a?.name ?? ""));
    if (hit?.browser_download_url) return { url: hit.browser_download_url, name: hit.name, tag: rel.tag_name ?? null };
  }
  return null;
}

/**
 * Download into a ".part" file that is only renamed once the whole thing has
 * arrived, so an interrupted download can never be mistaken for an installed
 * one.
 *
 * `stallMs` is the part that matters on bad Wi-Fi: a connection that goes quiet
 * mid-transfer never closes by itself, so without this the installer would sit
 * there for hours looking busy. If no bytes arrive for that long, the transfer
 * is abandoned with a message that says so. `onProgress` is purely cosmetic.
 */
export async function download(url, dest, { label = "download", onProgress, stallMs = 60000 } = {}) {
  const tmp = `${dest}.part`;
  fs.rmSync(tmp, { force: true });

  const ctrl = new AbortController();
  let stalled = false;
  let timer = null;
  const armStallTimer = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      stalled = true;
      ctrl.abort();
    }, stallMs);
    timer.unref?.();
  };
  const disarm = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const fail = (message) => {
    disarm();
    fs.rmSync(tmp, { force: true });
    return new Error(message);
  };

  let res;
  armStallTimer();
  try {
    res = await fetch(url, { redirect: "follow", headers: { "user-agent": "jarvis-installer" }, signal: ctrl.signal });
  } catch (e) {
    throw fail(stalled ? `${label}: ${url} stopped responding. Check the connection and run this again.` : `${label}: could not reach ${url} (${e.message}).`);
  }
  if (!res.ok || !res.body) throw fail(`${label}: the download failed (HTTP ${String(res.status)}). ${url}`);

  const total = Number(res.headers.get("content-length") || 0);
  let got = 0;
  const count = async function* (source) {
    for await (const chunk of source) {
      got += chunk.length;
      armStallTimer();
      onProgress?.(got, total);
      yield chunk;
    }
  };
  try {
    await pipeline(res.body, count, createWriteStream(tmp));
  } catch (e) {
    throw fail(
      stalled
        ? `${label}: the download stopped part-way through (${fmtMb(got)}${total ? ` of ${fmtMb(total)}` : ""}) and went quiet. Run this again — it starts over cleanly.`
        : `${label}: the download was interrupted (${e.message}). Run this again — it starts over cleanly.`,
    );
  }
  disarm();

  const size = fs.statSync(tmp).size;
  if (total && size !== total) {
    throw fail(`${label}: the download stopped early (${fmtMb(size)} of ${fmtMb(total)}). Run this again — it starts over cleanly.`);
  }
  fs.renameSync(tmp, dest);
  return size;
}

/** Depth-first search for a whisper program inside an unpacked release. */
export function findBinary(dir, names) {
  const wanted = (names ?? [...WINDOWS_BIN_NAMES, ...UNIX_BIN_NAMES]).map((n) => n.toLowerCase());
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (wanted.includes(e.name.toLowerCase())) return full;
    }
  }
  return null;
}

/**
 * Copy the program *and everything beside it*. On Windows whisper-cli.exe does
 * not start without the DLLs shipped next to it, and a lone .exe would look
 * installed and then fail on the first word you say.
 */
export function installFrom(binary, into, { chmod = process.platform !== "win32" } = {}) {
  const from = path.dirname(binary);
  fs.mkdirSync(into, { recursive: true });
  const files = [];
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (!e.isFile()) continue;
    fs.copyFileSync(path.join(from, e.name), path.join(into, e.name));
    files.push(e.name);
  }
  const installed = path.join(into, path.basename(binary));
  if (chmod) {
    try {
      fs.chmodSync(installed, 0o755);
    } catch {
      /* best effort: a copy without the execute bit still reports honestly below */
    }
  }
  return { installed, files };
}

/** Is this actually a GGML model, or an error page wearing its name? */
export function looksLikeModel(file) {
  try {
    if (fs.statSync(file).size < 1024 * 1024) return false;
    const fd = fs.openSync(file, "r");
    const head = Buffer.alloc(4);
    fs.readSync(fd, head, 0, 4, 0);
    fs.closeSync(fd);
    return GGML_MAGIC.includes(head.toString("ascii"));
  } catch {
    return false;
  }
}

/** A model whose name says ".en" cannot do Hebrew, at any size. */
export function isMultilingual(file) {
  return !/\.en\.bin$|-en\.bin$|\.en$/i.test(path.basename(file));
}
