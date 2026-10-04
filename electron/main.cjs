const { app, BrowserWindow, ipcMain, powerSaveBlocker, Tray, Menu } = require('electron');
const path = require('path');
const crypto = require('crypto');
const Store = require('./config/laneStore.cjs');
const {
  startBridge, stopBridge, getStatus,
  runCommandLocal, runDeviceLocal, getLanes, refreshDeviceHealth, isOnline, isLicensed,
} = require('./bridge/commandRunner.cjs');
const hikvision = require('./drivers/hikvision.cjs');
const lanGate = require('./bridge/lanGate.cjs');
const lanReach = require('./bridge/lanReach.cjs');
const tagStore = require('./bridge/tagStore.cjs');
const { BRIDGE_VERSION } = require('./bridge/pairing.cjs');

/** Local network API so guard devices can scan and open lanes without internet. */
function startLanGate(cfg) {
  lanGate.start(cfg, {
    getLanes,
    openLane: runCommandLocal,
    isOnline,
    isLicensed,
    version: BRIDGE_VERSION,
    onEvent: (evt) => win?.webContents.send('bridge:event', evt),
  });
}
const { pairWithCode, activateLicense } = require('./bridge/pairing.cjs');
const { previewPairing } = require('./bridge/pairing.cjs');
const signedLog = require('./bridge/signedLog.cjs');
const { startAnprServer } = require('./bridge/anprServer.cjs');
const scheduler = require('./bridge/scheduler.cjs');
const diagnostics = require('./bridge/diagnostics.cjs');
const offlineQueue = require('./bridge/offlineQueue.cjs');

let win;
let tray = null;
let quitting = false;

// The gate PC runs one bridge, all the time. It starts with Windows (after a
// power cut or restart, with or without internet) and keeps running in the
// background when its window is closed — the tray icon reopens or quits it.
const startedHidden = process.argv.includes('--hidden');
const isFirstInstance = app.requestSingleInstanceLock();
if (!isFirstInstance) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
}

function startWithWindows() {
  if (!app.isPackaged || process.platform === 'linux') return;
  try {
    app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true, args: ['--hidden'] });
  } catch (e) {
    diagnostics.log(`Could not set the bridge to start with Windows: ${e.message}`);
  }
}

function showWindow() {
  if (!win || win.isDestroyed()) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createTray() {
  if (tray) return;
  try {
    tray = new Tray(path.join(__dirname, '..', 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png'));
    tray.setToolTip('VillaSafe Gate Bridge — running');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open VillaSafe Gate Bridge', click: showWindow },
      { type: 'separator' },
      { label: 'Quit (gates stop opening automatically)', click: () => { quitting = true; app.quit(); } },
    ]));
    tray.on('click', showWindow);
  } catch (e) {
    diagnostics.log(`No tray icon: ${e.message}`);
  }
}

// The Hikvision (HCNetSDK) service used to be a separate program. It now runs
// in this process on loopback, on its own port (the LAN gate owns 8787), with a
// token minted per launch so nothing else on the PC can drive the doors.
const HARDWARE_PORTS = [8788, 8789, 8790, 8791, 8792];
let hardwareServer = null;
let hardwareError = null;

async function startHardwareService() {
  let hardware;
  try {
    hardware = require('../hardware/app.js');
  } catch (e) {
    hardwareError = `could not load: ${e.message}`;
    hikvision.configure({ error: hardwareError });
    diagnostics.log(`Hikvision service ${hardwareError}`);
    return;
  }
  const token = crypto.randomBytes(24).toString('hex');
  for (const port of HARDWARE_PORTS) {
    try {
      hardwareServer = await hardware.start({ port, host: '127.0.0.1', token });
      hardwareError = null;
      hikvision.configure({ host: '127.0.0.1', port, token });
      diagnostics.log(`Hikvision service ready on 127.0.0.1:${port}`);
      return;
    } catch (e) {
      hardwareError = `port ${port}: ${e.code || e.message}`;
    }
  }
  hikvision.configure({ error: hardwareError });
  diagnostics.log(`Hikvision service did not start (${hardwareError})`);
}

