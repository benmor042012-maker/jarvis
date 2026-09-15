// Mouse and keyboard input (Windows, user32). Every call is medium risk and
// therefore visible: the UI shows it and asks unless the task was approved.
const { runPS, USER32 } = require("../ps");

const FLAGS = { leftDown: 0x0002, leftUp: 0x0004, rightDown: 0x0008, rightUp: 0x0010, middleDown: 0x0020, middleUp: 0x0040, wheel: 0x0800 };
const XY = { x: { type: "integer", minimum: -32768, maximum: 32767 }, y: { type: "integer", minimum: -32768, maximum: 32767 } };

const mouse_move = {
  name: "mouse_move", title: "Move mouse", category: "input", risk: "low", reversible: true, timeoutMs: 10000, platforms: ["win32"],
  description: "Move the mouse cursor to screen coordinates.",
  schema: { type: "object", properties: XY, required: ["x", "y"] },
  describe: (p) => `Move mouse to (${p.x}, ${p.y})`,
  async run({ x, y }, { signal }) {
    await runPS(`${USER32}; [WinAPI]::SetCursorPos(${x},${y}) | Out-Null`, { signal });
    return `Cursor at (${x}, ${y})`;
  },
};

const mouse_click = {
  name: "mouse_click", title: "Mouse click", category: "input", risk: "medium", reversible: false, timeoutMs: 10000, platforms: ["win32"],
  description: "Click at screen coordinates (or at the current position).",
  schema: { type: "object", properties: { ...XY, button: { type: "string", enum: ["left", "right", "middle"], default: "left" }, double: { type: "boolean", default: false } } },
  describe: (p) => `${p.double ? "Double-click" : "Click"} ${p.button || "left"}${p.x !== undefined ? ` at (${p.x}, ${p.y})` : ""}`,
  async run({ x, y, button, double }, { signal }) {
    const parts = [USER32];
    if (x !== undefined && y !== undefined) parts.push(`[WinAPI]::SetCursorPos(${x},${y}) | Out-Null`, "Start-Sleep -Milliseconds 60");
    const times = double ? 2 : 1;
    for (let i = 0; i < times; i++) {
      parts.push(`[WinAPI]::mouse_event(${FLAGS[`${button}Down`]},0,0,0,[IntPtr]::Zero)`, `[WinAPI]::mouse_event(${FLAGS[`${button}Up`]},0,0,0,[IntPtr]::Zero)`);
      if (i < times - 1) parts.push("Start-Sleep -Milliseconds 40");
    }
    await runPS(parts.join("; "), { signal });
    return `${double ? "Double-clicked" : "Clicked"} ${button}${x !== undefined ? ` at (${x}, ${y})` : ""}`;
  },
};

const mouse_scroll = {
  name: "mouse_scroll", title: "Scroll", category: "input", risk: "low", reversible: true, timeoutMs: 10000, platforms: ["win32"],
  description: "Scroll the mouse wheel.",
  schema: { type: "object", properties: { ...XY, direction: { type: "string", enum: ["up", "down"], default: "down" }, amount: { type: "integer", minimum: 1, maximum: 20, default: 3 } } },
  describe: (p) => `Scroll ${p.direction || "down"} ${p.amount || 3}`,
  async run({ x, y, direction, amount }, { signal }) {
    const parts = [USER32];
    if (x !== undefined && y !== undefined) parts.push(`[WinAPI]::SetCursorPos(${x},${y}) | Out-Null`, "Start-Sleep -Milliseconds 60");
    parts.push(`[WinAPI]::mouse_event(${FLAGS.wheel},0,0,${(direction === "up" ? 120 : -120) * amount},[IntPtr]::Zero)`);
    await runPS(parts.join("; "), { signal });
    return `Scrolled ${direction} ${amount}`;
  },
};

const mouse_drag = {
  name: "mouse_drag", title: "Drag", category: "input", risk: "medium", reversible: false, timeoutMs: 20000, platforms: ["win32"],
  description: "Drag with the left button from one point to another.",
  schema: { type: "object", properties: { from_x: XY.x, from_y: XY.y, to_x: XY.x, to_y: XY.y }, required: ["from_x", "from_y", "to_x", "to_y"] },
  describe: (p) => `Drag (${p.from_x}, ${p.from_y}) → (${p.to_x}, ${p.to_y})`,
  async run({ from_x, from_y, to_x, to_y }, { signal }) {
    const parts = [USER32, `[WinAPI]::SetCursorPos(${from_x},${from_y}) | Out-Null`, "Start-Sleep -Milliseconds 80", `[WinAPI]::mouse_event(${FLAGS.leftDown},0,0,0,[IntPtr]::Zero)`, "Start-Sleep -Milliseconds 80"];
    for (let i = 1; i <= 12; i++) parts.push(`[WinAPI]::SetCursorPos(${Math.round(from_x + ((to_x - from_x) * i) / 12)},${Math.round(from_y + ((to_y - from_y) * i) / 12)}) | Out-Null`, "Start-Sleep -Milliseconds 20");
    parts.push("Start-Sleep -Milliseconds 80", `[WinAPI]::mouse_event(${FLAGS.leftUp},0,0,0,[IntPtr]::Zero)`);
    await runPS(parts.join("; "), { signal, timeoutMs: 20000 });
    return `Dragged to (${to_x}, ${to_y})`;
  },
};

