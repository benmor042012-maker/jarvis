#!/usr/bin/env node
// Set up the local AI brain — free, open source, and entirely on this computer.
//
//   npm run ai
//
// JARVIS works without it (deterministic rule planner, shown as MOCK MODE).
// A local model is what lets you phrase things freely instead of using set
// commands. Nothing here needs an account, a key or a payment, and no prompt
// ever leaves the machine.
import fs from "node:fs";
import { createInterface } from "node:readline/promises";
import os from "node:os";
import path from "node:path";

import { runSync, WIN } from "./spawn-compat.mjs";

const C = { r: "\x1b[0m", b: "\x1b[1m", dim: "\x1b[2m", g: "\x1b[32m", y: "\x1b[33m", red: "\x1b[31m", c: "\x1b[36m" };
const say = (m) => { console.log(`${C.c}▸${C.r} ${m}`); };
const ok = (m) => { console.log(`${C.g}✔${C.r} ${m}`); };
const warn = (m) => { console.log(`${C.y}!${C.r} ${m}`); };
const bad = (m) => { console.log(`${C.red}✕${C.r} ${m}`); };

const OLLAMA_URL = process.env.JARVIS_OLLAMA_URL ?? "http://127.0.0.1:11434";
const GB = 1024 ** 3;

// Bigger models understand Hebrew and free phrasing much better, but they need
// the RAM to run. Sizes are the download; the model also needs about that much
// memory while answering.
const MODELS = [
  { id: "qwen2.5:7b", size: "4.7 GB", needsGb: 16, why: "best Hebrew of the three, Apache-2.0 licence" },
  { id: "llama3.1:8b", size: "4.7 GB", needsGb: 16, why: "strong general model, Llama Community Licence" },
  { id: "llama3.2:3b", size: "2.0 GB", needsGb: 8, why: "small and fast; Hebrew is weaker but usable" },
];

