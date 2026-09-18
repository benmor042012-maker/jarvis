// JARVIS desktop agent (Electron). Runs the local agent core, keeps a tray
// icon, hides to the tray on close, registers the emergency-stop hotkey,
// provides the native second confirmation for high-risk actions and the
// built-in browser used for form automation. No cloud, no API keys.
const { app, BrowserWindow, Tray, Menu, ipcMain, globalShortcut, nativeImage, dialog, Notification, safeStorage, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const { Agent } = require("./src/core/agent");
const config = require("./src/core/config");
const audit = require("./src/core/audit");

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());
  app.whenReady().then(boot).catch((e) => {
    dialog.showErrorBox("JARVIS could not start", String(e.message || e));
    app.exit(1);
  });
}

let agent = null;
let mainWindow = null;
let tray = null;
let serverInfo = null;
let quitting = false;

const VOICE_LABEL = {
  unavailable: "unavailable",
  permission_required: "permission needed",
  off: "off",
  standby: "waiting for the wake phrase",
  listening: "LISTENING",
  thinking: "thinking",
  speaking: "speaking",
  paused: "paused",
  muted: "muted",
  quiet_hours: "quiet hours",
};

const STATE_LABEL = {
  connected: "Connected",
  listening: "Listening",
  busy: "Busy",
  paused: "Paused",
  emergency_stopped: "EMERGENCY STOPPED",
  offline: "Offline",
};

function assetIcon(state) {
  const file = path.join(__dirname, "assets", `tray-${state}.png`);
  return nativeImage.createFromPath(fs.existsSync(file) ? file : path.join(__dirname, "assets", "tray-connected.png"));
}

function isOwnPage(url) {
  try {
    const u = new URL(String(url));
    return (u.hostname === "127.0.0.1" || u.hostname === "localhost") && (!serverInfo || Number(u.port) === Number(serverInfo.port));
  } catch {
    return false;
  }
}

function clientDist() {
  const candidates = [path.join(process.resourcesPath || "", "client-dist"), path.join(__dirname, "..", "client", "dist")];
  return candidates.find((c) => fs.existsSync(path.join(c, "index.html"))) || candidates[1];
}

async function boot() {
  const host = {
    confirmLocal,
    notify: (title, body) => { if (Notification.isSupported()) new Notification({ title, body }).show(); showWindow(); },
    // Sound and speech live in the window: the Web Audio and speech-synthesis
    // engines are renderer APIs, and the voices they use are the ones already
    // installed in Windows. If there is no window to ask, say so by throwing —
    // the alert record must not claim a channel that did not fire.
    alertSound: () => { if (!sendToWindow("jarvis:alert-sound", null)) { shell.beep(); } },
    speak: (text) => { if (!sendToWindow("jarvis:speak", String(text || ""))) throw new Error("no window to speak from"); },
    onEmergencyStop: () => { showWindow(); updateTray(); },
    onSettingsChanged: (cfg, before) => {
      if (cfg.autoStart !== before.autoStart) applyAutoStart(cfg);
      if (cfg.hotkeys?.emergencyStop !== before.hotkeys?.emergencyStop) registerHotkey(cfg);
      updateTray();
    },
    browser: { fill: browserFill },
  };
  const canEncrypt = safeStorage.isEncryptionAvailable();
  agent = new Agent({
    host,
    encrypt: canEncrypt ? (s) => safeStorage.encryptString(s).toString("base64") : undefined,
    decrypt: canEncrypt ? (b) => safeStorage.decryptString(Buffer.from(b, "base64")) : undefined,
  });
  agent.on("event", (e) => { if (e.type === "status" || e.type === "plan" || e.type === "voice_state" || e.type === "alert") updateTray(); });
  serverInfo = await agent.start({ staticRoot: clientDist() });
  agent.ownerDevice();
  const cfg = config.load();
  createTray();
  // Windows groups taskbar buttons by this id and takes the icon from the group,
  // not from the window: without it a JARVIS started from the command line shows
  // Electron's own icon on the taskbar however the window is set up. The built
  // installer sets it from package.json; running from source has to say it here.
  if (process.platform === "win32") {
    try {
      app.setAppUserModelId(require("./package.json").build?.appId || "local.jarvis.desktop");
    } catch {
      /* older Electron: the taskbar keeps its default icon, nothing else breaks */
    }
  }
  createWindow();
  registerHotkey(cfg);
  applyAutoStart(cfg);
  updateTray();
}

