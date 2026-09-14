const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("thrushDesktop", {
  getState: () => ipcRenderer.invoke("desktop:state"),
  configure: (settings) => ipcRenderer.invoke("desktop:configure", settings),
  selectDirectory: () => ipcRenderer.invoke("desktop:directory"),
  restart: () => ipcRenderer.invoke("desktop:restart"),
  openLogs: () => ipcRenderer.invoke("desktop:logs"),
  onState: (callback) => {
    const handler = (_event, state) => callback(state);
    ipcRenderer.on("desktop:state", handler);
    return () => ipcRenderer.removeListener("desktop:state", handler);
  },
});
