// PowerShell runner for Windows automation. User-supplied values are passed
// through environment variables ($env:JARVIS_*), never interpolated into the
// script text, so there is no way to inject PowerShell.
const os = require("os");
const procs = require("./procs");

const IS_WIN = os.platform() === "win32";

async function runPS(script, { args = {}, timeoutMs = 15000, signal } = {}) {
  if (!IS_WIN) throw new Error("This action needs Windows PowerShell and is unavailable on this system.");
  const env = {};
  for (const [k, v] of Object.entries(args)) env[`JARVIS_${k.toUpperCase()}`] = String(v);
  const res = await procs.run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { timeoutMs, signal, env });
  if (res.cancelled) throw new Error("cancelled");
  if (res.timedOut) throw new Error("timed out");
  if (res.code !== 0) throw new Error((res.stderr || res.stdout || `PowerShell exited with ${res.code}`).trim().slice(0, 500));
  return res.stdout.trim();
}

const USER32 = `
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

module.exports = { runPS, USER32, IS_WIN };
