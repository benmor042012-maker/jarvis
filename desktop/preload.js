const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("jarvis", {
  getConfig: () => ipcRenderer.invoke("get-config"),
  updateConfig: (partial) => ipcRenderer.invoke("update-config", partial),
  getVoiceState: () => ipcRenderer.invoke("get-voice-state"),
  getAudit: (limit) => ipcRenderer.invoke("get-audit", limit),

  sendMessage: (text, history) => ipcRenderer.invoke("send-message", { text, history }),

  voiceStart: () => ipcRenderer.invoke("voice-start"),
  voiceStop: () => ipcRenderer.invoke("voice-stop"),
  voicePause: () => ipcRenderer.invoke("voice-pause"),
  voiceResume: () => ipcRenderer.invoke("voice-resume"),

  emergencyStop: () => ipcRenderer.invoke("emergency-stop"),
  setMode: (mode) => ipcRenderer.invoke("set-mode", mode),

  approvalResponse: (answer) => ipcRenderer.send("approval-response", answer),

  onVoiceState: (cb) => ipcRenderer.on("voice-state", (_e, s) => cb(s)),
  onWakeword: (cb) => ipcRenderer.on("wakeword", () => cb()),
  onVoiceCommand: (cb) => ipcRenderer.on("voice-command", (_e, t) => cb(t)),
  onAgentReply: (cb) => ipcRenderer.on("agent-reply", (_e, d) => cb(d)),
  onAgentProgress: (cb) => ipcRenderer.on("agent-progress", (_e, p) => cb(p)),
  onRequestApproval: (cb) => ipcRenderer.on("request-approval", (_e, info) => cb(info)),
  onEmergencyStop: (cb) => ipcRenderer.on("emergency-stop", () => cb()),
  onShowAudit: (cb) => ipcRenderer.on("show-audit", () => cb()),

  getBridgeInfo: () => ipcRenderer.invoke("get-bridge-info"),
});