function createWindow() {
  win = new BrowserWindow({
    show: !startedHidden,
    width: 1180,
    height: 800,
    minWidth: 880,
    minHeight: 620,
    backgroundColor: '#060a14',
    autoHideMenuBar: true,
    title: 'VillaSafe Gate Bridge',
    icon: path.join(__dirname, '..', 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'ui', 'index.html'));
  // Closing the window keeps the bridge (and the gates) running in the background.
  win.on('close', (e) => {
    if (quitting || !tray) return;
    e.preventDefault();
    win.hide();
  });
}

app.whenReady().then(async () => {
  if (!isFirstInstance) return; // the running bridge shows its window instead
  startWithWindows();
  createTray();
  createWindow();
  // A gate PC must stay reachable: no system sleep while the bridge runs
  // (the screen may still turn off). Matters most on Wi-Fi laptops.
  powerSaveBlocker.start('prevent-app-suspension');
  await startHardwareService();
  const store = Store.load();
  if (store.bridgeId && store.tenantId && store.bridgeToken) {
    startBridge(store, (evt) => win?.webContents.send('bridge:event', evt));
    startAnprServer(store, 8765, (evt) => win?.webContents.send('bridge:event', evt));
    startLanGate(store);
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
ipcMain.handle('bridge:pair', async (_e, { code, licenseKey }) => {
  const cfg = Store.load();
  if (!cfg.gatewayUrl) {
    return { ok: false, error: 'Gateway URL missing — reinstall the bridge.' };
  }
  const publicKey = signedLog.publicKey();
  const result = await pairWithCode(cfg.gatewayUrl, code, publicKey, licenseKey);
  if (result.ok) {
    Store.update({
      licenseKey,
      licenseLock: null,
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
    startLanGate(Store.load());
  }
  return result;
});
ipcMain.handle('bridge:activateLicense', async (_e, { licenseKey }) => {
  const cfg = Store.load();
  if (!cfg.bridgeId || !cfg.bridgeToken) return { ok: false, error: 'Pair this PC first.' };
  const result = await activateLicense(cfg.gatewayUrl, {
    bridgeId: cfg.bridgeId, bridgeToken: cfg.bridgeToken, licenseKey,
  });
  if (result.ok) {
    Store.update({ licenseKey, licenseLock: null });
    // Restart the loop so the lock clears straight away.
    startBridge(Store.load(), (evt) => win?.webContents.send('bridge:event', evt));
  }
  return result;
});
ipcMain.handle('hardware:status', async () => {
  const h = await hikvision.bridgeHealth();
  return { running: !!hardwareServer && h.reachable, error: hardwareError, sdk: h.body?.sdk || null };
});
ipcMain.handle('hardware:reloadSdk', async () => {
  try { return { ok: true, ...(await hikvision.bridgeRequest('POST', '/api/sdk/reload', {})) }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('lan:firewall', (_e, opts) => lanReach.firewallStatus(opts || {}));
ipcMain.handle('lan:allowPhones', () => lanReach.allowGuardPhones());
ipcMain.handle('app:version', () => app.getVersion());
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
  lanGate.stop();
  scheduler.stop();
  tagStore.clear();
  Store.update({
    bridgeId: null, tenantId: null, bridgeToken: null, pairingCode: null, tokenExpiresAt: null,
    licenseKey: null, licenseLock: null,
  });
  return Store.load();
});

app.on('before-quit', () => {
  quitting = true;
  try { require('../hardware/app.js').stop(hardwareServer); } catch { /* noop */ }
});

app.on('window-all-closed', () => {
  // With a tray icon the bridge keeps running; without one, closing quits.
  if (!tray && process.platform !== 'darwin') app.quit();
});