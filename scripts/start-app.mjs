#!/usr/bin/env node
// Starts the local JARVIS app: the FastAPI backend and the built web UI,
// on one port, with one command.
//
//   npm run app
//
// It creates the Python virtual environment and installs dependencies the
// first time, builds the client if needed, then serves everything at
// http://localhost:8000 and opens the browser.

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WIN = process.platform === "win32";
const VENV = join(ROOT, ".venv");
const PY = WIN ? join(VENV, "Scripts", "python.exe") : join(VENV, "bin", "python");
const PORT = process.env.PORT || "8000";

const C = { r: "\x1b[0m", b: "\x1b[1m", dim: "\x1b[2m", g: "\x1b[32m", y: "\x1b[33m", red: "\x1b[31m", c: "\x1b[36m" };
const say = (m) => console.log(`${C.c}▸${C.r} ${m}`);
const ok = (m) => console.log(`${C.g}✔${C.r} ${m}`);
const die = (m) => {
  console.log(`${C.red}✕${C.r} ${m}`);
  process.exit(1);
};

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit", shell: WIN, ...opts });
}

function has(cmd, args = ["--version"]) {
  const r = spawnSync(cmd, args, { stdio: "ignore", shell: WIN });
  return r.status === 0;
}

// --- Python -----------------------------------------------------------------

let python = null;
for (const cand of WIN ? ["py", "python", "python3"] : ["python3", "python"]) {
  if (has(cand)) {
    python = cand;
    break;
  }
}
if (!python) die("Python 3.10+ is not installed. Get it from https://www.python.org/downloads/ (tick 'Add to PATH').");

if (!existsSync(PY)) {
  say("First run: creating the Python environment (about a minute)...");
  const args = python === "py" ? ["-3", "-m", "venv", ".venv"] : ["-m", "venv", ".venv"];
  if (run(python, args).status !== 0) die("Could not create the virtual environment.");
}
if (!existsSync(PY)) die(`Virtual environment is missing ${PY}. Delete the .venv folder and try again.`);

// Cheap check: is FastAPI importable? If not, install requirements.
const hasDeps = spawnSync(PY, ["-c", "import fastapi, uvicorn"], { stdio: "ignore" }).status === 0;
if (!hasDeps) {
  say("Installing backend dependencies...");
  if (run(PY, ["-m", "pip", "install", "-q", "-r", "requirements.txt"]).status !== 0) {
    die("Dependency install failed. Check your internet connection.");
  }
  ok("Backend ready.");
}

// --- Client -----------------------------------------------------------------

if (!existsSync(join(ROOT, "client", "node_modules"))) {
  if (!has("npm")) die("Node.js is not installed. Get it from https://nodejs.org (LTS).");
  say("First run: installing the interface (2-3 minutes)...");
  if (run("npm", ["--prefix", "client", "install"]).status !== 0) die("npm install failed.");
}
if (!existsSync(join(ROOT, "client", "dist", "index.html"))) {
  say("Building the interface...");
  if (run("npm", ["--prefix", "client", "run", "build"]).status !== 0) die("Build failed.");
  ok("Interface built.");
}

// --- Serve ------------------------------------------------------------------

const url = `http://localhost:${PORT}`;
console.log(`\n${C.b}JARVIS${C.r} ${C.dim}starting on${C.r} ${C.c}${url}${C.r}`);
console.log(`${C.dim}Press Ctrl+C to stop.${C.r}\n`);

const server = spawn(PY, ["-m", "uvicorn", "server.main:app", "--host", "127.0.0.1", "--port", PORT], {
  cwd: ROOT,
  stdio: "inherit",
  shell: false,
});

server.on("error", (e) => {
  die(`Could not start the server: ${e.message}`);
});

// Give uvicorn a moment to bind before opening a browser at it. Opening a
// browser is a convenience: if the machine has no opener (common on servers
// and minimal Linux installs) that must never take the server down with it.
setTimeout(() => {
  const opener = WIN ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    const child = spawn(opener[0], opener[1], { stdio: "ignore", detached: true, shell: WIN });
    child.on("error", () => {
      console.log(`${C.dim}(could not open a browser automatically — open ${url} yourself)${C.r}`);
    });
    child.unref();
  } catch {
    console.log(`${C.dim}(could not open a browser automatically — open ${url} yourself)${C.r}`);
  }
}, 2500);

const stop = () => {
  server.kill();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
server.on("close", (code) => {
  if (code && code !== 0) {
    console.log(
      `\n${C.y}JARVIS stopped.${C.r} If the message above says ${C.b}address already in use${C.r}, ` +
        `another copy is already running — open ${C.c}${url}${C.r}, or start this one on a different port:\n` +
        `  ${C.dim}${WIN ? "set PORT=8010 && npm run app" : "PORT=8010 npm run app"}${C.r}\n`,
    );
  }
  process.exit(code ?? 0);
});
