// Screen and window tools. Screenshots are only taken after permission
// (medium risk) and are never written to the audit log — only their path.
const fs = require("fs");
const os = require("os");
const path = require("path");
const paths = require("../paths");
const procs = require("../procs");
const { runPS, USER32 } = require("../ps");

const PLATFORM = os.platform();

function tempShot() {
  fs.mkdirSync(paths.TEMP, { recursive: true });
  return path.join(paths.TEMP, `screenshot-${Date.now()}.png`);
}

function cleanupShots(keep = 20) {
  try {
    const files = fs.readdirSync(paths.TEMP).filter((f) => f.startsWith("screenshot-")).sort();
    for (const f of files.slice(0, Math.max(0, files.length - keep))) fs.unlinkSync(path.join(paths.TEMP, f));
  } catch { /* ignore */ }
}

const screenshot = {
  name: "screenshot", title: "Take screenshot", category: "screen", risk: "medium", reversible: true, timeoutMs: 25000,
  description: "Capture the screen to ~/.jarvis/temp. Asks for permission first. The image is never sent anywhere.",
  schema: { type: "object", properties: {} },
  redact: () => ({}),
  async run(_p, { signal }) {
    const file = tempShot();
    if (PLATFORM === "win32") {
      await runPS(`Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b=[System.Windows.Forms.SystemInformation]::VirtualScreen; $bmp=New-Object System.Drawing.Bitmap($b.Width,$b.Height); $g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); $bmp.Save($env:JARVIS_FILE,[System.Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $bmp.Dispose()`, { args: { file }, timeoutMs: 20000, signal });
    } else if (PLATFORM === "darwin") {
      const r = await procs.run("screencapture", ["-x", file], { timeoutMs: 15000, signal });
      if (r.code !== 0) throw new Error("screencapture failed (grant Screen Recording permission in System Settings).");
    } else {
      let ok = false;
      for (const [bin, args] of [["gnome-screenshot", ["-f", file]], ["import", ["-window", "root", file]], ["scrot", [file]]]) {
        try { const r = await procs.run(bin, args, { timeoutMs: 15000, signal }); if (r.code === 0) { ok = true; break; } } catch { /* try next */ }
      }
      if (!ok) throw new Error("No screenshot tool found (install gnome-screenshot, imagemagick or scrot).");
    }
    if (!fs.existsSync(file)) throw new Error("Screenshot was not produced.");
    const bytes = fs.statSync(file).size;
    cleanupShots();
    return { ok: true, summary: `Screenshot saved (${Math.round(bytes / 1024)} KB)`, data: { path: file, bytes, image_url: `/api/files/screenshot?name=${encodeURIComponent(path.basename(file))}` } };
  },
};

const screen_info = {
  name: "screen_info", title: "Screen info", category: "screen", risk: "low", reversible: true, timeoutMs: 15000, platforms: ["win32"],
  description: "Report monitor layout and resolution.",
  schema: { type: "object", properties: {} },
  async run(_p, { signal }) {
    const out = await runPS(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::AllScreens | ForEach-Object { [PSCustomObject]@{ name=$_.DeviceName; primary=$_.Primary; x=$_.Bounds.X; y=$_.Bounds.Y; width=$_.Bounds.Width; height=$_.Bounds.Height } } | ConvertTo-Json -Compress`, { signal });
    let screens = [];
    try { screens = JSON.parse(out); } catch { throw new Error("Could not parse screen information."); }
    if (!Array.isArray(screens)) screens = [screens];
    return { ok: true, summary: `${screens.length} screen(s): ` + screens.map((s) => `${s.width}x${s.height}`).join(", "), data: { screens } };
  },
};

const list_windows = {
  name: "list_windows", title: "List windows", category: "screen", risk: "low", reversible: true, timeoutMs: 15000, platforms: ["win32"],
  description: "List open windows with pid, process name, title and position.",
  schema: { type: "object", properties: {} },
  async run(_p, { signal }) {
    const out = await runPS(`${USER32}; Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -ne '' } | ForEach-Object { $r = New-Object WinAPI+RECT; [WinAPI]::GetWindowRect($_.MainWindowHandle,[ref]$r) | Out-Null; [PSCustomObject]@{ pid=$_.Id; name=$_.ProcessName; title=$_.MainWindowTitle; x=$r.Left; y=$r.Top; width=($r.Right-$r.Left); height=($r.Bottom-$r.Top) } } | ConvertTo-Json -Compress`, { signal });
    let windows = [];
    if (out) { try { windows = JSON.parse(out); } catch { windows = []; } }
    if (!Array.isArray(windows)) windows = [windows];
    return { ok: true, summary: `${windows.length} window(s)`, data: { windows } };
  },
};

// $env:JARVIS_TITLE / $env:JARVIS_PID are read inside PowerShell — user text never enters the script.
const SELECT = `if ($env:JARVIS_PID -ne '') { $p = Get-Process -Id ([int]$env:JARVIS_PID) -ErrorAction Stop } else { $p = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like ('*' + $env:JARVIS_TITLE + '*') } | Select-Object -First 1; if (-not $p) { throw ('Window not found: ' + $env:JARVIS_TITLE) } }`;
const SW = { restore: 9, minimized: 2, maximized: 3 };

function windowTool(name, title, description, risk, script, verb) {
  return {
    name, title, category: "screen", risk, reversible: risk === "low", timeoutMs: 15000, platforms: ["win32"], description,
    schema: { type: "object", properties: { title: { type: "string", maxLength: 200, default: "" }, pid: { type: "integer", minimum: 0, maximum: 4294967295, default: 0 } } },
    describe: (p) => `${verb} window ${p.pid ? `pid ${p.pid}` : `"${p.title}"`}`,
    async run({ title: t, pid }, { signal }) {
      if (!t && !pid) throw new Error("Give a window title or pid.");
      const out = await runPS(`${USER32}; ${SELECT}; ${script}; Write-Output $p.MainWindowTitle`, { args: { title: t || "", pid: pid || "" }, signal });
      return { ok: true, summary: `${verb}: ${out}`, data: { title: out } };
    },
  };
}

const focus_window = windowTool("focus_window", "Focus window", "Bring a window to the front by (partial) title or pid.", "low", `[WinAPI]::ShowWindow($p.MainWindowHandle,${SW.restore}) | Out-Null; Start-Sleep -Milliseconds 60; [WinAPI]::SetForegroundWindow($p.MainWindowHandle) | Out-Null`, "Focused");
const minimize_window = windowTool("minimize_window", "Minimize window", "Minimize a window by title or pid.", "low", `[WinAPI]::ShowWindow($p.MainWindowHandle,${SW.minimized}) | Out-Null`, "Minimized");
const maximize_window = windowTool("maximize_window", "Maximize window", "Maximize a window by title or pid.", "low", `[WinAPI]::ShowWindow($p.MainWindowHandle,${SW.maximized}) | Out-Null`, "Maximized");
const close_window = windowTool("close_window", "Close window", "Politely close a window (WM_CLOSE; the app may ask to save).", "medium", `[WinAPI]::PostMessage($p.MainWindowHandle,0x0010,[IntPtr]::Zero,[IntPtr]::Zero) | Out-Null`, "Close requested");

module.exports = { tools: [screenshot, screen_info, list_windows, focus_window, minimize_window, maximize_window, close_window] };
