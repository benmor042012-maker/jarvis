// The local model, run as a program rather than called over a socket.
//
// `ollama run <model>` with the prompt on stdin and the answer on stdout: no
// HTTP request, no port, no key, nothing to pay for, and nothing that can be
// pointed at a cloud endpoint by editing a setting. The prompt is written to
// the process's stdin, never into a command line, so no part of what the user
// says is ever parsed as a shell argument — and the process is spawned without
// a shell, so there is nothing to escape in the first place.
//
// The answer is streamed: every chunk the model produces is handed to the
// caller the moment it arrives, which is what lets JARVIS show its first words
// while the rest is still being written.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execFile } = require("child_process");

const IS_WIN = os.platform() === "win32";

// Keep the model in memory between requests. Loading a 4 GB model takes longer
// than answering with it, and paying that on every sentence is the difference
// between a conversation and a wait.
const KEEP_ALIVE = "30m";

let found = { at: 0, binary: null };

/**
 * Where Ollama is, whether or not PATH has caught up.
 *
 * The Windows installer adds it to PATH, but PATH is read when a terminal
 * opens: the window that ran the installer never sees it. Looking for the
 * program itself is the difference between "not installed" and "installed five
 * minutes ago".
 */
function findOllama({ force = false } = {}) {
  if (!force && found.binary && Date.now() - found.at < 60000) return found.binary;
  const home = os.homedir();
  const candidates = IS_WIN
    ? [
        path.join(process.env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "Programs", "Ollama", "ollama.exe"),
        path.join(process.env.ProgramFiles || "C:\\Program Files", "Ollama", "ollama.exe"),
        path.join(home, "AppData", "Local", "Ollama", "ollama.exe"),
      ]
    : ["/usr/local/bin/ollama", "/opt/homebrew/bin/ollama", "/usr/bin/ollama", path.join(home, ".local", "bin", "ollama")];
  // An explicit override is the whole answer: JARVIS_OLLAMA_BIN names the
  // program, and if nothing is there then there is no Ollama — it does not
  // fall through to PATH. That is what lets the tests keep their hands off
  // the real one on a developer's machine.
  const fromEnv = process.env.JARVIS_OLLAMA_BIN;
  if (fromEnv) {
    const hit = fs.existsSync(fromEnv) ? fromEnv : null;
    found = { at: Date.now(), binary: hit };
    return hit;
  }
  // Otherwise PATH, then where each installer puts it.
  const all = [IS_WIN ? "ollama.exe" : "ollama", ...candidates];
  for (const c of all) {
    try {
      if (c.includes(path.sep) && !fs.existsSync(c)) continue;
    } catch {
      continue;
    }
    found = { at: Date.now(), binary: c };
    return c;
  }
  found = { at: Date.now(), binary: null };
  return null;
}

function run(binary, args, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    execFile(binary, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ""), stderr: String(stderr || ""), error: err ? err.message : null });
    });
  });
}

/** The models installed here, newest first, straight from `ollama list`. */
async function list({ binary = findOllama(), timeoutMs = 8000 } = {}) {
  if (!binary) return { ok: false, models: [], error: "Ollama is not installed on this computer." };
  const r = await run(binary, ["list"], { timeoutMs });
  if (!r.ok) {
    // The CLI is there but the background service is not answering yet.
    return { ok: false, models: [], error: (r.stderr || r.error || "ollama list failed").split("\n")[0].slice(0, 200) };
  }
  const models = r.stdout
    .split(/\r?\n/)
    .slice(1) // the header row
    .map((line) => line.trim().split(/\s+/)[0])
    .filter((name) => name && name !== "NAME");
  return { ok: true, models, error: models.length ? null : "no model is installed yet" };
}

/**
 * Ask the model, streaming the answer.
 *
 * onToken is called with each chunk as it arrives — the first one is what the
 * window shows in place of "I'm on it". The whole answer is returned as well.
 *
 * `ollama run` is given its prompt on stdin, so nothing the user types is ever
 * an argument: not to a shell (there is none) and not to the program.
 */
function ask({ binary = findOllama(), model, prompt, signal, timeoutMs = 120000, json = false, onToken, keepAlive = KEEP_ALIVE, useFlags = true } = {}) {
  return new Promise((resolve, reject) => {
    if (!binary) {
      reject(new Error("Ollama is not installed on this computer."));
      return;
    }
    if (!model) {
      reject(new Error("no local model is installed"));
      return;
    }
    // useFlags is dropped on the retry below: an older Ollama that does not
    // know --keepalive or --format still answers, just without them.
    const args = ["run", model];
    if (useFlags) {
      if (keepAlive) args.push("--keepalive", keepAlive);
      if (json) args.push("--format", "json");
    }

    let child;
    try {
      // No shell: the model name comes from `ollama list` and the prompt never
      // reaches the argument list at all.
      child = spawn(binary, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false });
    } catch (e) {
      reject(new Error(`could not start Ollama: ${e.message}`));
      return;
    }

    let out = "";
    let err = "";
    let firstAt = null;
    let settled = false;
    const startedAt = Date.now();

    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      try {
        if (child.exitCode === null) child.kill();
      } catch {
        /* already gone */
      }
      fn(arg);
    };

    const timer = setTimeout(() => {
      finish(reject, Object.assign(new Error(`the local model did not answer within ${String(Math.round(timeoutMs / 1000))}s`), { code: "model_timeout", partial: out }));
    }, timeoutMs);
    // Node must not stay alive for this timer alone.
    timer.unref?.();

    const onAbort = () => {
      finish(reject, Object.assign(new Error("cancelled"), { code: "cancelled", partial: out }));
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (firstAt === null) firstAt = Date.now();
      out += chunk;
      try {
        onToken?.(chunk, out);
      } catch {
        /* a listener must never kill the answer */
      }
    });
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.on("error", (e) => { finish(reject, new Error(`could not run Ollama: ${e.message}`)); });
    child.on("close", (code) => {
      if (code === 0) {
        finish(resolve, { text: out, firstTokenMs: firstAt === null ? null : firstAt - startedAt, tookMs: Date.now() - startedAt, unknownFlag: false });
        return;
      }
      const said = (err || "").trim();
      // An older Ollama without one of the optional flags: say so, so the
      // caller can try again without them rather than falling back to no model.
      const unknownFlag = /unknown flag|unknown shorthand|flag provided but not defined/i.test(said);
      finish(reject, Object.assign(new Error(said ? said.split("\n")[0].slice(0, 300) : `ollama run exited with code ${String(code)}`), { code: unknownFlag ? "unknown_flag" : "model_failed", unknownFlag, partial: out }));
    });

    // The prompt goes in on stdin and the stream is closed, which is what tells
    // `ollama run` that the question is complete.
    child.stdin.on("error", () => { /* the process died; close handles it */ });
    child.stdin.end(String(prompt ?? ""), "utf8");
  });
}

/** Ask, and retry once without the optional flags if this Ollama is older. */
async function askCompat(opts) {
  try {
    return await ask(opts);
  } catch (e) {
    if (e.code !== "unknown_flag") throw e;
    return await ask({ ...opts, useFlags: false });
  }
}

function resetCache() {
  found = { at: 0, binary: null };
}

module.exports = { findOllama, list, ask, askCompat, resetCache, KEEP_ALIVE };
