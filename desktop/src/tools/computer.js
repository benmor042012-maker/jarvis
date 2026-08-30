const { exec, execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { WORKSPACE } = require("../config");

const IS_WIN = os.platform() === "win32";
const IS_MAC = os.platform() === "darwin";

function run(cmd, timeout = 10000) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.trim());
    });
  });
}

// --- App launching ---
async function open_app({ name }) {
  if (IS_WIN) {
    await run(`start "" "${name}"`);
  } else if (IS_MAC) {
    await run(`open -a "${name}"`);
  } else {
    await run(name);
  }
  return `Opened ${name}`;
}

async function open_url({ url }) {
  if (!/^https?:\/\//i.test(url)) throw new Error("Only http/https URLs allowed.");
  if (IS_WIN) await run(`start "" "${url}"`);
  else if (IS_MAC) await run(`open "${url}"`);
  else await run(`xdg-open "${url}"`);
  return `Opened ${url}`;
}

// --- Screenshot ---
async function take_screenshot() {
  const screenshotPath = path.join(WORKSPACE, "temp", `screenshot-${Date.now()}.png`);
  try {
    const screenshot = require("screenshot-desktop");
    const buf = await screenshot({ format: "png" });
    fs.writeFileSync(screenshotPath, buf);
  } catch {
    if (IS_WIN) {
      const ps = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::PrimaryScreen | ForEach-Object { $b = $_.Bounds; $bmp = New-Object System.Drawing.Bitmap($b.Width,$b.Height); $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); $bmp.Save('${screenshotPath.replace(/'/g, "''")}') }`;
      await run(`powershell -Command "${ps}"`, 15000);
    } else if (IS_MAC) {
      await run(`screencapture -x "${screenshotPath}"`);
    } else {
      await run(`import -window root "${screenshotPath}"`);
    }
  }
  return { path: screenshotPath, message: "Screenshot saved." };
}

// --- File operations (sandboxed) ---
function resolveSafe(filePath, allowOutside = false) {
  const resolved = path.resolve(filePath);
  const inWorkspace = resolved.startsWith(path.resolve(WORKSPACE));
  if (!inWorkspace && !allowOutside) throw new Error(`Access denied: path outside JARVIS workspace. Use ${WORKSPACE} or request permission for outside access.`);
  return resolved;
}

async function file_read({ path: filePath }) {
  const p = resolveSafe(filePath, true);
  return fs.readFileSync(p, "utf8").slice(0, 50000);
}

async function file_write({ path: filePath, content }) {
  const p = resolveSafe(filePath);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf8");
  return `Written to ${p}`;
}

async function file_list({ directory }) {
  const p = resolveSafe(directory || WORKSPACE, true);
  const entries = fs.readdirSync(p, { withFileTypes: true });
  return entries.map((e) => ({ name: e.name, type: e.isDirectory() ? "dir" : "file" }));
}

async function file_search({ query, directory }) {
  const dir = resolveSafe(directory || WORKSPACE, true);
  const results = [];
  function walk(d, depth = 0) {
    if (depth > 5 || results.length > 50) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.name.toLowerCase().includes(query.toLowerCase())) results.push(full);
      if (e.isDirectory() && !e.name.startsWith(".")) walk(full, depth + 1);
    }
  }
  walk(dir);
  return results.length ? results : "No files found.";
}

async function file_delete({ path: filePath }) {
  const p = resolveSafe(filePath);
  if (fs.statSync(p).isDirectory()) {
    fs.rmSync(p, { recursive: true });
  } else {
    fs.unlinkSync(p);
  }
  return `Deleted ${p}`;
}

// --- Shell command (high risk) ---
async function run_command({ command }) {
  const dangerous = /rm\s+-rf|format|del\s+\/|rmdir|shutdown|reboot|mkfs|dd\s+if/i;
  if (dangerous.test(command)) throw new Error("Dangerous command blocked.");
  const output = await run(command, 30000);
  return output.slice(0, 10000);
}

// --- Mouse/Keyboard (framework — needs optional nut-js) ---
async function mouse_click({ x, y, button }) {
  try {
    const { mouse, Button, Point } = require("@nut-tree/nut-js");
    await mouse.setPosition(new Point(x, y));
    await mouse.click(button === "right" ? Button.RIGHT : Button.LEFT);
    return `Clicked at (${x}, ${y})`;
  } catch {
    if (IS_WIN) {
      const ps = `Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class Mouse{[DllImport("user32.dll")]public static extern bool SetCursorPos(int x,int y);[DllImport("user32.dll")]public static extern void mouse_event(uint f,uint x,uint y,uint d,int e);}'; [Mouse]::SetCursorPos(${x},${y}); [Mouse]::mouse_event(0x0002,0,0,0,0); [Mouse]::mouse_event(0x0004,0,0,0,0)`;
      await run(`powershell -Command "${ps.replace(/"/g, '\\"')}"`);
      return `Clicked at (${x}, ${y})`;
    }
    throw new Error("Mouse control requires @nut-tree/nut-js: npm install @nut-tree/nut-js");
  }
}

async function keyboard_type({ text }) {
  try {
    const { keyboard } = require("@nut-tree/nut-js");
    await keyboard.type(text);
    return `Typed "${text.slice(0, 50)}"`;
  } catch {
    if (IS_WIN) {
      const escaped = text.replace(/'/g, "''");
      await run(`powershell -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${escaped}')"`);
      return `Typed "${text.slice(0, 50)}"`;
    }
    throw new Error("Keyboard control requires @nut-tree/nut-js: npm install @nut-tree/nut-js");
  }
}

const DEFS = [
  { name: "open_app", description: "Open an application by name", input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "open_url", description: "Open a URL in the default browser", input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
  { name: "take_screenshot", description: "Capture the current screen", input_schema: { type: "object", properties: {}, required: [] } },
  { name: "file_read", description: "Read a file's content", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "file_write", description: "Write content to a file (JARVIS workspace only)", input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "file_list", description: "List files in a directory", input_schema: { type: "object", properties: { directory: { type: "string" } }, required: [] } },
  { name: "file_search", description: "Search for files by name", input_schema: { type: "object", properties: { query: { type: "string" }, directory: { type: "string" } }, required: ["query"] } },
  { name: "file_delete", description: "Delete a file or directory (JARVIS workspace only)", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "run_command", description: "Run a shell command (high risk — requires approval)", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "mouse_click", description: "Click at screen coordinates", input_schema: { type: "object", properties: { x: { type: "integer" }, y: { type: "integer" }, button: { type: "string", enum: ["left", "right"], default: "left" } }, required: ["x", "y"] } },
  { name: "keyboard_type", description: "Type text using keyboard", input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
];

const RUNNERS = {
  open_app, open_url, take_screenshot,
  file_read, file_write, file_list, file_search, file_delete,
  run_command, mouse_click, keyboard_type,
};

const ACTION_TYPES = {
  open_app: "open_app",
  open_url: "open_url",
  take_screenshot: "read_screen",
  file_read: "file_read_workspace",
  file_write: "file_create_workspace",
  file_list: "file_list_workspace",
  file_search: "file_list_workspace",
  file_delete: "delete_file",
  run_command: "run_shell_command",
  mouse_click: "mouse_click",
  keyboard_type: "keyboard_type",
};

const UNDOABLE = new Set(["file_write", "file_delete"]);

module.exports = { DEFS, RUNNERS, ACTION_TYPES, UNDOABLE };
