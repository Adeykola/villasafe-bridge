const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setGateway: (gatewayUrl) => ipcRenderer.invoke('config:setGateway', { gatewayUrl }),
  previewPair: (code) => ipcRenderer.invoke('bridge:previewPair', { code }),
  pair: (code) => ipcRenderer.invoke('bridge:pair', { code }),
  unpair: () => ipcRenderer.invoke('bridge:unpair'),
  status: () => ipcRenderer.invoke('bridge:status'),
  runLocal: (laneId, action) => ipcRenderer.invoke('bridge:runLocal', { laneId, action }),
  runDevice: (laneId, deviceIndex, action) => ipcRenderer.invoke('bridge:runDevice', { laneId, deviceIndex, action }),
  diagnose: () => ipcRenderer.invoke('bridge:diagnose'),
  logs: () => ipcRenderer.invoke('bridge:logs'),
  queueSize: () => ipcRenderer.invoke('bridge:queueSize'),
  refreshHealth: () => ipcRenderer.invoke('bridge:refreshHealth'),
  verifyLog: () => ipcRenderer.invoke('bridge:verifyLog'),
  tailLog: (n) => ipcRenderer.invoke('bridge:tailLog', n),
  publicKey: () => ipcRenderer.invoke('bridge:publicKey'),
  onEvent: (cb) => ipcRenderer.on('bridge:event', (_e, evt) => cb(evt)),
});