// --- window ------------------------------------------------------------------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 360,
    minHeight: 560,
    title: "JARVIS",
    backgroundColor: "#030b18",
    icon: path.join(__dirname, "assets", "icon.png"),
    autoHideMenuBar: true,
    show: !process.argv.includes("--hidden"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Chromium slows a hidden window down to a crawl, and the microphone and
      // the wake-word detector live in that window. Without this, closing
      // JARVIS to the tray means it stops hearing you — which is the one thing
      // a wake word must never do.
      backgroundThrottling: false,
    },
  });
  mainWindow.loadURL(`http://127.0.0.1:${serverInfo.port}/`);
  mainWindow.on("close", (e) => {
    if (quitting) return;
    // Closing hides to the tray; the agent keeps running. Quit is in the tray menu.
    e.preventDefault();
    mainWindow.hide();
    if (process.platform === "win32" && tray && !app._hideHintShown) {
      app._hideHintShown = true;
      tray.displayBalloon?.({ title: "JARVIS keeps running", content: "The agent is still active in the tray. Use Quit in the tray menu to stop it." });
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: "deny" }; });

  // The window may use the microphone, and only the microphone, and only while
  // voice is switched on. Camera, screen capture, geolocation, notifications
  // and everything else are refused here — the native notification comes from
  // this process, and nothing in JARVIS needs the rest.
  const allowMedia = (details) => {
    if (!isOwnPage(details?.securityOrigin || details?.requestingUrl || mainWindow.webContents.getURL())) return false;
    if (details && Array.isArray(details.mediaTypes) && details.mediaTypes.includes("video")) return false;
    return config.load().voice?.enabled !== false;
  };
  const ses = mainWindow.webContents.session;
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    const ok = permission === "media" ? allowMedia(details) : false;
    audit.log({ event: "window_permission", detail: { permission, granted: ok } });
    callback(ok);
  });
  ses.setPermissionCheckHandler((_wc, permission, origin, details) => (permission === "media" ? allowMedia({ ...details, securityOrigin: origin }) : false));
  ses.setDevicePermissionHandler(() => false);
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  else { mainWindow.show(); mainWindow.focus(); }
}

/** True if the message actually reached a live window. */
function sendToWindow(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return false;
  try {
    mainWindow.webContents.send(channel, payload);
    return true;
  } catch {
    return false;
  }
}

// --- tray ----------------------------------------------------------------------
function createTray() {
  tray = new Tray(assetIcon("connected"));
  tray.on("double-click", showWindow);
  tray.on("click", () => { if (process.platform !== "darwin") showWindow(); });
}

