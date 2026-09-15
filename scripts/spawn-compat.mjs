// Spawning npm and electron on Windows.
//
// Node refuses to spawn a .cmd/.bat file without a shell (the fix for
// CVE-2024-27980), but passing an args array *together with* shell:true is
// deprecated (DEP0190) precisely because Node then concatenates the arguments
// into the command line without escaping them.
//
// So on Windows we build the single command line ourselves and quote every
// argument. Everything passed through here is a literal written in this
// repository — never user input — and assertSafe() keeps it that way.
import { spawn, spawnSync } from "node:child_process";

export const WIN = process.platform === "win32";

const SAFE = /^[A-Za-z0-9_.:@+=/\\-]+$/;

function quote(arg) {
  const s = String(arg);
  if (SAFE.test(s)) return s;
  // A path with spaces is the only other shape we need (C:\Program Files\...).
  // Anything that could change the meaning of the command line is refused
  // rather than escaped, so a future edit cannot introduce an injection.
  if (/["`^&|<>()%!\r\n]/.test(s)) throw new Error(`refusing to pass an unsafe argument to the Windows shell: ${s}`);
  return `"${s}"`;
}

export function windowsCommandLine(cmd, args) {
  return [cmd, ...args].map(quote).join(" ");
}

/** spawnSync that never pairs an args array with shell:true. */
export function runSync(cmd, args = [], opts = {}) {
  if (!WIN) return spawnSync(cmd, args, opts);
  return spawnSync(windowsCommandLine(cmd, args), { ...opts, shell: true });
}

/** spawn that never pairs an args array with shell:true. */
export function runAsync(cmd, args = [], opts = {}) {
  if (!WIN) return spawn(cmd, args, opts);
  return spawn(windowsCommandLine(cmd, args), { ...opts, shell: true });
}
