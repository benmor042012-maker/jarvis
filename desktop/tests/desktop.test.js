// The Electron shell cannot be launched in CI, so these checks assert the
// contract main.js relies on: every tray state has an icon, the preload and
// build inputs exist, and the packaging config ships what the app needs.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const main = fs.readFileSync(path.join(ROOT, "main.js"), "utf8");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

test("every agent state has a tray icon", () => {
  const { AgentState } = require("../src/core/state");
  const s = new AgentState();
  const states = new Set(["connected", "listening", "busy", "paused", "emergency_stopped", "offline"]);
  s.emergencyStop("t");
  states.add(s.compute());
  for (const state of states) assert.ok(fs.existsSync(path.join(ROOT, "assets", `tray-${state}.png`)), `missing tray-${state}.png`);
  assert.ok(fs.existsSync(path.join(ROOT, "assets", "icon.png")));
});

test("main.js wires the required desktop behaviours", () => {
  assert.match(main, /requestSingleInstanceLock/, "single-instance lock");
  assert.match(main, /e\.preventDefault\(\);\s*\n\s*mainWindow\.hide\(\)/, "close hides to tray");
  assert.match(main, /globalShortcut\.register/, "emergency hotkey");
  assert.match(main, /setLoginItemSettings/, "Windows auto-start");
  assert.match(main, /confirmLocal/, "second local confirmation");
  assert.match(main, /browser:\s*\{\s*fill:\s*browserFill\s*\}/, "browser automation host");
  assert.match(main, /window-all-closed[\s\S]{0,120}keep running/, "does not quit when windows close");
  assert.match(main, /contextIsolation: true/, "context isolation");
  assert.ok(!/nodeIntegration:\s*true/.test(main), "node integration must stay off");
  assert.match(main, /safeStorage/, "OS-encrypted device secrets when available");
});

test("preload exposes only the desktop bridge", () => {
  const preload = fs.readFileSync(path.join(ROOT, "preload.js"), "utf8");
  assert.match(preload, /contextBridge\.exposeInMainWorld\("jarvisDesktop"/);
  // Listening is allowed, but only on channels named literally here: the page
  // must never be able to hand in a channel of its own and listen to anything.
  const ALLOWED_EVENTS = ["jarvis:alert-sound", "jarvis:speak"];
  for (const m of preload.matchAll(/ipcRenderer\.on\(\s*([^,]+),/g)) {
    const arg = m[1].trim();
    assert.match(arg, /^"[^"]+"$/, `ipcRenderer.on must use a literal channel, got ${arg}`);
    assert.ok(ALLOWED_EVENTS.includes(arg.slice(1, -1)), `unexpected event channel ${arg}`);
  }
  assert.ok(!/removeAllListeners|ipcRenderer\.(send|invoke)\(\s*[a-zA-Z]/.test(preload), "no unrestricted channel passthrough");
  for (const channel of ["owner-device", "agent-info", "open-path"]) assert.ok(preload.includes(channel), `missing ${channel}`);
  const handled = [...main.matchAll(/ipcMain\.handle\("([^"]+)"/g)].map((m) => m[1]);
  for (const channel of [...preload.matchAll(/ipcRenderer\.invoke\("([^"]+)"/g)].map((m) => m[1])) {
    assert.ok(handled.includes(channel), `preload calls ${channel} but main.js does not handle it`);
  }
});

test("packaging ships the UI and the agent, and nothing needs a key", () => {
  assert.deepEqual(pkg.dependencies, {});
  assert.ok(pkg.build.extraResources.some((r) => r.to === "client-dist"));
  for (const f of ["main.js", "preload.js", "headless.js", "src/**/*", "assets/**/*"]) assert.ok(pkg.build.files.includes(f), `missing ${f} in build.files`);
  assert.equal(pkg.build.win.target, "nsis");
});

test("the window may use the microphone and nothing else", () => {
  assert.match(main, /setPermissionRequestHandler/, "permission requests must be answered deliberately");
  assert.match(main, /setPermissionCheckHandler/);
  assert.match(main, /setDevicePermissionHandler\(\(\) => false\)/, "no device (USB/serial/HID) access");
  // Only "media" is ever granted, only for our own page, only audio, and only
  // while voice is switched on.
  assert.match(main, /permission === "media" \? allowMedia/);
  assert.match(main, /mediaTypes\.includes\("video"\)\) return false/, "the camera is never granted");
  assert.match(main, /config\.load\(\)\.voice\?\.enabled !== false/);
  assert.match(main, /isOwnPage\(/, "a foreign origin must never get the microphone");
});

test("the alert sound and speech are asked of the window, and never faked when there is none", () => {
  assert.match(main, /alertSound: \(\) =>[^\n]*sendToWindow\("jarvis:alert-sound"/);
  assert.match(main, /speak: \(text\) =>[^\n]*throw new Error\("no window to speak from"\)/, "a missing window must not be recorded as spoken");
  assert.match(main, /function sendToWindow/);
  assert.match(main, /isDestroyed\(\)\) return false/);
});

test("the tray shows what the microphone is doing", () => {
  assert.match(main, /VOICE_LABEL/);
  assert.match(main, /mic \$\{VOICE_LABEL/, "the tooltip names the voice state");
  assert.match(main, /Pause microphone/);
  assert.match(main, /Mute JARVIS/);
  assert.match(main, /customer alert\(s\)/);
  assert.match(main, /voice\.state === "listening" \? "listening"/, "the listening icon means the microphone is actually open");
});

test("closing the window leaves the agent running in the tray", () => {
  // Three separate things have to hold, and all three are easy to break by
  // accident: the close is cancelled, the window only hides, and no path from
  // closing reaches agent.stop().
  const close = /mainWindow\.on\("close"[\s\S]*?\n  \}\);/.exec(main);
  assert.ok(close, "the close handler must exist");
  assert.match(close[0], /if \(quitting\) return;/, "closing must still work when the user chose Quit");
  assert.match(close[0], /e\.preventDefault\(\);/, "closing must not end the process");
  assert.match(close[0], /mainWindow\.hide\(\);/, "closing hides the window");
  assert.ok(!/agent\??\.stop\(\)/.test(close[0]), "closing must never stop the agent");

  const allClosed = /app\.on\("window-all-closed"[^\n]*\n?/.exec(main);
  assert.ok(allClosed && /keep running/.test(allClosed[0]), "the app must not quit when the last window closes");
  assert.ok(!/agent\??\.stop\(\)/.test(allClosed[0]));

  // The agent is only ever stopped by quitting deliberately.
  const stops = [...main.matchAll(/agent\??\.stop\(\)/g)].map((m) => main.slice(Math.max(0, m.index - 260), m.index));
  assert.ok(stops.length > 0, "quitting must stop the agent");
  for (const context of stops) {
    assert.ok(/quitApp|will-quit/.test(context), `agent.stop() reached from something other than quitting: …${context.slice(-120)}`);
  }
  // And the tray says so the first time, so nobody thinks JARVIS is gone.
  assert.match(main, /JARVIS keeps running/);
});