function updateTray() {
  if (!tray || !agent) return;
  const status = agent.status();
  const cfg = config.load();
  const state = status.state;
  const voice = status.voice || {};
  // "Listening" on the tray means the microphone is actually open right now.
  const icon = state === "connected" && voice.state === "listening" ? "listening" : state;
  tray.setImage(assetIcon(icon));
  tray.setToolTip(
    `JARVIS — ${STATE_LABEL[state] || state} · ${cfg.mode.toUpperCase()} mode` +
      ` · mic ${VOICE_LABEL[voice.state] || voice.state || "off"}` +
      (status.alerts?.open ? ` · ${status.alerts.open} customer alert(s)` : "") +
      (status.pending_plans ? ` · ${status.pending_plans} approval(s) waiting` : ""),
  );
  const menu = Menu.buildFromTemplate([
    { label: `JARVIS — ${STATE_LABEL[state] || state}`, enabled: false },
    { label: `Devices: ${status.devices.connected} connected, ${status.devices.paired} paired`, enabled: false },
    { label: `Local AI: ${status.cost_network.local_ai_only ? "local only" : "?"} · External calls: 0`, enabled: false },
    { type: "separator" },
    { label: "Open JARVIS", click: showWindow },
    { label: status.pending_plans ? `Review ${status.pending_plans} pending approval(s)` : "No pending approvals", enabled: !!status.pending_plans, click: showWindow },
    { label: status.alerts?.open ? `${status.alerts.open} customer alert(s) — open` : "No customer alerts", enabled: !!status.alerts?.open, click: showWindow },
    { type: "separator" },
    { label: `Microphone: ${VOICE_LABEL[voice.state] || voice.state || "off"}`, enabled: false },
    voice.paused
      ? { label: "Resume microphone", click: () => { agent.voice.setPaused(false); updateTray(); } }
      : { label: "Pause microphone", click: () => { agent.voice.setPaused(true); updateTray(); } },
    voice.muted
      ? { label: "Unmute JARVIS", click: () => { agent.voice.setMuted(false); updateTray(); } }
      : { label: "Mute JARVIS (no listening, no speaking)", click: () => { agent.voice.setMuted(true); updateTray(); } },
    { type: "separator" },
    status.emergency
      ? { label: "Clear emergency stop", click: () => { agent.clearEmergency({ name: "tray" }); updateTray(); } }
      : { label: "EMERGENCY STOP", click: () => emergencyStop("tray") },
    status.paused ? { label: "Resume", click: () => { agent.state.setPaused(false); updateTray(); } } : { label: "Pause (no new actions)", click: () => { agent.state.setPaused(true); updateTray(); } },
    { type: "separator" },
    { label: `Mode: ${cfg.mode.toUpperCase()}`, submenu: ["safe", "assistant", "advanced"].map((m) => ({ label: m[0].toUpperCase() + m.slice(1), type: "radio", checked: cfg.mode === m, click: () => { agent.setMode(m, { name: "tray" }); updateTray(); } })) },
    { label: "Start with Windows", type: "checkbox", checked: !!cfg.autoStart, click: (item) => { agent.updateSettings({ autoStart: item.checked }, { name: "tray" }); } },
    { label: `Emergency hotkey: ${agent.hotkeyInfo.active || "not registered"}`, enabled: false },
    { type: "separator" },
    { label: "Quit JARVIS (stops the agent)", click: quitApp },
  ]);
  tray.setContextMenu(menu);
}

function emergencyStop(source) {
  const r = agent.emergencyStop(source);
  updateTray();
  if (Notification.isSupported()) new Notification({ title: "JARVIS emergency stop", body: `Stopped ${r.cancelled_jobs} job(s), killed ${r.killed_processes} process(es). Clear it from the window or the tray.` }).show();
}

function quitApp() {
  quitting = true;
  try { agent?.stop(); } catch { /* ignore */ }
  app.quit();
}

// --- hotkey / autostart --------------------------------------------------------
function registerHotkey(cfg) {
  globalShortcut.unregisterAll();
  const wanted = cfg.hotkeys?.emergencyStop || "CommandOrControl+Shift+Escape";
  const fallback = "CommandOrControl+Alt+Shift+Escape";
  let active = null, error = null;
  for (const key of [wanted, fallback]) {
    try {
      if (globalShortcut.register(key, () => emergencyStop("hotkey"))) { active = key; break; }
      error = `could not register ${key}`;
    } catch (e) { error = `${key}: ${e.message}`; }
  }
  agent.hotkeyInfo = { requested: wanted, active, error: active ? (active === wanted ? null : `${wanted} was unavailable; using ${active}`) : error };
  audit.log({ event: "hotkey_registered", detail: agent.hotkeyInfo });
}

function applyAutoStart(cfg) {
  try {
    app.setLoginItemSettings({ openAtLogin: !!cfg.autoStart, args: ["--hidden"] });
  } catch (e) {
    audit.log({ event: "autostart_failed", detail: { error: e.message } });
  }
}

