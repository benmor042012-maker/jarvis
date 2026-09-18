// The everyday things an assistant is asked for that are not files: the volume,
// what is playing, locking the screen, whether the battery is about to die, and
// "write that down". Switching between windows is already in screen.js.
//
// All of it is done with what Windows already provides — key events and
// PowerShell — so there is nothing to install, nothing to sign in to and
// nothing to pay for. On macOS and Linux the Windows-only ones say so with the
// reason rather than pretending; the notes and the status work everywhere they
// can.
const fs = require("fs");
const os = require("os");
const path = require("path");

const paths = require("../paths");
const { runPS, USER32 } = require("../ps");

// Virtual-key codes for the media and volume keys every keyboard reports, even
// when it has no such keys printed on it.
const MEDIA_KEYS = {
  volume_up: 0xaf,
  volume_down: 0xae,
  mute: 0xad,
  play_pause: 0xb3,
  next: 0xb0,
  previous: 0xb1,
  stop: 0xb2,
};

async function tapKey(code, times, signal) {
  const parts = [USER32];
  for (let i = 0; i < times; i++) {
    parts.push(`[WinAPI]::keybd_event(${code},0,1,[IntPtr]::Zero)`);
    parts.push(`[WinAPI]::keybd_event(${code},0,3,[IntPtr]::Zero)`);
    if (times > 1) parts.push("Start-Sleep -Milliseconds 15");
  }
  await runPS(parts.join("; "), { signal });
}

const media_control = {
  name: "media_control", title: "Play, pause or skip", category: "system", risk: "low", reversible: true, timeoutMs: 10000, platforms: ["win32"],
  description: "Control whatever is playing: play or pause, next track, previous track, stop. Works with any player that responds to the media keys.",
  schema: { type: "object", properties: { action: { type: "string", enum: ["play_pause", "next", "previous", "stop"] } }, required: ["action"] },
  describe: (p) => ({ play_pause: "Play or pause", next: "Next track", previous: "Previous track", stop: "Stop playback" })[p.action] || `Media: ${String(p.action)}`,
  async run({ action }, { signal }) {
    await tapKey(MEDIA_KEYS[action], 1, signal);
    return { ok: true, summary: `Sent ${action.replace("_", "/")} to whatever is playing.`, data: { action } };
  },
};

const set_volume = {
  name: "set_volume", title: "Volume", category: "system", risk: "low", reversible: true, timeoutMs: 15000, platforms: ["win32"],
  description: "Turn the volume up or down, or mute and unmute it.",
  schema: {
    type: "object",
    properties: {
      direction: { type: "string", enum: ["up", "down", "mute"] },
      // Each step is one press of the volume key: about two points of volume.
      steps: { type: "integer", minimum: 1, maximum: 25 },
    },
    required: ["direction"],
  },
  describe: (p) => (p.direction === "mute" ? "Mute or unmute the sound" : `Turn the volume ${String(p.direction)}${p.steps ? ` by ${String(p.steps)} steps` : ""}`),
  async run({ direction, steps = 4 }, { signal }) {
    const key = direction === "mute" ? MEDIA_KEYS.mute : direction === "up" ? MEDIA_KEYS.volume_up : MEDIA_KEYS.volume_down;
    await tapKey(key, direction === "mute" ? 1 : steps, signal);
    return {
      ok: true,
      summary: direction === "mute" ? "Toggled mute." : `Volume ${direction}.`,
      // Windows gives no reliable way to read the level back without extra
      // components, so no number is claimed here.
      data: { direction, steps: direction === "mute" ? 1 : steps },
    };
  },
};

const lock_screen = {
  name: "lock_screen", title: "Lock the screen", category: "system", risk: "medium", reversible: true, timeoutMs: 10000, platforms: ["win32"],
  description: "Lock Windows, as pressing Win+L does. Nothing is closed and nothing is lost.",
  schema: { type: "object", properties: {} },
  describe: () => "Lock the screen",
  async run(_p, { signal }) {
    await runPS("rundll32.exe user32.dll,LockWorkStation", { signal });
    return { ok: true, summary: "Screen locked.", data: {} };
  },
};

