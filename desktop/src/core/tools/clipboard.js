// Clipboard tools. Contents are never written to the audit log.
const os = require("os");
const procs = require("../procs");
const { runPS } = require("../ps");

const PLATFORM = os.platform();

async function readClip(signal) {
  if (PLATFORM === "win32") return runPS("Get-Clipboard -Raw", { signal });
  if (PLATFORM === "darwin") return (await procs.run("pbpaste", [], { signal })).stdout;
  for (const [bin, args] of [["xclip", ["-selection", "clipboard", "-o"]], ["xsel", ["--clipboard", "--output"]], ["wl-paste", []]]) {
    try { const r = await procs.run(bin, args, { signal, timeoutMs: 5000 }); if (r.code === 0) return r.stdout; } catch { /* next */ }
  }
  throw new Error("No clipboard tool found (xclip, xsel or wl-paste).");
}

async function writeClip(text, signal) {
  if (PLATFORM === "win32") return runPS("Set-Clipboard -Value $env:JARVIS_TEXT", { args: { text }, signal });
  if (PLATFORM === "darwin") return procs.run("pbcopy", [], { signal, input: text });
  for (const [bin, args] of [["xclip", ["-selection", "clipboard"]], ["xsel", ["--clipboard", "--input"]], ["wl-copy", []]]) {
    try { const r = await procs.run(bin, args, { signal, timeoutMs: 5000, input: text }); if (r.code === 0) return; } catch { /* next */ }
  }
  throw new Error("No clipboard tool found (xclip, xsel or wl-copy).");
}

const clipboard_read = {
  name: "clipboard_read", title: "Read clipboard", category: "clipboard", risk: "medium", reversible: true, timeoutMs: 10000,
  description: "Read the clipboard text. Contents are shown to you only; they are not logged.",
  schema: { type: "object", properties: {} },
  redact: () => ({}),
  async run(_p, { signal }) {
    const text = (await readClip(signal)) || "";
    return { ok: true, summary: text ? `Clipboard has ${text.length} characters` : "Clipboard is empty", data: { content: text.slice(0, 20000), sensitive: true } };
  },
};

const clipboard_write = {
  name: "clipboard_write", title: "Copy to clipboard", category: "clipboard", risk: "low", reversible: true, timeoutMs: 10000,
  description: "Put text on the clipboard.",
  schema: { type: "object", properties: { text: { type: "string", maxLength: 100000 } }, required: ["text"] },
  describe: (p) => `Copy ${p.text.length} characters to the clipboard`,
  redact: (p) => ({ chars: p.text.length }),
  async run({ text }, { signal }) {
    await writeClip(text, signal);
    return `Copied ${text.length} characters`;
  },
};

module.exports = { tools: [clipboard_read, clipboard_write], readClip, writeClip };