async function reachable(url, ms = 2500) {
  const ctrl = new AbortController();
  const t = setTimeout(() => { ctrl.abort(); }, ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function have(cmd) {
  const r = runSync(cmd, ["--version"], { stdio: "ignore" });
  return r.status === 0;
}

/**
 * Where Ollama really is.
 *
 * The Windows installer puts it in the user's own programs folder and adds it
 * to PATH — but PATH is read when a terminal opens, so the window that ran the
 * installer, and any window opened before it finished, will never see it.
 * Worse, winget refuses to run at all while an installed Ollama is running
 * ("0x80070020: the file is being used by another process"), so the installer
 * appears to fail on a machine where it is already there. The result is a loop:
 * install, "not on PATH", install again, refused.
 *
 * So look for the program itself, not only for the name.
 */
function ollamaBinary() {
  if (have("ollama")) return "ollama";
  const home = os.homedir();
  const candidates = WIN
    ? [
        path.join(process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "Programs", "Ollama", "ollama.exe"),
        path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Ollama", "ollama.exe"),
        path.join(home, "AppData", "Local", "Ollama", "ollama.exe"),
      ]
    : ["/usr/local/bin/ollama", "/opt/homebrew/bin/ollama", "/usr/bin/ollama", path.join(home, ".local", "bin", "ollama")];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && runSync(c, ["--version"], { stdio: "ignore" }).status === 0) return c;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

function ask(rl, q) {
  return process.stdin.isTTY ? rl.question(q) : Promise.resolve("n");
}

const ramGb = Math.round(os.totalmem() / GB);
console.log(`\n${C.b}JARVIS — local AI setup${C.r} ${C.dim}(free, open source, offline after the download)${C.r}`);
console.log(`${C.dim}This computer has about ${String(ramGb)} GB of RAM.${C.r}\n`);

const rl = createInterface({ input: process.stdin, output: process.stdout });

try {
  // 1. Is Ollama installed?
  let ollama = ollamaBinary();
  if (!ollama) {
    warn("Ollama is not installed. It is the free, open-source runner for local models.");
    if (WIN && have("winget")) {
      const a = await ask(rl, `Install it now with winget? ${C.dim}(about 700 MB, no account needed)${C.r} [y/N] `);
      if (a.trim().toLowerCase().startsWith("y")) {
        say("Installing Ollama…");
        runSync("winget", ["install", "--id", "Ollama.Ollama", "-e", "--accept-package-agreements", "--accept-source-agreements"], { stdio: "inherit" });
        // Look for the program, not for the name: PATH in this window was read
        // before the installer ran, and winget refuses outright when an already
        // installed Ollama is running.
        ollama = ollamaBinary();
        if (!ollama) {
          warn("Installed, but this window cannot see it yet. Close this terminal, open a new one, and run `npm run ai` again.");
          process.exit(0);
        }
        ok(`Ollama installed: ${ollama}`);
      } else {
        console.log(`\n  Install it yourself from ${C.c}https://ollama.com/download${C.r}, then run ${C.b}npm run ai${C.r} again.\n`);
        process.exit(0);
      }
    } else {
      console.log(`\n  Download it from ${C.c}https://ollama.com/download${C.r}`);
      if (process.platform === "linux") console.log(`  or on Linux:   ${C.dim}curl -fsSL https://ollama.com/install.sh | sh${C.r}  ${C.dim}(read the script first if you prefer)${C.r}`);
      if (process.platform === "darwin" && have("brew")) console.log(`  or on macOS:   ${C.dim}brew install ollama${C.r}`);
      console.log(`\n  Then run ${C.b}npm run ai${C.r} again.\n`);
      process.exit(0);
    }
  } else {
    ok(`Ollama is installed: ${ollama}`);
  }

  // 2. Is it running?
  let tags = await reachable(`${OLLAMA_URL}/api/tags`);
  if (!tags) {
    warn("Ollama is installed but not answering yet.");
    console.log(`  Start it: ${C.b}ollama serve${C.r} in another window${C.dim} (on Windows it usually starts on its own — look for the llama icon near the clock)${C.r}`);
    const a = await ask(rl, "Wait 10 seconds and check again? [Y/n] ");
    if (!a.trim().toLowerCase().startsWith("n")) {
      await new Promise((r) => setTimeout(r, 10000));
      tags = await reachable(`${OLLAMA_URL}/api/tags`);
    }
    if (!tags) {
      bad(`Still no answer on ${OLLAMA_URL}. Start Ollama, then run \`npm run ai\` again.`);
      process.exit(1);
    }
  }
  ok(`Ollama is running on ${OLLAMA_URL}`);

  // 3. Is a model installed?
  const installed = (tags.models ?? []).map((m) => m.name);
  if (installed.length) {
    ok(`Models already installed: ${installed.join(", ")}`);
    console.log(`\n  JARVIS picks one automatically. To choose a specific one, put its name in ${C.b}Settings → Local AI → Model${C.r}.\n`);
    const a = await ask(rl, "Download another model anyway? [y/N] ");
    if (!a.trim().toLowerCase().startsWith("y")) {
      console.log(`\n${C.g}${C.b}Nothing else to do.${C.r} Start JARVIS with ${C.c}npm start${C.r} — the status panel will show the active model.\n`);
      process.exit(0);
    }
  } else {
    warn("No model is installed yet, so JARVIS is using the rule planner (MOCK MODE).");
  }

  // 4. Recommend by RAM and pull.
  const fits = MODELS.filter((m) => ramGb >= m.needsGb);
  const choices = fits.length ? fits : [MODELS[MODELS.length - 1]];
  console.log(`\n${C.b}Models that suit ${String(ramGb)} GB of RAM:${C.r}`);
  choices.forEach((m, i) => { console.log(`  ${String(i + 1)}. ${C.b}${m.id}${C.r}  ${C.dim}${m.size} — ${m.why}${C.r}`); });
  if (!fits.length) warn(`${String(ramGb)} GB is tight for a local model; the small one may be slow. JARVIS keeps working without one.`);

  const pick = (await ask(rl, `\nWhich one? [1-${String(choices.length)}, or Enter for 1, or n to skip] `)).trim().toLowerCase();
  if (pick === "n") {
    console.log(`\nSkipped. JARVIS keeps working with the rule planner and will say ${C.b}MOCK MODE${C.r} so you always know.\n`);
    process.exit(0);
  }
  const chosen = choices[(Number(pick) || 1) - 1] ?? choices[0];
  say(`Downloading ${chosen.id} (${chosen.size}). This is the only big download, and it is free.`);
  const pull = runSync(ollama, ["pull", chosen.id], { stdio: "inherit" });
  if (pull.status !== 0) {
    bad(`The download failed. Check your internet connection and run \`npm run ai\` again.`);
    process.exit(1);
  }
  ok(`${chosen.id} is ready.`);

  const show = runSync(ollama, ["show", chosen.id], { encoding: "utf8" });
  const licence = /License\s*\n?\s*(.+)/i.exec(show.stdout ?? "");
  if (licence) console.log(`${C.dim}  Licence as reported by Ollama: ${licence[1].trim().slice(0, 80)} — read it before commercial use.${C.r}`);

  console.log(`\n${C.g}${C.b}Done.${C.r} Start JARVIS with ${C.c}npm start${C.r}.`);
  console.log(`${C.dim}The status panel should now show "${chosen.id}" instead of MOCK MODE, and you can phrase requests freely.${C.r}\n`);
} finally {
  rl.close();
}
