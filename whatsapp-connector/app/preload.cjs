const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('connector', {
  get: () => ipcRenderer.invoke('connector:get'),
  setKey: (key) => ipcRenderer.invoke('connector:setKey', key),
  /** One link by id, or every link. */
  restart: (id) => ipcRenderer.invoke('connector:restart', id),
  add: () => ipcRenderer.invoke('connector:add'),
  remove: (id) => ipcRenderer.invoke('connector:remove', id),
  openLog: () => ipcRenderer.invoke('connector:openLog'),
  onState: (fn) => ipcRenderer.on('connector:state', (_e, s) => fn(s)),
});
