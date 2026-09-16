const { contextBridge, ipcRenderer } = require("electron");

// The renderer is the same web app a phone uses. Inside the desktop window it
// additionally receives the owner device credentials so it never has to pair,
// and it plays the alert sound and speaks, because Web Audio and speech
// synthesis are renderer APIs that use the voices already installed in Windows.
contextBridge.exposeInMainWorld("jarvisDesktop", {
  isDesktop: true,
  getOwnerDevice: () => ipcRenderer.invoke("owner-device"),
  getAgentInfo: () => ipcRenderer.invoke("agent-info"),
  openPath: (p) => ipcRenderer.invoke("open-path", p),
  onAlertSound: (cb) => {
    const handler = () => { cb(); };
    ipcRenderer.on("jarvis:alert-sound", handler);
    return () => { ipcRenderer.removeListener("jarvis:alert-sound", handler); };
  },
  onSpeak: (cb) => {
    const handler = (_e, text) => { cb(String(text || "")); };
    ipcRenderer.on("jarvis:speak", handler);
    return () => { ipcRenderer.removeListener("jarvis:speak", handler); };
  },
});