const system_status = {
  name: "system_status", title: "How the computer is doing", category: "system", risk: "low", reversible: true, timeoutMs: 20000,
  description: "Battery, free disk space, memory in use and how long the computer has been on. Read-only.",
  schema: { type: "object", properties: {} },
  describe: () => "Check battery, disk, memory and uptime",
  async run(_p, { signal }) {
    const gb = (bytes) => Math.round((bytes / 1024 ** 3) * 10) / 10;
    const data = {
      computer: os.hostname(),
      uptime_hours: Math.round((os.uptime() / 3600) * 10) / 10,
      memory_free_gb: gb(os.freemem()),
      memory_total_gb: gb(os.totalmem()),
      battery: null,
      disks: [],
    };
    if (os.platform() === "win32") {
      // One PowerShell call for both, so this is one process rather than three.
      const out = await runPS(
        `$b = Get-CimInstance Win32_Battery | Select-Object -First 1
$d = Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object { "$($_.DeviceID)|$($_.FreeSpace)|$($_.Size)" }
Write-Output "BATTERY|$($b.EstimatedChargeRemaining)|$($b.BatteryStatus)"
$d | ForEach-Object { Write-Output "DISK|$_" }`,
        { signal },
      );
      for (const line of out.split(/\r?\n/)) {
        const parts = line.trim().split("|");
        if (parts[0] === "BATTERY" && parts[1]) {
          // BatteryStatus 2 means running on mains.
          data.battery = { percent: Number(parts[1]), charging: parts[2] === "2" };
        } else if (parts[0] === "DISK" && parts[1]) {
          data.disks.push({ drive: parts[1], free_gb: gb(Number(parts[2] || 0)), total_gb: gb(Number(parts[3] || 0)) });
        }
      }
    }
    const bits = [];
    if (data.battery) bits.push(`battery ${String(data.battery.percent)}%${data.battery.charging ? " (charging)" : ""}`);
    const disk = data.disks[0];
    if (disk) bits.push(`${String(disk.free_gb)} GB free on ${disk.drive}`);
    bits.push(`${String(data.memory_free_gb)} of ${String(data.memory_total_gb)} GB memory free`);
    bits.push(`up ${String(data.uptime_hours)} h`);
    return { ok: true, summary: bits.join(" · "), data };
  },
};

/** One file per day, in the JARVIS home — plain Markdown, readable without JARVIS. */
function noteFile(when = new Date()) {
  const dir = path.join(paths.HOME, "notes");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${when.toISOString().slice(0, 10)}.md`);
}

const note_add = {
  name: "note_add", title: "Write it down", category: "system", risk: "low", reversible: true, timeoutMs: 5000,
  description: "Append a line to today's notes, with the time. The notes are plain text files in the JARVIS folder, one per day.",
  schema: { type: "object", properties: { text: { type: "string", minLength: 1, maxLength: 2000 } }, required: ["text"] },
  describe: (p) => `Note: ${String(p.text).slice(0, 60)}`,
  // The note itself is the user's words: kept out of the log, like clipboard text.
  redact: () => ({}),
  async run({ text }) {
    const file = noteFile();
    const when = new Date().toTimeString().slice(0, 5);
    const first = !fs.existsSync(file);
    fs.appendFileSync(file, `${first ? `# ${new Date().toISOString().slice(0, 10)}\n\n` : ""}- ${when} ${String(text).trim()}\n`, { mode: 0o600 });
    return { ok: true, summary: `Written down in ${path.basename(file)}.`, data: { file } };
  },
};

const notes_today = {
  name: "notes_today", title: "Today's notes", category: "system", risk: "low", reversible: true, timeoutMs: 5000,
  description: "Read back what was written down today.",
  schema: { type: "object", properties: {} },
  describe: () => "Read today's notes",
  async run() {
    const file = noteFile();
    if (!fs.existsSync(file)) return { ok: true, summary: "Nothing written down today.", data: { file, lines: [] } };
    const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.startsWith("- "));
    return { ok: true, summary: `${String(lines.length)} note(s) today.`, data: { file, lines } };
  },
};

module.exports = { tools: [media_control, set_volume, lock_screen, system_status, note_add, notes_today] };
