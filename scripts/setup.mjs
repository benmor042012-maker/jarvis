#!/usr/bin/env node
// One-time setup: install dependencies and build the interface.
//
//   npm run setup
//
// Everything downloaded here is free and open source (Electron, Vite, React
// and their dependencies). No account, no key, no payment is ever requested.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runSync } from "./spawn-compat.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const C = { r: "\x1b[0m", b: "\x1b[1m", dim: "\x1b[2m", g: "\x1b[32m", y: "\x1b[33m", red: "\x1b[31m", c: "\x1b[36m" };
const say = (m) => { console.log(`${C.c}▸${C.r} ${m}`); };
const ok = (m) => { console.log(`${C.g}✔${C.r} ${m}`); };
const die = (m) => { console.log(`${C.red}✕${C.r} ${m}`); process.exit(1); };

function run(cmd, args, opts = {}) {
  return runSync(cmd, args, { cwd: ROOT, stdio: "inherit", ...opts });
}

const node = process.versions.node.split(".").map(Number);
if ((node[0] ?? 0) < 18) die(`Node.js 18 or newer is required (this is ${process.versions.node}). Get the LTS build from https://nodejs.org.`);

console.log(`\n${C.b}JARVIS setup${C.r} ${C.dim}— free and local. Nothing here needs an account, a key or a payment.${C.r}\n`);

say("Installing the interface (React + Vite, open source)…");
if (run("npm", ["--prefix", "client", "install", "--no-audit", "--no-fund"]).status !== 0) die("npm install failed in client/. Check your internet connection and try again.");
ok("Interface dependencies installed.");

say("Building the interface…");
if (run("npm", ["--prefix", "client", "run", "build"]).status !== 0) die("The interface build failed. The output above says why.");
ok("Interface built.");

const wantDesktop = !process.argv.includes("--no-desktop");
if (wantDesktop) {
  say("Installing the desktop agent (Electron, open source — about 100 MB, once)…");
  const r = run("npm", ["--prefix", "desktop", "install", "--no-audit", "--no-fund"]);
  if (r.status !== 0) {
    console.log(`${C.y}!${C.r} Electron could not be installed. The headless agent still works: ${C.b}npm run headless${C.r}`);
  } else ok("Desktop agent ready.");
}

say("Running the agent test suite…");
if (run("npm", ["--prefix", "desktop", "test"]).status !== 0) die("Tests failed. Please report the output above.");
ok("All tests passed.");

console.log(`\n${C.b}Done.${C.r} Start JARVIS with:  ${C.c}npm start${C.r}`);
console.log(`${C.dim}Headless (no window, e.g. Linux servers): npm run headless${C.r}`);
console.log(`${C.dim}Windows installer: npm run build:installer${C.r}\n`);
if (!existsSync(join(ROOT, "client", "dist", "index.html"))) die("client/dist/index.html is missing after the build; something went wrong above.");
