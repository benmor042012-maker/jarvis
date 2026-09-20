#!/usr/bin/env node
// Starts JARVIS. With Electron installed this opens the desktop agent (tray,
// hotkey, browser automation). Otherwise, or with --headless, it runs the
// agent without a window and prints the address and a pairing code.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

import { WIN, runAsync, runSync } from "./spawn-compat.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const C = { r: "\x1b[0m", b: "\x1b[1m", dim: "\x1b[2m", y: "\x1b[33m", red: "\x1b[31m", c: "\x1b[36m" };
const die = (m) => { console.log(`${C.red}✕${C.r} ${m}`); process.exit(1); };

/**
 * Bring in updates before starting, so a start is all it takes to be current.
 *
 * Only when this folder is a git clone with a tracked branch, only a
 * fast-forward (local edits are never overwritten), only from the remote it
 * already has — no other address is ever contacted. Offline, or with nothing
 * new, it says so in one line and carries on with what is here. When the
 * interface source or its dependencies changed, they are rebuilt and
 * reinstalled here rather than left for the person to remember.
 */
function updateFromGit() {
  if (process.argv.includes("--no-update") || !existsSync(join(ROOT, ".git"))) return;
  const git = (args, timeout = 20000) => spawnSync("git", args, { cwd: ROOT, encoding: "utf8", timeout, windowsHide: true });
  const before = git(["rev-parse", "HEAD"]).stdout?.trim();
  if (!before) return;
  const fetched = git(["fetch", "--quiet"], 25000);
  if (fetched.status !== 0) {
    console.log(`${C.dim}Update check skipped (${(fetched.stderr || "no network").trim().split("\n")[0].slice(0, 80)}). Starting what is here.${C.r}`);
    return;
  }
  const behind = Number(git(["rev-list", "--count", "HEAD..@{u}"]).stdout?.trim() || 0);
  if (!behind) return;
  console.log(`${C.c}↓${C.r} ${String(behind)} update(s) available — bringing them in…`);
  const pulled = git(["pull", "--ff-only", "--quiet"], 60000);
  if (pulled.status !== 0) {
    console.log(`${C.y}!${C.r} Could not update automatically (${(pulled.stderr || "").trim().split("\n")[0].slice(0, 120)}). Starting what is here; run ${C.b}git pull${C.r} to see why.`);
    return;
  }
  const changed = git(["diff", "--name-only", before, "HEAD"]).stdout || "";
  if (/^(client|desktop)\/package(-lock)?\.json$/m.test(changed)) {
    console.log(`${C.dim}Dependencies changed — installing…${C.r}`);
    for (const dir of ["client", "desktop"]) {
      if (new RegExp(`^${dir}/package`, "m").test(changed) && runSync("npm", ["--prefix", dir, "install", "--no-audit", "--no-fund"], { cwd: ROOT, stdio: "inherit" }).status !== 0) die(`npm install failed in ${dir}/.`);
    }
  }
  if (/^client\//m.test(changed)) {
    console.log(`${C.dim}The interface changed — rebuilding…${C.r}`);
    if (runSync("npm", ["run", "build"], { cwd: ROOT, stdio: "inherit" }).status !== 0) die("The interface build failed. The output above says why.");
  }
  console.log(`${C.c}✓${C.r} Updated to ${git(["log", "-1", "--format=%h %s"]).stdout?.trim() || "the latest version"}.`);
}
updateFromGit();

/**
 * The window shows whatever was built last. After a `git pull` by hand the
 * source is newer than the bundle, and starting would show the old screen
 * with the new code sitting beside it — so an out-of-date bundle is rebuilt
 * here, the same way the browser test refuses to test a stale one.
 */
function newestIn(dir) {
  let latest = 0;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else latest = Math.max(latest, statSync(full).mtimeMs);
    }
  };
  try { walk(dir); } catch { /* nothing there */ }
  return latest;
}
const indexHtml = join(ROOT, "client", "dist", "index.html");
if (existsSync(indexHtml) && existsSync(join(ROOT, "client", "node_modules"))) {
  const built = statSync(indexHtml).mtimeMs;
  if (newestIn(join(ROOT, "client", "src")) > built || newestIn(join(ROOT, "client", "public")) > built) {
    console.log(`${C.dim}The interface source is newer than the last build — rebuilding…${C.r}`);
    if (runSync("npm", ["run", "build"], { cwd: ROOT, stdio: "inherit" }).status !== 0) die("The interface build failed. The output above says why.");
  }
}

if (!existsSync(join(ROOT, "client", "dist", "index.html"))) {
  console.log(`${C.y}!${C.r} The interface is not built yet — running setup first.`);
  if (spawnSync(process.execPath, [join(ROOT, "scripts", "setup.mjs"), "--no-desktop"], { stdio: "inherit" }).status !== 0) die("Setup failed.");
}

const headless = process.argv.includes("--headless");
// Started from a shortcut or a .bat file: JARVIS has to outlive the window that
// launched it. Without this it runs as a child of that console, and closing the
// console takes the tray agent down with it — which is exactly what a tray
// agent must never do.
const detached = process.argv.includes("--detached");

function configuredPort() {
  const home = process.env.JARVIS_HOME || join(homedir(), ".jarvis");
  try {
    return Number(JSON.parse(readFileSync(join(home, "config.json"), "utf8"))?.server?.port) || 8765;
  } catch {
    return 8765;
  }
}

/** Ask the agent itself whether it is up, rather than assuming it started. */
async function waitForAgent(port, timeoutMs = 40000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const res = await fetch(`http://127.0.0.1:${String(port)}/api/health`, { cache: "no-store" });
      if (res.ok) return await res.json();
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => { setTimeout(r, 400); });
  }
  return null;
}

/**
 * Launch, let go, and then check. The launcher exits once the agent answers, so
 * the window it was started from can be closed straight away.
 */
async function launchDetached(cmd, args, cwd, what) {
  const port = configuredPort();
  const child = runAsync(cmd, args, { cwd, detached: true, stdio: "ignore", windowsHide: true });
  let failed = null;
  child.on("error", (e) => { failed = e.message; });
  child.unref();
  console.log(`${C.dim}Starting ${what}…${C.r}`);
  const health = await waitForAgent(port);
  if (!health) {
    die(failed ? `JARVIS could not be started: ${failed}` : `JARVIS did not come up on port ${String(port)} within 40 seconds. Run ${C.b}npm start${C.r} in this window to see why.`);
  }
  console.log(`\n${C.b}JARVIS is running.${C.r} ${C.dim}(version ${health.version}, process ${String(child.pid ?? 0)})${C.r}`);
  console.log(`  Open it at ${C.c}http://127.0.0.1:${String(port)}/${C.r}`);
  console.log(`  ${C.dim}It keeps running in the tray — you can close this window. Quit it from the tray icon.${C.r}\n`);
  process.exit(0);
}
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
  if (detached) {
    void launchDetached(process.execPath, ["headless.js"], join(ROOT, "desktop"), "the headless agent");
    return;
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

/**
 * Electron with an app path it cannot read opens its own welcome window, which
 * looks like JARVIS starting and then doing nothing. That happens for a real
 * reason worth naming: unpacking a new download over a folder while JARVIS is
 * still running leaves the files Windows had locked behind, so main.js or
 * package.json can be missing or half-written. Check before launching.
 */
function checkDesktopApp(dir) {
  const manifest = join(dir, "package.json");
  let main = null;
  try {
    main = JSON.parse(readFileSync(manifest, "utf8")).main || "main.js";
  } catch {
    die(`The desktop app is incomplete: ${manifest} is missing or unreadable. This is what an unzip over a running JARVIS leaves behind. Quit JARVIS from the tray icon, unpack the download again, then run ${C.b}npm run setup${C.r}.`);
  }
  if (!existsSync(join(dir, main))) {
    die(`The desktop app is incomplete: ${join(dir, main)} is missing. Quit JARVIS from the tray icon, unpack the download again, then run ${C.b}npm run setup${C.r}.`);
  }
}

if (useDesktop) checkDesktopApp(join(ROOT, "desktop"));

if (useDesktop && detached) {
  // An absolute path, not ".": detached from a shortcut the working directory
  // is not something to rely on, and Electron with no app path opens its own
  // demo window instead of JARVIS.
  await launchDetached(electron, [join(ROOT, "desktop")], join(ROOT, "desktop"), "the desktop agent");
} else if (useDesktop) {
  const child = runAsync(electron, ["."], { cwd: join(ROOT, "desktop"), stdio: "inherit" });
  child.on("error", () => { startHeadless("Electron could not be launched."); });
  wire(child, true);
} else {
  startHeadless(null);
}
