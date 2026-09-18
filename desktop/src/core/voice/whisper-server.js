// Keep the speech model in memory between sentences.
//
// The command-line program loads the model from disk on every single
// utterance. With a 466 MB model on an ordinary disk that is most of the wait:
// the machine spends longer opening the file than listening to the sentence.
//
// whisper.cpp ships whisper-server beside whisper-cli in the same download, so
// this costs nothing and installs nothing. It is started on demand, bound to
// 127.0.0.1 on a port the operating system hands out, never told about the
// network, and stopped when it has not been used for a while or when the model
// changes. If it will not start, or stops answering, transcription falls
// straight back to the command-line program — the slow path still works.
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");

const procs = require("../procs");

const IS_WIN = os.platform() === "win32";
// Left running this long with nothing to do, the model is not worth the memory.
const IDLE_MS = 15 * 60 * 1000;
const START_TIMEOUT_MS = 90000;

let current = null; // { child, port, model, binary, lastUsed, ready }

/** whisper-server beside the program we already found, if the download had one. */
function serverBinaryFor(cliPath) {
  const dir = path.dirname(cliPath);
  const name = IS_WIN ? "whisper-server.exe" : "whisper-server";
  const candidate = path.join(dir, name);
  try {
    return fs.statSync(candidate).isFile() ? candidate : null;
  } catch {
    return null;
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => { resolve(port); });
    });
  });
}

function get(url, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode || 0);
    });
    req.on("timeout", () => { req.destroy(); resolve(0); });
    req.on("error", () => { resolve(0); });
  });
}

/** Wait for the server to answer, or give up and say how long it waited. */
async function waitReady(port, child, timeoutMs = START_TIMEOUT_MS) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (child.exitCode !== null) return false;
    const code = await get(`http://127.0.0.1:${String(port)}/`, 2000);
    if (code > 0) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

function stop(why = "not needed") {
  if (!current) return;
  const { child } = current;
  current = null;
  try {
    child.kill();
  } catch {
    /* already gone */
  }
  return why;
}

let idleTimer = null;
function touchIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { stop("idle"); }, IDLE_MS);
  // Node should not stay alive for this alone.
  idleTimer.unref?.();
}

/**
 * The server for this model, started if it is not running yet.
 * Returns null when there is no server binary or it would not start — the
 * caller then uses the command-line program, which always works.
 */
async function ensure({ cliPath, model, threads }) {
  if (current && current.model === model && current.child.exitCode === null) {
    current.lastUsed = Date.now();
    touchIdle();
    return current;
  }
  // A different model, or it died: start again.
  if (current) stop(current.model === model ? "restarting" : "model changed");

  const binary = serverBinaryFor(cliPath);
  if (!binary) return null;

  const port = await freePort();
  const args = ["-m", model, "--host", "127.0.0.1", "--port", String(port), "-t", String(threads)];
  const child = procs.spawnLong(binary, args, { cwd: path.dirname(binary) });
  const ready = await waitReady(port, child);
  if (!ready) {
    try { child.kill(); } catch { /* already gone */ }
    return null;
  }
  current = { child, port, model, binary, lastUsed: Date.now() };
  touchIdle();
  return current;
}

/**
 * Transcribe a WAV through the running server.
 *
 * multipart/form-data, built here rather than with a library: it is one file
 * and two fields, and this project ships no runtime dependencies.
 */
async function transcribe({ port, wav, language, timeoutMs, signal }) {
  const boundary = `----jarvis${Math.random().toString(36).slice(2)}`;
  const field = (name, value) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\nContent-Type: audio/wav\r\n\r\n`),
    wav,
    Buffer.from("\r\n"),
    field("temperature", "0.0"),
    field("response_format", "json"),
    field("language", language || "auto"),
    Buffer.from(`--${boundary}--\r\n`),
  ]);

  return await new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/inference",
        method: "POST",
        headers: { "content-type": `multipart/form-data; boundary=${boundary}`, "content-length": body.length },
        timeout: timeoutMs,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { text += c; });
        res.on("end", () => {
          if (res.statusCode !== 200) {
            reject(new Error(`the speech server answered HTTP ${String(res.statusCode)}`));
            return;
          }
          try {
            const data = JSON.parse(text);
            resolve(String(data.text ?? data.transcription ?? ""));
          } catch {
            // Some builds answer with the bare transcript.
            resolve(text);
          }
        });
      },
    );
    req.on("timeout", () => { req.destroy(new Error("the speech server did not answer in time")); });
    req.on("error", reject);
    if (signal) {
      if (signal.aborted) { req.destroy(new Error("cancelled")); }
      else signal.addEventListener("abort", () => { req.destroy(new Error("cancelled")); }, { once: true });
    }
    req.end(body);
  });
}

/** What the window shows: whether the model is being kept in memory, and for which. */
function status() {
  if (!current || current.child.exitCode !== null) return { running: false, model: null, port: null };
  return { running: true, model: path.basename(current.model), port: current.port };
}

module.exports = { ensure, transcribe, stop, status, serverBinaryFor, IDLE_MS };
