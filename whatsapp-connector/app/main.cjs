// VillaSafe WhatsApp Connector — the desktop app.
//
// Runs the connector (../index.js) in the background on this PC so VillaSafe's
// WhatsApp number stays linked to the communications inbox:
//   - starts with Windows, hidden in the tray, with no admin rights needed;
//   - restarts the connector if it ever stops, and reconnects after the
//     laptop wakes up or the internet comes back;
//   - shows the link status and the QR code to scan;
//   - is set up once with a setup key copied from VillaSafe (Platform overview).
// Closing the window keeps it running; Quit in the tray menu stops it.
const { app, BrowserWindow, Tray, Menu, ipcMain, safeStorage, powerMonitor, powerSaveBlocker, shell } = require('electron');
const { fork } = require('child_process');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');

const DEVICE_NAME = 'VillaSafe Inbox';
const startedHidden = process.argv.includes('--hidden');
const userFile = (name) => path.join(app.getPath('userData'), name);
const ICON = path.join(__dirname, 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png');

let win = null;
let tray = null;
let child = null;
let quitting = false;
let restartTimer = null;
let backoffMs = 2000;
let state = { status: 'setup', detail: null, qr: null, qrImage: null, phone: null, name: null, at: Date.now() };

// ---------------------------------------------------------------------------
// One copy, started with Windows

const isFirstInstance = app.requestSingleInstanceLock();
if (!isFirstInstance) app.quit();
else app.on('second-instance', () => showWindow());

// Its own name in Windows' startup list (Electron's default is shared by every
// Electron app, so the Gate Bridge and this app would overwrite each other).
const APP_ID = 'com.villasafe.whatsappconnector';
const STARTUP_NAME = 'VillaSafe WhatsApp Connector';
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

function startWithWindows() {
  if (!app.isPackaged || process.platform === 'linux') return;
  try {
    app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true, name: STARTUP_NAME, args: ['--hidden'] });
  } catch (e) {
    log(`Could not set it to start with Windows: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Log (kept small)

function log(line) {
  try {
    const file = userFile('connector.log');
    if (fs.existsSync(file) && fs.statSync(file).size > 2 * 1024 * 1024) fs.renameSync(file, `${file}.old`);
    fs.appendFileSync(file, `${new Date().toISOString()} ${String(line).trimEnd()}\n`);
  } catch { /* nowhere to write */ }
}

// ---------------------------------------------------------------------------
// Setup key: where VillaSafe is and the shared secret, kept encrypted on this PC

function parseSetupKey(raw) {
  const m = String(raw || '').trim().match(/^VSWA1\.([A-Za-z0-9_-]+)$/);
  if (!m) return null;
  try {
    const o = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8'));
    return o && /^https:\/\//.test(o.u) && o.s ? { url: o.u, secret: String(o.s) } : null;
  } catch {
    return null;
  }
}

function readConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(userFile('config.json'), 'utf8'));
    const secret = c.secretEnc && safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(Buffer.from(c.secretEnc, 'base64'))
      : c.secret;
    return c.url && secret ? { url: c.url, secret } : null;
  } catch {
    return null;
  }
}

function saveConfig({ url, secret }) {
  const c = safeStorage.isEncryptionAvailable()
    ? { url, secretEnc: safeStorage.encryptString(secret).toString('base64') }
    : { url, secret };
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(userFile('config.json'), JSON.stringify(c));
}

/** Does VillaSafe accept this key? */
async function checkKey({ url, secret }) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-connector-secret': secret },
      body: JSON.stringify({ action: 'state', status: 'starting' }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error('Can’t reach VillaSafe from this PC. Check the internet connection and try again.');
  }
  if (res.status === 401) throw new Error('VillaSafe didn’t accept this setup key. Copy a fresh one from VillaSafe → Platform overview.');
  if (!res.ok) throw new Error(`VillaSafe answered ${res.status}. Try again in a moment.`);
}

// ---------------------------------------------------------------------------
// The connector, kept running

function setState(patch) {
  state = { ...state, ...patch, at: Date.now() };
  const label = {
    setup: 'Needs its setup key',
    starting: 'Connecting to WhatsApp…',
    qr: 'Scan the QR code to link WhatsApp',
    connected: `Linked${state.phone ? ` to +${state.phone}` : ''}`,
    logged_out: 'Unlinked — scan the new QR code',
    restarting: 'Restarting…',
    offline: 'Stopped',
  }[state.status] || state.status;
  if (tray) tray.setToolTip(`VillaSafe WhatsApp Connector — ${label}`);
  if (win && !win.isDestroyed()) win.webContents.send('connector:state', { ...state, label });
}

async function onConnectorMessage(m) {
  if (!m || m.type !== 'state') return;
  const patch = { status: m.status, detail: null };
  if (m.status === 'qr' && m.qr) {
    patch.qr = m.qr;
    patch.qrImage = await QRCode.toDataURL(m.qr, { margin: 1, width: 280 }).catch(() => null);
  } else {
    patch.qr = null;
    patch.qrImage = null;
  }
  if (m.status === 'connected') {
    patch.phone = m.phone || null;
    patch.name = m.display_name || null;
  }
  setState(patch);
}

function startConnector() {
  if (child || quitting) return;
  const cfg = readConfig();
  if (!cfg) {
    setState({ status: 'setup' });
    showWindow();
    return;
  }
  setState({ status: 'starting', detail: null });
  const startedAt = Date.now();
  child = fork(path.join(__dirname, '..', 'index.js'), [], {
    cwd: app.getPath('userData'),
    env: {
      ...process.env,
      CONNECTOR_URL: cfg.url,
      CONNECTOR_SECRET: cfg.secret,
      AUTH_DIR: userFile('whatsapp-auth'),
      DEVICE_NAME,
      LOG_LEVEL: 'info',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.stdout.on('data', (d) => log(d));
  child.stderr.on('data', (d) => log(d));
  child.on('message', (m) => { onConnectorMessage(m).catch(() => {}); });
  child.on('exit', (code) => {
    child = null;
    if (quitting) return;
    // Ran a good while: start again straight away. Failing at once, over and
    // over: wait longer each time, up to a minute.
    backoffMs = Date.now() - startedAt > 60_000 ? 2000 : Math.min(backoffMs * 2, 60_000);
    log(`connector stopped (code ${code}); starting again in ${Math.round(backoffMs / 1000)} s`);
    setState({ status: 'restarting', detail: `Starting again in ${Math.round(backoffMs / 1000)} s` });
    clearTimeout(restartTimer);
    restartTimer = setTimeout(startConnector, backoffMs);
  });
}

/** Stop the connector (it tells VillaSafe it's going offline first). */
function stopConnector() {
  return new Promise((resolve) => {
    clearTimeout(restartTimer);
    if (!child) return resolve();
    const c = child;
    const done = () => { clearTimeout(force); resolve(); };
    const force = setTimeout(() => { try { c.kill(); } catch { /* gone */ } resolve(); }, 5000);
    c.once('exit', done);
    try { c.send({ type: 'shutdown' }); } catch { c.kill(); }
  });
}

/** After sleep: a fresh start reconnects in seconds instead of waiting out a dead socket. */
async function restartConnector() {
  backoffMs = 2000;
  await stopConnector();
  startConnector();
}

// ---------------------------------------------------------------------------
// Window and tray

function showWindow() {
  if (!win || win.isDestroyed()) createWindow(true);
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow(show = !startedHidden) {
  win = new BrowserWindow({
    width: 520,
    height: 680,
    minWidth: 440,
    minHeight: 560,
    show,
    backgroundColor: '#060a14',
    autoHideMenuBar: true,
    title: 'VillaSafe WhatsApp Connector',
    icon: ICON,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  win.on('close', (e) => {
    if (quitting || !tray) return;
    e.preventDefault();
    win.hide();
  });
}

function createTray() {
  try {
    tray = new Tray(ICON);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open VillaSafe WhatsApp Connector', click: showWindow },
      { label: 'Restart connection', click: () => { restartConnector(); } },
      { type: 'separator' },
      { label: 'Quit (WhatsApp stops reaching the inbox)', click: () => { quitting = true; app.quit(); } },
    ]));
    tray.on('click', showWindow);
  } catch (e) {
    log(`No tray icon: ${e.message}`);
  }
}

ipcMain.handle('connector:get', () => ({ ...state, configured: !!readConfig(), startsWithWindows: app.isPackaged && process.platform !== 'linux' }));
ipcMain.handle('connector:setKey', async (_e, raw) => {
  const cfg = parseSetupKey(raw);
  if (!cfg) return { ok: false, error: 'That isn’t a setup key. Copy it from VillaSafe → Platform overview → WhatsApp connector.' };
  try {
    await checkKey(cfg);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  saveConfig(cfg);
  await restartConnector();
  return { ok: true };
});
ipcMain.handle('connector:restart', async () => { await restartConnector(); return { ok: true }; });
ipcMain.handle('connector:openLog', () => shell.openPath(app.getPath('userData')));

// ---------------------------------------------------------------------------

app.whenReady().then(() => {
  if (!isFirstInstance) return;
  startWithWindows();
  // Keep running while the window is hidden.
  powerSaveBlocker.start('prevent-app-suspension');
  createTray();
  createWindow();
  startConnector();
  powerMonitor.on('resume', () => { log('woke from sleep — reconnecting'); restartConnector(); });
});

app.on('before-quit', async (e) => {
  if (!child) return;
  e.preventDefault();
  quitting = true;
  await stopConnector();
  app.quit();
});

app.on('window-all-closed', () => {
  if (!tray && process.platform !== 'darwin') { quitting = true; app.quit(); }
});
