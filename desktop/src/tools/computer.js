const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { WORKSPACE } = require("../config");
const { runPS, escapePS, USER32_TYPE, IS_WIN } = require("./powershell");

const IS_MAC = os.platform() === "darwin";

function run(cmd, timeout = 10000) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.trim());
    });
  });
}

function int(v, name) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number.`);
  return Math.round(n);
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

// --- Screen ---
async function screen_info() {
  if (!IS_WIN) {
    return { primary: { width: 1920, height: 1080 }, note: "Non-Windows fallback estimate." };
  }
  const script = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::AllScreens | ForEach-Object { [PSCustomObject]@{ name=$_.DeviceName; primary=$_.Primary; x=$_.Bounds.X; y=$_.Bounds.Y; width=$_.Bounds.Width; height=$_.Bounds.Height } } | ConvertTo-Json -Compress`;
  const out = await runPS(script);
  let screens;
  try { screens = JSON.parse(out); } catch { return { raw: out }; }
  if (!Array.isArray(screens)) screens = [screens];
  return { screens, count: screens.length };
}

async function take_screenshot() {
  const dir = path.join(WORKSPACE, "temp");
  fs.mkdirSync(dir, { recursive: true });
  const screenshotPath = path.join(dir, `screenshot-${Date.now()}.png`);
  try {
    const screenshot = require("screenshot-desktop");
    const buf = await screenshot({ format: "png" });
    fs.writeFileSync(screenshotPath, buf);
  } catch {
    if (IS_WIN) {
      const p = escapePS(screenshotPath);
      const script = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b = [System.Windows.Forms.SystemInformation]::VirtualScreen; $bmp = New-Object System.Drawing.Bitmap($b.Width,$b.Height); $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); $bmp.Save('${p}',[System.Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $bmp.Dispose()`;
      await runPS(script, 20000);
    } else if (IS_MAC) {
      await run(`screencapture -x "${screenshotPath}"`);
    } else {
      await run(`import -window root "${screenshotPath}"`);
    }
  }
  const buf = fs.readFileSync(screenshotPath);
  cleanupOldScreenshots(dir);
  return {
    path: screenshotPath,
    base64: buf.toString("base64"),
    media_type: "image/png",
    bytes: buf.length,
  };
}

function cleanupOldScreenshots(dir) {
  try {
    const files = fs.readdirSync(dir)
      .filter((f) => f.startsWith("screenshot-") && f.endsWith(".png"))
      .map((f) => ({ f, t: Number(f.slice(11, -4)) || 0 }))
      .sort((a, b) => b.t - a.t);
    for (const { f } of files.slice(20)) {
      try { fs.unlinkSync(path.join(dir, f)); } catch {}
    }
  } catch {}
}

// --- Mouse ---
const MOUSE_FLAGS = {
  leftDown: 0x0002, leftUp: 0x0004,
  rightDown: 0x0008, rightUp: 0x0010,
  middleDown: 0x0020, middleUp: 0x0040,
  wheel: 0x0800,
};

async function mouse_move({ x, y }) {
  const px = int(x, "x"), py = int(y, "y");
  await runPS(`${USER32_TYPE}; [WinAPI]::SetCursorPos(${px},${py}) | Out-Null`);
  return `Cursor moved to (${px}, ${py})`;
}

async function mouse_click({ x, y, button = "left", click_type = "single" }) {
  const btn = button === "right" ? "right" : button === "middle" ? "middle" : "left";
  const down = MOUSE_FLAGS[`${btn}Down`];
  const up = MOUSE_FLAGS[`${btn}Up`];
  const parts = [USER32_TYPE];
  if (x !== undefined && y !== undefined) {
    parts.push(`[WinAPI]::SetCursorPos(${int(x, "x")},${int(y, "y")}) | Out-Null`, `Start-Sleep -Milliseconds 60`);
  }
  const times = click_type === "double" ? 2 : 1;
  for (let i = 0; i < times; i++) {
    parts.push(`[WinAPI]::mouse_event(${down},0,0,0,[IntPtr]::Zero)`);
    parts.push(`[WinAPI]::mouse_event(${up},0,0,0,[IntPtr]::Zero)`);
    if (i < times - 1) parts.push(`Start-Sleep -Milliseconds 40`);
  }
  await runPS(parts.join("; "));
  const where = x !== undefined ? ` at (${int(x, "x")}, ${int(y, "y")})` : " at current position";
  return `${click_type === "double" ? "Double-clicked" : "Clicked"} ${btn}${where}`;
}

async function mouse_scroll({ x, y, direction = "down", amount = 3 }) {
  const clicks = Math.min(20, Math.max(1, int(amount, "amount")));
  const delta = (direction === "up" ? 120 : -120) * clicks;
  const parts = [USER32_TYPE];
  if (x !== undefined && y !== undefined) {
    parts.push(`[WinAPI]::SetCursorPos(${int(x, "x")},${int(y, "y")}) | Out-Null`, `Start-Sleep -Milliseconds 60`);
  }
  parts.push(`[WinAPI]::mouse_event(${MOUSE_FLAGS.wheel},0,0,${delta},[IntPtr]::Zero)`);
  await runPS(parts.join("; "));
  return `Scrolled ${direction} ${clicks} notch(es)`;
}

async function mouse_drag({ from_x, from_y, to_x, to_y }) {
  const fx = int(from_x, "from_x"), fy = int(from_y, "from_y");
  const tx = int(to_x, "to_x"), ty = int(to_y, "to_y");
  const steps = 12;
  const parts = [USER32_TYPE, `[WinAPI]::SetCursorPos(${fx},${fy}) | Out-Null`, `Start-Sleep -Milliseconds 80`,
    `[WinAPI]::mouse_event(${MOUSE_FLAGS.leftDown},0,0,0,[IntPtr]::Zero)`, `Start-Sleep -Milliseconds 80`];
  for (let i = 1; i <= steps; i++) {
    const ix = Math.round(fx + ((tx - fx) * i) / steps);
    const iy = Math.round(fy + ((ty - fy) * i) / steps);
    parts.push(`[WinAPI]::SetCursorPos(${ix},${iy}) | Out-Null`, `Start-Sleep -Milliseconds 20`);
  }
  parts.push(`Start-Sleep -Milliseconds 80`, `[WinAPI]::mouse_event(${MOUSE_FLAGS.leftUp},0,0,0,[IntPtr]::Zero)`);
  await runPS(parts.join("; "), 20000);
  return `Dragged from (${fx}, ${fy}) to (${tx}, ${ty})`;
}

// --- Keyboard ---
const VK = {
  ctrl: 0x11, control: 0x11, alt: 0x12, shift: 0x10, win: 0x5b, windows: 0x5b, meta: 0x5b,
  tab: 0x09, enter: 0x0d, return: 0x0d, esc: 0x1b, escape: 0x1b, space: 0x20,
  backspace: 0x08, delete: 0x2e, del: 0x2e, insert: 0x2d,
  home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22,
  up: 0x26, down: 0x28, left: 0x25, right: 0x27,
  capslock: 0x14, printscreen: 0x2c,
  ";": 0xba, "=": 0xbb, ",": 0xbc, "-": 0xbd, ".": 0xbe, "/": 0xbf,
  "`": 0xc0, "[": 0xdb, "\\": 0xdc, "]": 0xdd, "'": 0xde,
};
for (let i = 1; i <= 12; i++) VK[`f${i}`] = 0x6f + i;
for (let i = 0; i <= 9; i++) VK[String(i)] = 0x30 + i;
for (let i = 0; i < 26; i++) VK[String.fromCharCode(97 + i)] = 0x41 + i;

const EXTENDED_KEYS = new Set([0x5b, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2d, 0x2e, 0x2c]);

async function keyboard_combo({ keys }) {
  const list = Array.isArray(keys) ? keys : String(keys).split("+");
  const codes = list.map((k) => {
    const key = String(k).trim().toLowerCase();
    const code = VK[key];
    if (code === undefined) throw new Error(`Unknown key: "${k}". Supported: ctrl, alt, shift, win, tab, enter, esc, space, backspace, delete, arrows, home, end, pageup, pagedown, f1-f12, a-z, 0-9.`);
    return code;
  });
  if (!codes.length) throw new Error("No keys given.");
  const parts = [USER32_TYPE];
  const flag = (c) => (EXTENDED_KEYS.has(c) ? 0x0001 : 0x0000);
  for (const c of codes) parts.push(`[WinAPI]::keybd_event(${c},0,${flag(c)},[IntPtr]::Zero)`);
  parts.push(`Start-Sleep -Milliseconds 40`);
  for (const c of [...codes].reverse()) parts.push(`[WinAPI]::keybd_event(${c},0,${flag(c) | 0x0002},[IntPtr]::Zero)`);
  await runPS(parts.join("; "));
  return `Pressed ${list.join("+")}`;
}

const SENDKEYS_SPECIAL = /[+^%~(){}[\]]/g;

function escapeSendKeys(text) {
  return text.replace(SENDKEYS_SPECIAL, (c) => `{${c}}`);
}

async function keyboard_type({ text, method = "auto" }) {
  if (typeof text !== "string") throw new Error("text must be a string.");
  const nonAscii = /[^\x00-\x7F]/.test(text);
  const useClipboard = method === "clipboard" || (method === "auto" && nonAscii);

  if (useClipboard) {
    // SendKeys mangles non-ASCII (Hebrew). Paste via clipboard, then restore it.
    const script = [
      USER32_TYPE,
      `Add-Type -AssemblyName System.Windows.Forms`,
      `$prev = Get-Clipboard -Raw -ErrorAction SilentlyContinue`,
      `Set-Clipboard -Value '${escapePS(text)}'`,
      `Start-Sleep -Milliseconds 80`,
      `[WinAPI]::keybd_event(0x11,0,0,[IntPtr]::Zero)`,
      `[WinAPI]::keybd_event(0x56,0,0,[IntPtr]::Zero)`,
      `Start-Sleep -Milliseconds 40`,
      `[WinAPI]::keybd_event(0x56,0,2,[IntPtr]::Zero)`,
      `[WinAPI]::keybd_event(0x11,0,2,[IntPtr]::Zero)`,
      `Start-Sleep -Milliseconds 200`,
      `if ($null -ne $prev) { Set-Clipboard -Value $prev } else { Set-Clipboard -Value '' }`,
    ].join("; ");
    await runPS(script, 20000);
    return `Typed ${text.length} chars (clipboard paste)`;
  }

  const script = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${escapePS(escapeSendKeys(text))}')`;
  await runPS(script, 20000);
  return `Typed ${text.length} chars`;
}

// --- Clipboard ---
async function clipboard_read() {
  const out = await runPS(`Get-Clipboard -Raw`);
  return out.slice(0, 20000) || "(clipboard is empty)";
}

async function clipboard_write({ text }) {
  if (typeof text !== "string") throw new Error("text must be a string.");
  await runPS(`Set-Clipboard -Value '${escapePS(text)}'`);
  return `Copied ${text.length} chars to clipboard`;
}

// --- Windows ---
const SW = { hide: 0, normal: 1, minimized: 2, maximized: 3, restore: 9 };

async function window_list() {
  const script = `${USER32_TYPE}; Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -ne '' } | ForEach-Object { $r = New-Object WinAPI+RECT; [WinAPI]::GetWindowRect($_.MainWindowHandle,[ref]$r) | Out-Null; [PSCustomObject]@{ pid=$_.Id; name=$_.ProcessName; title=$_.MainWindowTitle; x=$r.Left; y=$r.Top; width=($r.Right-$r.Left); height=($r.Bottom-$r.Top) } } | ConvertTo-Json -Compress`;
  const out = await runPS(script, 15000);
  if (!out) return [];
  try {
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return { raw: out.slice(0, 5000) };
  }
}

function windowSelector({ title, pid }) {
  if (pid !== undefined && pid !== null && pid !== "") {
    return `$p = Get-Process -Id ${int(pid, "pid")} -ErrorAction Stop`;
  }
  if (!title) throw new Error("Provide either title or pid.");
  return `$p = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like '*${escapePS(title)}*' } | Select-Object -First 1; if (-not $p) { throw 'Window not found: ${escapePS(title)}' }`;
}

async function window_focus(args) {
  const script = `${USER32_TYPE}; ${windowSelector(args)}; [WinAPI]::ShowWindow($p.MainWindowHandle,${SW.restore}) | Out-Null; Start-Sleep -Milliseconds 60; [WinAPI]::SetForegroundWindow($p.MainWindowHandle) | Out-Null; Write-Output $p.MainWindowTitle`;
  const title = await runPS(script, 15000);
  return `Focused window: ${title}`;
}

async function window_minimize(args) {
  const script = `${USER32_TYPE}; ${windowSelector(args)}; [WinAPI]::ShowWindow($p.MainWindowHandle,${SW.minimized}) | Out-Null; Write-Output $p.MainWindowTitle`;
  const title = await runPS(script, 15000);
  return `Minimized: ${title}`;
}

async function window_maximize(args) {
  const script = `${USER32_TYPE}; ${windowSelector(args)}; [WinAPI]::ShowWindow($p.MainWindowHandle,${SW.maximized}) | Out-Null; Write-Output $p.MainWindowTitle`;
  const title = await runPS(script, 15000);
  return `Maximized: ${title}`;
}

async function window_resize(args) {
  const { x, y, width, height } = args;
  const script = `${USER32_TYPE}; ${windowSelector(args)}; [WinAPI]::ShowWindow($p.MainWindowHandle,${SW.restore}) | Out-Null; [WinAPI]::MoveWindow($p.MainWindowHandle,${int(x, "x")},${int(y, "y")},${int(width, "width")},${int(height, "height")},$true) | Out-Null; Write-Output $p.MainWindowTitle`;
  const title = await runPS(script, 15000);
  return `Resized ${title} to ${int(width, "width")}x${int(height, "height")} at (${int(x, "x")}, ${int(y, "y")})`;
}

async function window_close(args) {
  const script = `${USER32_TYPE}; ${windowSelector(args)}; $t = $p.MainWindowTitle; [WinAPI]::PostMessage($p.MainWindowHandle,0x0010,[IntPtr]::Zero,[IntPtr]::Zero) | Out-Null; Write-Output $t`;
  const title = await runPS(script, 15000);
  return `Sent close request to: ${title}`;
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
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
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

const DEFS = [
  { name: "open_app", description: "Open an application by name (e.g. notepad, chrome, calc)", input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "open_url", description: "Open a URL in the default browser", input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
  { name: "screen_info", description: "Get screen resolution and monitor layout. Call this before any visual task so you know the coordinate space.", input_schema: { type: "object", properties: {}, required: [] } },
  { name: "take_screenshot", description: "Capture the screen and SEE it. Use this to look at the screen before clicking and to verify each action worked.", input_schema: { type: "object", properties: {}, required: [] } },

  { name: "mouse_move", description: "Move the mouse cursor to screen coordinates without clicking", input_schema: { type: "object", properties: { x: { type: "integer" }, y: { type: "integer" } }, required: ["x", "y"] } },
  { name: "mouse_click", description: "Click at screen coordinates. Aim at the CENTER of the target element.", input_schema: { type: "object", properties: { x: { type: "integer" }, y: { type: "integer" }, button: { type: "string", enum: ["left", "right", "middle"] }, click_type: { type: "string", enum: ["single", "double"] } }, required: [] } },
  { name: "mouse_scroll", description: "Scroll the mouse wheel, optionally at given coordinates", input_schema: { type: "object", properties: { x: { type: "integer" }, y: { type: "integer" }, direction: { type: "string", enum: ["up", "down"] }, amount: { type: "integer", description: "Number of wheel notches, 1-20" } }, required: [] } },
  { name: "mouse_drag", description: "Drag from one point to another with the left button held", input_schema: { type: "object", properties: { from_x: { type: "integer" }, from_y: { type: "integer" }, to_x: { type: "integer" }, to_y: { type: "integer" } }, required: ["from_x", "from_y", "to_x", "to_y"] } },

  { name: "keyboard_type", description: "Type text at the current focus. Handles Hebrew and other non-ASCII text automatically.", input_schema: { type: "object", properties: { text: { type: "string" }, method: { type: "string", enum: ["auto", "sendkeys", "clipboard"] } }, required: ["text"] } },
  { name: "keyboard_combo", description: "Press a key combination, e.g. [\"ctrl\",\"c\"], [\"alt\",\"tab\"], [\"win\",\"r\"], [\"enter\"]. Prefer keyboard shortcuts over clicking when possible.", input_schema: { type: "object", properties: { keys: { type: "array", items: { type: "string" } } }, required: ["keys"] } },

  { name: "clipboard_read", description: "Read the current clipboard text", input_schema: { type: "object", properties: {}, required: [] } },
  { name: "clipboard_write", description: "Put text on the clipboard", input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },

  { name: "window_list", description: "List all open windows with their pid, process name, title, position and size", input_schema: { type: "object", properties: {}, required: [] } },
  { name: "window_focus", description: "Bring a window to the front by title (partial match) or pid", input_schema: { type: "object", properties: { title: { type: "string" }, pid: { type: "integer" } }, required: [] } },
  { name: "window_minimize", description: "Minimize a window by title or pid", input_schema: { type: "object", properties: { title: { type: "string" }, pid: { type: "integer" } }, required: [] } },
  { name: "window_maximize", description: "Maximize a window by title or pid", input_schema: { type: "object", properties: { title: { type: "string" }, pid: { type: "integer" } }, required: [] } },
  { name: "window_resize", description: "Move and resize a window by title or pid", input_schema: { type: "object", properties: { title: { type: "string" }, pid: { type: "integer" }, x: { type: "integer" }, y: { type: "integer" }, width: { type: "integer" }, height: { type: "integer" } }, required: ["x", "y", "width", "height"] } },
  { name: "window_close", description: "Politely close a window by title or pid (sends WM_CLOSE, app may prompt to save)", input_schema: { type: "object", properties: { title: { type: "string" }, pid: { type: "integer" } }, required: [] } },

  { name: "file_read", description: "Read a file's content", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "file_write", description: "Write content to a file (JARVIS workspace only)", input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "file_list", description: "List files in a directory", input_schema: { type: "object", properties: { directory: { type: "string" } }, required: [] } },
  { name: "file_search", description: "Search for files by name", input_schema: { type: "object", properties: { query: { type: "string" }, directory: { type: "string" } }, required: ["query"] } },
  { name: "file_delete", description: "Delete a file or directory (JARVIS workspace only)", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "run_command", description: "Run a shell command (high risk — always requires explicit approval)", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
];

const RUNNERS = {
  open_app, open_url, screen_info, take_screenshot,
  mouse_move, mouse_click, mouse_scroll, mouse_drag,
  keyboard_type, keyboard_combo,
  clipboard_read, clipboard_write,
  window_list, window_focus, window_minimize, window_maximize, window_resize, window_close,
  file_read, file_write, file_list, file_search, file_delete,
  run_command,
};

const ACTION_TYPES = {
  open_app: "open_app",
  open_url: "open_url",
  screen_info: "screen_info",
  take_screenshot: "read_screen",

  mouse_move: "mouse_move",
  mouse_click: "mouse_click",
  mouse_scroll: "mouse_scroll",
  mouse_drag: "mouse_drag",

  keyboard_type: "keyboard_type",
  keyboard_combo: "keyboard_combo",

  clipboard_read: "clipboard_read",
  clipboard_write: "clipboard_write",

  window_list: "window_list",
  window_focus: "window_focus",
  window_minimize: "window_minimize",
  window_maximize: "window_maximize",
  window_resize: "window_resize",
  window_close: "window_close",

  file_read: "file_read_workspace",
  file_write: "file_create_workspace",
  file_list: "file_list_workspace",
  file_search: "file_list_workspace",
  file_delete: "delete_file",
  run_command: "run_shell_command",
};

const UNDOABLE = new Set(["file_write", "file_delete"]);

module.exports = { DEFS, RUNNERS, ACTION_TYPES, UNDOABLE };
