const { app, BrowserWindow, Tray, Menu, ipcMain, globalShortcut, nativeImage, dialog } = require("electron");
const path = require("path");
const config = require("./src/config");
const { VoiceService } = require("./src/voice");
const { runAgent, abort, resetAbort, DESKTOP_PERSONA } = require("./src/agent");
const toolRegistry = require("./src/tools/index");
const powershell = require("./src/tools/powershell");
const { log, readToday } = require("./src/audit");

let mainWindow = null;
let tray = null;
let voice = null;
let cfg = config.load();

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }

app.on("second-instance", () => { showWindow(); });

app.whenReady().then(() => {
  cfg = config.load();
  createTray();
  createWindow();
  registerHotkeys();
  startVoice();
});

app.on("window-all-closed", (e) => {
  // Don't quit — keep running in tray
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    title: "JARVIS",
    show: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "ui", "index.html"));

  mainWindow.on("close", (e) => {
    e.preventDefault();
    mainWindow.hide();
  });
}

function showWindow() {
  if (!mainWindow) createWindow();
  else { mainWindow.show(); mainWindow.focus(); }
}

function createTray() {
  const icon = nativeImage.createFromDataURL(
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAABhSURBVFhH7c6xDQAwCAOwkv9/OjuwIYWBwZZs6e4+e3+egBdewAsv4IUX8MILeOEFvPACXngBL7yAF17ACy/ghRfwwgt44QW88AJeeAEvvIAXXsALL+CFF/DCC3jhBX5m5gCKMwMhHBh6RgAAAABJRU5ErkJggg=="
  );
  tray = new Tray(icon);
  updateTrayMenu("listening");
  tray.setToolTip("JARVIS — Running");
  tray.on("double-click", showWindow);
}

function updateTrayMenu(state) {
  const stateLabels = {
    stopped: "Stopped",
    listening: "Listening for \"JARVIS\"",
    paused: "Paused",
    active: "Listening for command...",
    processing: "Processing...",
  };
  const menu = Menu.buildFromTemplate([
    { label: `JARVIS — ${stateLabels[state] || state}`, enabled: false },
    { type: "separator" },
    { label: "Open JARVIS", click: showWindow },
    { type: "separator" },
    { label: "Pause Listening", click: () => voice?.pause(), visible: state === "listening" || state === "active" },
    { label: "Resume Listening", click: () => voice?.resume(), visible: state === "paused" },
    { label: "Stop JARVIS", click: () => emergencyStop("tray") },
    { type: "separator" },
    { label: `Mode: ${cfg.mode.toUpperCase()}`, enabled: false },
    { label: "Switch to Safe Mode", click: () => { cfg = config.update({ mode: "safe" }); updateTrayMenu(voice?.getState() || "stopped"); }, visible: cfg.mode !== "safe" },
    { label: "Switch to Assistant Mode", click: () => { cfg = config.update({ mode: "assistant" }); updateTrayMenu(voice?.getState() || "stopped"); }, visible: cfg.mode !== "assistant" },
    { type: "separator" },
    { label: "Settings...", click: () => showWindow() },
    { label: "View Audit Log", click: () => { showWindow(); mainWindow?.webContents.send("show-audit"); } },
    { type: "separator" },
    { label: "Exit JARVIS", click: () => { voice?.stop(); app.exit(0); } },
  ]);
  tray.setContextMenu(menu);
}

function emergencyStop(source) {
  abort();
  powershell.killAll();
  voice?.stop();
  updateTrayMenu("stopped");
  log({ action: "emergency_stop", tool: source, result: "SUCCESS" });
  mainWindow?.webContents.send("emergency-stop");
}

function registerHotkeys() {
  const key = cfg.hotkeys?.emergencyStop || "CommandOrControl+Shift+Escape";
  globalShortcut.register(key, () => emergencyStop("hotkey"));
}

function startVoice() {
  voice = new VoiceService(cfg);

  voice.on("state", (state) => {
    updateTrayMenu(state);
    mainWindow?.webContents.send("voice-state", state);
  });

  voice.on("wakeword", () => {
    log({ action: "wake_word_detected", tool: "voice", result: "SUCCESS" });
    mainWindow?.webContents.send("wakeword");
    if (!mainWindow?.isVisible()) showWindow();
  });

  voice.on("command", async (text) => {
    log({ action: "voice_command", tool: "voice", target: text.slice(0, 200), result: "RECEIVED" });
    mainWindow?.webContents.send("voice-command", text);
    await handleAgentMessage(text);
    voice.doneProcessing();
  });

  if (cfg.wakeWordEnabled && mainWindow) {
    voice.start(mainWindow);
  }
}

async function handleAgentMessage(text, history = []) {
  resetAbort();
  const messages = [...history, { role: "user", content: text }];
  const { reply, toolTrace, aborted } = await runAgent(toolRegistry, {
    messages,
    mode: cfg.mode,
    requestApproval: (info) => requestUserApproval(info),
    onProgress: (p) => mainWindow?.webContents.send("agent-progress", p),
  });
  mainWindow?.webContents.send("agent-reply", { reply, toolTrace, aborted });
  if (reply && cfg.ttsEnabled && voice) {
    voice.speak(mainWindow, reply);
  }
  return { reply, toolTrace, aborted };
}

async function requestUserApproval(info) {
  if (!mainWindow) return { approved: false, scope: "once" };
  showWindow();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (answer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ipcMain.removeListener("approval-response", handler);
      resolve(answer);
    };
    const handler = (_event, answer) => {
      const norm = typeof answer === "boolean" ? { approved: answer, scope: "once" } : (answer || { approved: false, scope: "once" });
      finish(norm);
    };
    ipcMain.on("approval-response", handler);
    const timer = setTimeout(() => finish({ approved: false, scope: "once", reason: "timeout" }), 120000);
    mainWindow.webContents.send("request-approval", info);
  });
}

// --- IPC Handlers ---
ipcMain.handle("get-config", () => config.load());
ipcMain.handle("update-config", (_e, partial) => { cfg = config.update(partial); return cfg; });
ipcMain.handle("get-voice-state", () => voice?.getState() || "stopped");
ipcMain.handle("get-audit", (_e, limit) => readToday(limit));

ipcMain.handle("send-message", async (_e, { text, history }) => {
  return handleAgentMessage(text, history || []);
});

ipcMain.on("approval-response", () => {});

ipcMain.handle("voice-start", () => { if (mainWindow) voice?.start(mainWindow); });
ipcMain.handle("voice-stop", () => voice?.stop());
ipcMain.handle("voice-pause", () => voice?.pause());
ipcMain.handle("voice-resume", () => voice?.resume());

ipcMain.handle("emergency-stop", () => emergencyStop("button"));

ipcMain.handle("set-mode", (_e, mode) => {
  cfg = config.update({ mode });
  updateTrayMenu(voice?.getState() || "stopped");
  return cfg;
});

ipcMain.on("voice-transcript", (_e, text, isFinal) => {
  voice?.handleTranscript(text, isFinal);
});

ipcMain.on("voice-error", (_e, err) => {
  console.error("Voice error:", err);
  if (err === "not-allowed" || err === "service-not-allowed") {
    voice?.stop();
  }
});
