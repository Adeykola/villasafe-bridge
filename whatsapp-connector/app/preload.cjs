const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('connector', {
  get: () => ipcRenderer.invoke('connector:get'),
  setKey: (key) => ipcRenderer.invoke('connector:setKey', key),
  restart: () => ipcRenderer.invoke('connector:restart'),
  openLog: () => ipcRenderer.invoke('connector:openLog'),
  onState: (fn) => ipcRenderer.on('connector:state', (_e, s) => fn(s)),
});
