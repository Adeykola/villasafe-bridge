const { app, BrowserWindow, ipcMain, powerSaveBlocker, Tray, Menu, dialog, session } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
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
const registry = require('./bridge/registry.cjs');
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
const sdkInstaller = require('./bridge/sdkInstaller.cjs');

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

// Its own name in Windows' startup list. Electron's default name is shared by
// every Electron app (1.2.5 used it), so another VillaSafe app on the same PC —
// the WhatsApp connector — would replace the bridge's entry.
const APP_ID = 'com.villasafe.gatebridge';
const STARTUP_NAME = 'VillaSafe Gate Bridge';
const SHARED_STARTUP_NAME = 'electron.app.Electron';
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

function startWithWindows() {
  if (!app.isPackaged || process.platform === 'linux') return;
  try {
    app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true, name: STARTUP_NAME, args: ['--hidden'] });
  } catch (e) {
    diagnostics.log(`Could not set the bridge to start with Windows: ${e.message}`);
  }
  if (process.platform !== 'win32') return;
  // Remove the shared-name entry 1.2.5 wrote, but only if it starts this bridge.
  const RUN = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
  execFile('reg', ['query', RUN, '/v', SHARED_STARTUP_NAME], (err, out) => {
    if (err || !String(out).toLowerCase().includes(process.execPath.toLowerCase())) return;
    execFile('reg', ['delete', RUN, '/v', SHARED_STARTUP_NAME, '/f'], () => {});
  });
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

// ---------- Hikvision SDK, installed from Hikvision's own download ----------
// Hikvision only hands the SDK zip to someone who clicks Download on its page,
// so the bridge opens that page in a window of its own. The person clicks
// Download and accepts Hikvision's terms; the bridge catches the file and
// installs it (sdkInstaller), then loads it without a restart.
let sdkWindow = null;
let sdkBusy = false;
const sendSdk = (p) => { if (win && !win.isDestroyed()) win.webContents.send('sdk:progress', p); };
const isHikvisionUrl = (u) => {
  try {
    const { protocol, hostname } = new URL(u);
    return protocol === 'https:' && (hostname === 'hikvision.com' || hostname.endsWith('.hikvision.com'));
  } catch { return false; }
};

async function installSdkZip(file) {
  if (sdkBusy) return { ok: false, error: 'The SDK is already being installed.' };
  const h = await hikvision.bridgeHealth();
  if (h.body?.sdk?.loaded) return { ok: true, alreadyLoaded: true, sdk: h.body.sdk };
  sdkBusy = true;
  try {
    sendSdk({ stage: 'installing', done: 0, total: 0 });
    let last = 0;
    const r = await sdkInstaller.installFromZip(file, {
      onProgress: ({ done, total }) => {
        if (Date.now() - last < 250 && done < total) return;
        last = Date.now();
        sendSdk({ stage: 'installing', done, total });
      },
    });
    diagnostics.log(`Hikvision SDK${r.version ? ` ${r.version}` : ''} installed into ${r.folder} (${r.files} files)`);
    let reload;
    try { reload = await hikvision.bridgeRequest('POST', '/api/sdk/reload', { afterInstall: true }); }
    catch (e) { reload = { error: e.message }; }
    const loaded = !!reload?.sdk?.loaded;
    const result = {
      ok: loaded, installed: true, version: r.version, folder: r.folder, sdk: reload?.sdk || null,
      error: loaded ? null
        : `The SDK is installed but didn't load (${reload?.sdk?.lastError?.message || reload?.error || 'unknown error'}). Quit the bridge from its tray icon and open it again.`,
    };
    // Lanes stop saying "SDK not loaded" straight away.
    if (loaded) Promise.resolve().then(refreshDeviceHealth).catch(() => {});
    sendSdk({ stage: loaded ? 'done' : 'error', ...result });
    return result;
  } catch (e) {
    const error = e instanceof sdkInstaller.SdkInstallError ? e.message : `Couldn't install the SDK: ${e.message}`;
    diagnostics.log(`Hikvision SDK install failed: ${error}`);
    sendSdk({ stage: 'error', error });
    return { ok: false, error };
  } finally {
    sdkBusy = false;
  }
}

