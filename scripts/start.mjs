#!/usr/bin/env node
// Starts JARVIS. With Electron installed this opens the desktop agent (tray,
// hotkey, browser automation). Otherwise, or with --headless, it runs the
// agent without a window and prints the address and a pairing code.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { WIN, runAsync } from "./spawn-compat.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const C = { r: "\x1b[0m", b: "\x1b[1m", dim: "\x1b[2m", y: "\x1b[33m", red: "\x1b[31m", c: "\x1b[36m" };
const die = (m) => { console.log(`${C.red}✕${C.r} ${m}`); process.exit(1); };

if (!existsSync(join(ROOT, "client", "dist", "index.html"))) {
  console.log(`${C.y}!${C.r} The interface is not built yet — running setup first.`);
  if (spawnSync(process.execPath, [join(ROOT, "scripts", "setup.mjs"), "--no-desktop"], { stdio: "inherit" }).status !== 0) die("Setup failed.");
}

const headless = process.argv.includes("--headless");
const electron = join(ROOT, "desktop", "node_modules", ".bin", WIN ? "electron.cmd" : "electron");
const useDesktop = !headless && existsSync(electron);

if (!useDesktop && !headless) {
  console.log(`${C.y}!${C.r} Electron is not installed (run ${C.b}npm run setup${C.r} for the desktop window). Starting the headless agent instead.`);
  console.log(`${C.dim}  Headless mode has no tray, no global hotkey and no browser automation, and cannot confirm high-risk actions.${C.r}`);
}

function startHeadless(why) {
  if (why) {
    console.log(`\n${C.y}!${C.r} ${why}`);
    console.log(`${C.dim}  Falling back to the headless agent: no tray, no global hotkey, no browser automation,${C.r}`);
    console.log(`${C.dim}  and high-risk actions approved from a phone are refused because nobody can confirm them here.${C.r}\n`);
  }
  const h = spawn(process.execPath, ["headless.js"], { cwd: join(ROOT, "desktop"), stdio: "inherit" });
  h.on("error", (e) => { die(`Could not start the headless agent: ${e.message}`); });
  wire(h, false);
}

function wire(child, canFallBack) {
  const startedAt = Date.now();
  const stop = () => { child.kill(); process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  child.on("close", (code) => {
    if (!code) { process.exit(0); return; }
    // A desktop window that dies immediately usually means no display session
    // (a server, SSH without X, or a locked-down container). Say so, then run headless.
    if (canFallBack && Date.now() - startedAt < 15000) {
      startHeadless("The desktop window could not start — this computer has no usable graphical session for Electron.");
      return;
    }
    console.log(`\n${C.y}JARVIS stopped (exit ${String(code)}).${C.r} If the message above mentions ${C.b}EADDRINUSE${C.r}, JARVIS is already running — open http://127.0.0.1:8765/ instead.\n`);
    process.exit(code);
  });
}

if (useDesktop) {
  const child = runAsync(electron, ["."], { cwd: join(ROOT, "desktop"), stdio: "inherit" });
  child.on("error", () => { startHeadless("Electron could not be launched."); });
  wire(child, true);
} else {
  startHeadless(null);
}
