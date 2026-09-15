// Shell tools. Always high risk: explicit approval plus a second confirmation
// on the computer. Commands are argv arrays run without a shell; PowerShell
// scripts run as-is (that is the point) but only after the user has read them.
const os = require("os");
const procs = require("../procs");
const { runPS } = require("../ps");
const { resolveApproved } = require("./files");

const run_command = {
  name: "run_command", title: "Run program", category: "shell", risk: "high", reversible: false, timeoutMs: 120000,
  description: "Run a program with an argument list (no shell). Working directory must be an approved folder.",
  schema: { type: "object", properties: { program: { type: "string", minLength: 1, maxLength: 512 }, args: { type: "array", items: { type: "string", maxLength: 4096 }, maxItems: 64, default: [] }, cwd: { type: "string", maxLength: 1024, default: "" }, timeout_seconds: { type: "integer", minimum: 1, maximum: 600, default: 60 } }, required: ["program"] },
  describe: (p) => `Run ${p.program} ${(p.args || []).join(" ")}`.trim(),
  async run({ program, args, cwd, timeout_seconds }, { cfg, signal }) {
    const dir = resolveApproved(cfg, cwd || require("../paths").WORKSPACE, { mustExist: true });
    const res = await procs.run(program, args, { cwd: dir, timeoutMs: timeout_seconds * 1000, signal });
    const out = (res.stdout + (res.stderr ? "\n" + res.stderr : "")).slice(0, 20000);
    if (res.cancelled) return { ok: false, summary: "cancelled", data: { cancelled: true } };
    if (res.timedOut) return { ok: false, summary: `timed out after ${timeout_seconds}s`, data: { output: out, timed_out: true } };
    return { ok: res.code === 0, summary: `exit code ${res.code}`, data: { code: res.code, output: out } };
  },
};

const run_powershell = {
  name: "run_powershell", title: "Run PowerShell script", category: "shell", risk: "high", reversible: false, timeoutMs: 120000, platforms: ["win32"],
  description: "Run a PowerShell script exactly as shown in the approval dialog.",
  schema: { type: "object", properties: { script: { type: "string", minLength: 1, maxLength: 20000 }, timeout_seconds: { type: "integer", minimum: 1, maximum: 600, default: 60 } }, required: ["script"] },
  describe: (p) => `PowerShell: ${p.script.slice(0, 80)}${p.script.length > 80 ? "…" : ""}`,
  async run({ script, timeout_seconds }, { signal }) {
    const out = await runPS(script, { timeoutMs: timeout_seconds * 1000, signal });
    return { ok: true, summary: out ? out.slice(0, 200) : "completed (no output)", data: { output: out.slice(0, 20000) } };
  },
};

module.exports = { tools: [run_command, run_powershell], platform: os.platform() };