// --- second local confirmation (native dialog on this computer) ---------------
async function confirmLocal(plan, device) {
  showWindow();
  const lines = plan.actions.filter((a) => a.decision === "ask").map((a) => `• [${a.risk.toUpperCase()}] ${a.description}`);
  const res = await dialog.showMessageBox(mainWindow, {
    type: "warning",
    buttons: ["Cancel", "Confirm on this computer"],
    defaultId: 0,
    cancelId: 0,
    title: "JARVIS — confirm high-risk action",
    message: `"${device?.name || "A remote device"}" approved a high-risk plan. Confirm it here too?`,
    detail: `Command: ${plan.command}\n\n${lines.join("\n")}\n\nNothing runs unless you confirm here.`,
    noLink: true,
  });
  return res.response === 1;
}

// --- browser automation (built-in Chromium, visible to the user) -------------
async function browserFill(url, fields, { submit, signal }) {
  const win = new BrowserWindow({ width: 1000, height: 720, title: "JARVIS browser", show: true, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  const cancel = () => { try { win.close(); } catch { /* ignore */ } };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    await win.loadURL(url);
    const script = `(() => {
      const fields = ${JSON.stringify(fields || [])};
      const preview = []; const missing = [];
      for (const f of fields) {
        const el = document.querySelector(f.selector);
        if (!el) { missing.push(f.selector); continue; }
        if (el.tagName === "SELECT") { el.value = f.value; }
        else if (el.type === "checkbox" || el.type === "radio") { el.checked = ["true","1","on","yes"].includes(String(f.value).toLowerCase()); }
        else { el.focus(); el.value = f.value; }
        el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true }));
        preview.push({ selector: f.selector, label: (el.labels && el.labels[0] && el.labels[0].textContent.trim()) || el.name || el.id || el.tagName, value: String(f.value).slice(0, 200) });
      }
      return { preview, missing };
    })()`;
    const filled = await win.webContents.executeJavaScript(script, true);
    const result = { filled: filled.preview.length, preview: filled.preview, missing: filled.missing, submitted: false, finalUrl: win.webContents.getURL() };
    if (submit) {
      const clicked = await win.webContents.executeJavaScript(`(() => { const b = document.querySelector(${JSON.stringify(submit)}); if (!b) return false; b.click(); return true; })()`, true);
      if (!clicked) { result.error = `submit button '${submit}' not found`; return result; }
      await new Promise((resolve) => { const t = setTimeout(resolve, 6000); win.webContents.once("did-navigate", () => { clearTimeout(t); setTimeout(resolve, 800); }); });
      result.submitted = true;
      result.finalUrl = win.webContents.getURL();
    }
    return result;
  } finally {
    signal?.removeEventListener("abort", cancel);
    // The window stays open so the user can see what happened; they close it.
  }
}

// --- IPC (renderer gets only what it needs) ------------------------------------
ipcMain.handle("owner-device", () => {
  const d = agent.ownerDevice();
  return { id: d.id, secret: d.secret, name: d.name, role: d.role };
});
ipcMain.handle("agent-info", () => ({ port: serverInfo?.port, platform: process.platform, version: agent?.version, hotkey: agent?.hotkeyInfo }));
// The wake word was heard while JARVIS was in the tray. Bringing the window up
// is the whole point of saying it: the page cannot raise itself, and this is
// the only thing it may ask for — no arguments, nothing to get wrong.
ipcMain.handle("show-window", () => {
  showWindow();
  return true;
});

ipcMain.handle("open-path", async (_e, p) => {
  const cfg = config.load();
  const corePaths = require("./src/core/paths");
  // Compare canonical spellings: on Windows the same folder arrives as a short
  // name from one API and a long name from another.
  const target = corePaths.canonicalDir(path.dirname(String(p))) + path.sep + path.basename(String(p));
  const roots = [...(cfg.approvedFolders || []), corePaths.HOME].map((f) => corePaths.canonicalDir(f));
  const ok = roots.some((root) => target === root || target.startsWith(root + path.sep));
  if (!ok) return { ok: false, reason: "outside approved folders" };
  const err = await shell.openPath(String(p));
  return { ok: !err, reason: err || null };
});

app.on("window-all-closed", () => { /* keep running in the tray */ });
app.on("before-quit", () => { quitting = true; globalShortcut.unregisterAll(); });
app.on("will-quit", () => { try { agent?.stop(); } catch { /* ignore */ } });
