const { contextBridge, ipcRenderer } = require("electron");

// The renderer is the same web app a phone uses. Inside the desktop window it
// additionally receives the owner device credentials so it never has to pair.
contextBridge.exposeInMainWorld("jarvisDesktop", {
  isDesktop: true,
  getOwnerDevice: () => ipcRenderer.invoke("owner-device"),
  getAgentInfo: () => ipcRenderer.invoke("agent-info"),
  openPath: (p) => ipcRenderer.invoke("open-path", p),
});