function onSdkDownload(_e, item) {
  const name = item.getFilename();
  if (!/\.zip$/i.test(name)) {
    item.cancel();
    sendSdk({ stage: 'error', error: `That download (${name}) isn't the SDK zip. Click Download next to "Device Network SDK_Win64".` });
    return;
  }
  const dir = sdkInstaller.downloadsDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, path.basename(name));
  item.setSavePath(file);
  // Hikvision's page has done its part; the download carries on in the background.
  if (sdkWindow && !sdkWindow.isDestroyed()) sdkWindow.hide();
  showWindow();
  sendSdk({ stage: 'downloading', done: 0, total: item.getTotalBytes(), name });
  let last = 0;
  item.on('updated', (_ev, state) => {
    if (state !== 'progressing' || Date.now() - last < 300) return;
    last = Date.now();
    sendSdk({ stage: 'downloading', done: item.getReceivedBytes(), total: item.getTotalBytes(), name });
  });
  item.once('done', async (_ev, state) => {
    if (sdkWindow && !sdkWindow.isDestroyed()) sdkWindow.close();
    if (state !== 'completed') {
      sendSdk({ stage: 'error', error: state === 'cancelled' ? 'The SDK download was cancelled.' : 'The SDK download stopped before it finished. Check the internet and try again.' });
      return;
    }
    diagnostics.log(`Hikvision SDK downloaded: ${file}`);
    await installSdkZip(file);
  });
}

function openSdkDownload() {
  const page = sdkInstaller.PAGE_URL[process.platform];
  if (!page) return { ok: false, error: 'Download the Hikvision SDK for this computer from hikvision.com, then use "Install from a zip file".' };
  if (sdkWindow && !sdkWindow.isDestroyed()) { sdkWindow.show(); sdkWindow.focus(); return { ok: true }; }
  const ses = session.fromPartition('persist:hikvision-sdk');
  if (!ses.listenerCount('will-download')) ses.on('will-download', onSdkDownload);
  sdkWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    parent: win || undefined,
    autoHideMenuBar: true,
    title: 'Hikvision SDK: click Download, then accept Hikvision\'s terms. The bridge installs it for you.',
    icon: path.join(__dirname, '..', 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    webPreferences: { session: ses, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  // Keep the instruction in the title bar instead of Hikvision's page title.
  sdkWindow.on('page-title-updated', (e) => e.preventDefault());
  // Stay on hikvision.com. Its Download button may open the file in a new
  // window; download it here instead.
  sdkWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isHikvisionUrl(url)) {
      if (/\.zip$/i.test(new URL(url).pathname)) sdkWindow.webContents.downloadURL(url);
      else sdkWindow.loadURL(url);
    }
    return { action: 'deny' };
  });
  sdkWindow.webContents.on('will-navigate', (e, url) => { if (!isHikvisionUrl(url)) e.preventDefault(); });
  sdkWindow.on('closed', () => { sdkWindow = null; });
  sdkWindow.loadURL(page);
  return { ok: true };
}

/** An SDK zip already on this PC, from the bridge's own downloads or the user's. */
const findSdkZip = () => sdkInstaller.findDownloadedZip([sdkInstaller.downloadsDir(), app.getPath('downloads')]);

ipcMain.handle('sdk:find', () => findSdkZip());
ipcMain.handle('sdk:openDownload', () => openSdkDownload());
ipcMain.handle('sdk:installZip', async (_e, { useFound = false } = {}) => {
  let file = null;
  if (useFound) {
    file = findSdkZip()?.file || null;
    if (!file) return { ok: false, error: 'The SDK zip is no longer in Downloads.' };
  } else {
    const pick = await dialog.showOpenDialog(win, {
      title: 'Choose the Hikvision SDK zip',
      buttonLabel: 'Install',
      filters: [{ name: 'Zip files', extensions: ['zip'] }],
      properties: ['openFile'],
    });
    if (pick.canceled || !pick.filePaths.length) return { ok: false, cancelled: true };
    file = pick.filePaths[0];
  }
  return installSdkZip(file);
});
ipcMain.handle('lan:firewall', (_e, opts) => lanReach.firewallStatus(opts || {}));
ipcMain.handle('lan:allowPhones', () => lanReach.allowGuardPhones());
ipcMain.handle('app:version', () => app.getVersion());
// Registered page: the tags on this PC, and what each Hikvision device holds.
ipcMain.handle('tags:list', () => ({ tags: registry.tagRows(tagStore.tags(), getLanes()), savedAt: tagStore.savedAt() }));
ipcMain.handle('devices:read', async () => {
  try { return { ok: true, ...(await registry.readDevices(getLanes(), tagStore.effective())) }; }
  catch (e) { return { ok: false, error: e.message }; }
});
// Offline page: the guest passes on this PC, and taking finished ones off it.
ipcMain.handle('lan:passes', () => lanGate.listPasses());
ipcMain.handle('lan:removePasses', (_e, { ids } = {}) => ({ removed: lanGate.removeFinished(ids) }));
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