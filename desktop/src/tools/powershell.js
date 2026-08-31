const { execFile } = require("child_process");
const os = require("os");

const IS_WIN = os.platform() === "win32";

const children = new Set();

function runPS(script, timeout = 10000) {
  if (!IS_WIN) throw new Error("PowerShell tools require Windows.");
  return new Promise((resolve, reject) => {
    const child = execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeout, maxBuffer: 2 * 1024 * 1024 },
      (err, stdout, stderr) => {
        children.delete(child);
        if (err) reject(new Error(stderr || err.message));
        else resolve(stdout.trim());
      }
    );
    children.add(child);
  });
}

function escapePS(str) {
  return str.replace(/'/g, "''");
}

function killAll() {
  for (const child of children) {
    try { child.kill("SIGKILL"); } catch {}
  }
  children.clear();
}

const USER32_TYPE = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class WinAPI {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, int dwData, IntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, IntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
'@ -ErrorAction SilentlyContinue
`;

module.exports = { runPS, escapePS, killAll, USER32_TYPE, IS_WIN };
