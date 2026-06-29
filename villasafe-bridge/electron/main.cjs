const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const Store = require('./config/laneStore.cjs');
const {
  startBridge, stopBridge, getStatus,
  runCommandLocal, runDeviceLocal, getLanes, refreshDeviceHealth,
} = require('./bridge/commandRunner.cjs');
const { pairWithCode } = require('./bridge/pairing.cjs');
const { previewPairing } = require('./bridge/pairing.cjs');
const signedLog = require('./bridge/signedLog.cjs');
const { startAnprServer } = require('./bridge/anprServer.cjs');
const scheduler = require('./bridge/scheduler.cjs');
const diagnostics = require('./bridge/diagnostics.cjs');
const offlineQueue = require('./bridge/offlineQueue.cjs');

let win;

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    icon: path.join(__dirname, '..', 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'ui', 'index.html'));
}

app.whenReady().then(async () => {
  createWindow();
  const store = Store.load();
  if (store.bridgeId && store.tenantId && store.bridgeToken) {
    startBridge(store, (evt) => win?.webContents.send('bridge:event', evt));
    startAnprServer(store, 8765, (evt) => win?.webContents.send('bridge:event', evt));
    scheduler.start(getLanes, runCommandLocal, (m) => { diagnostics.log(m); win?.webContents.send('bridge:event', { action: 'schedule', success: true, details: m }); });
  }
});

ipcMain.handle('config:get', () => Store.load());
ipcMain.handle('config:setGateway', (_e, { gatewayUrl }) => {
  if (!gatewayUrl || !/^https?:\/\//i.test(gatewayUrl)) {
    return { ok: false, error: 'Gateway URL must start with http(s)://' };
  }
  Store.update({ gatewayUrl: gatewayUrl.replace(/\/$/, '') });
  return { ok: true };
});
ipcMain.handle('bridge:previewPair', async (_e, { code }) => {
  const cfg = Store.load();
  if (!cfg.gatewayUrl) return { ok: false, error: 'Gateway URL missing — reinstall the bridge.' };
  return previewPairing(cfg.gatewayUrl, code);
});
ipcMain.handle('bridge:pair', async (_e, { code }) => {
  const cfg = Store.load();
  if (!cfg.gatewayUrl) {
    return { ok: false, error: 'Gateway URL missing — reinstall the bridge.' };
  }
  const publicKey = signedLog.publicKey();
  const result = await pairWithCode(cfg.gatewayUrl, code, publicKey);
  if (result.ok) {
    Store.update({
      bridgeId: result.bridgeId,
      tenantId: result.tenantId,
      bridgeToken: result.bridgeToken,
      tenantName: result.tenantName,
      tokenExpiresAt: result.tokenExpiresAt,
      pairedLanes: result.lanes,
      pairingCode: code, // cache for self-healing heartbeat re-pair
    });
    startBridge(Store.load(), (evt) => win?.webContents.send('bridge:event', evt));
    startAnprServer(Store.load(), 8765, (evt) => win?.webContents.send('bridge:event', evt));
  }
  return result;
});
ipcMain.handle('bridge:status', () => getStatus());
ipcMain.handle('bridge:runLocal', async (_e, { laneId, action }) => runCommandLocal(laneId, action));
ipcMain.handle('bridge:runDevice', async (_e, { laneId, deviceIndex, action }) => runDeviceLocal(laneId, deviceIndex, action));
ipcMain.handle('bridge:diagnose', async () => {
  const cfg = Store.load();
  return diagnostics.runFull(cfg, getLanes());
});
ipcMain.handle('bridge:logs', () => diagnostics.getLogs());
ipcMain.handle('bridge:queueSize', () => offlineQueue.size());
ipcMain.handle('bridge:refreshHealth', () => refreshDeviceHealth());
ipcMain.handle('bridge:verifyLog', () => signedLog.verify());
ipcMain.handle('bridge:tailLog', (_e, n) => signedLog.tail(n || 200));
ipcMain.handle('bridge:publicKey', () => signedLog.publicKey());
ipcMain.handle('bridge:unpair', () => {
  stopBridge();
  scheduler.stop();
  Store.update({ bridgeId: null, tenantId: null, bridgeToken: null, pairingCode: null, tokenExpiresAt: null });
  return Store.load();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});