const VK = { ctrl: 0x11, control: 0x11, alt: 0x12, shift: 0x10, win: 0x5b, windows: 0x5b, meta: 0x5b, tab: 0x09, enter: 0x0d, return: 0x0d, esc: 0x1b, escape: 0x1b, space: 0x20, backspace: 0x08, delete: 0x2e, del: 0x2e, insert: 0x2d, home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22, up: 0x26, down: 0x28, left: 0x25, right: 0x27, capslock: 0x14, printscreen: 0x2c, ";": 0xba, "=": 0xbb, ",": 0xbc, "-": 0xbd, ".": 0xbe, "/": 0xbf, "`": 0xc0, "[": 0xdb, "\\": 0xdc, "]": 0xdd, "'": 0xde };
for (let i = 1; i <= 12; i++) VK[`f${i}`] = 0x6f + i;
for (let i = 0; i <= 9; i++) VK[String(i)] = 0x30 + i;
for (let i = 0; i < 26; i++) VK[String.fromCharCode(97 + i)] = 0x41 + i;
const EXTENDED = new Set([0x5b, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2d, 0x2e, 0x2c]);

const key_combo = {
  name: "key_combo", title: "Key combination", category: "input", risk: "medium", reversible: false, timeoutMs: 10000, platforms: ["win32"],
  description: "Press a key combination such as ctrl+s, alt+tab, win+r or enter.",
  schema: { type: "object", properties: { keys: { type: "array", items: { type: "string", minLength: 1, maxLength: 12 }, minItems: 1, maxItems: 5 } }, required: ["keys"] },
  describe: (p) => `Press ${(p.keys || []).join("+")}`,
  async run({ keys }, { signal }) {
    const codes = keys.map((k) => {
      const c = VK[String(k).trim().toLowerCase()];
      if (c === undefined) throw new Error(`Unknown key "${k}".`);
      return c;
    });
    const flag = (c) => (EXTENDED.has(c) ? 1 : 0);
    const parts = [USER32];
    for (const c of codes) parts.push(`[WinAPI]::keybd_event(${c},0,${flag(c)},[IntPtr]::Zero)`);
    parts.push("Start-Sleep -Milliseconds 40");
    for (const c of [...codes].reverse()) parts.push(`[WinAPI]::keybd_event(${c},0,${flag(c) | 2},[IntPtr]::Zero)`);
    await runPS(parts.join("; "), { signal });
    return `Pressed ${keys.join("+")}`;
  },
};

const keyboard_type = {
  name: "keyboard_type", title: "Type text", category: "input", risk: "medium", reversible: false, timeoutMs: 30000, platforms: ["win32"],
  description: "Type text into the focused window (Hebrew and other scripts are pasted through the clipboard and the clipboard is restored).",
  schema: { type: "object", properties: { text: { type: "string", minLength: 1, maxLength: 20000 } }, required: ["text"] },
  describe: (p) => `Type ${p.text.length} characters`,
  redact: (p) => ({ chars: p.text.length }),
  async run({ text }, { signal }) {
    const nonAscii = /[^\x00-\x7F]/.test(text);
    if (nonAscii) {
      await runPS(`${USER32}; Add-Type -AssemblyName System.Windows.Forms; $prev = Get-Clipboard -Raw -ErrorAction SilentlyContinue; Set-Clipboard -Value $env:JARVIS_TEXT; Start-Sleep -Milliseconds 80; [WinAPI]::keybd_event(0x11,0,0,[IntPtr]::Zero); [WinAPI]::keybd_event(0x56,0,0,[IntPtr]::Zero); Start-Sleep -Milliseconds 40; [WinAPI]::keybd_event(0x56,0,2,[IntPtr]::Zero); [WinAPI]::keybd_event(0x11,0,2,[IntPtr]::Zero); Start-Sleep -Milliseconds 200; if ($null -ne $prev) { Set-Clipboard -Value $prev } else { Set-Clipboard -Value '' }`, { args: { text }, signal, timeoutMs: 20000 });
      return `Typed ${text.length} characters (clipboard paste)`;
    }
    await runPS(`Add-Type -AssemblyName System.Windows.Forms; $t = $env:JARVIS_TEXT -replace '([+^%~(){}\\[\\]])', '{$1}'; [System.Windows.Forms.SendKeys]::SendWait($t)`, { args: { text }, signal, timeoutMs: 20000 });
    return `Typed ${text.length} characters`;
  },
};

module.exports = { tools: [mouse_move, mouse_click, mouse_scroll, mouse_drag, key_combo, keyboard_type] };
