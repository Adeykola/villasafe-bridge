// VillaSafe WhatsApp Connector — the desktop app, for Windows and macOS.
//
// Runs the connector (../index.js) in the background on this computer so
// VillaSafe's WhatsApp numbers stay linked to the communications inbox:
//   - one connection per number, as many numbers as needed (each its own copy
//     of the connector, its own WhatsApp login and its own id);
//   - starts when someone signs in to the computer, hidden in the tray (Windows)
//     or the menu bar (Mac), with no admin rights needed;
//   - restarts a connection if it ever stops, and reconnects after the
//     computer wakes up or the internet comes back;
//   - shows each link's status and the QR code to scan;
//   - is set up once with a setup key copied from VillaSafe (Platform overview).
// The same number can also be linked on another computer running this app:
// the two are each other's backup.
// Closing the window keeps it running; Quit in the tray / menu bar stops it.
const { app, BrowserWindow, Tray, Menu, ipcMain, safeStorage, powerMonitor, powerSaveBlocker, shell, nativeImage, dialog } = require('electron');
const { fork } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const QRCode = require('qrcode');

// A separate data folder (for testing, or two copies on one computer): VILLASAFE_USER_DATA=/path.
if (process.env.VILLASAFE_USER_DATA) app.setPath('userData', process.env.VILLASAFE_USER_DATA);

const IS_MAC = process.platform === 'darwin';
const DEVICE_NAME = 'VillaSafe Inbox';
const MAX_LINKS = 6;
const userFile = (name) => path.join(app.getPath('userData'), name);
const ICON = path.join(__dirname, 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
const PLATFORM = { darwin: 'macos', win32: 'windows', linux: 'linux' }[process.platform] || process.platform;
const SYSTEM = IS_MAC ? 'this Mac' : process.platform === 'win32' ? 'Windows' : 'this computer';

let win = null;
let tray = null;
let quitting = false;
let setupNeeded = false;
/** Each link's running connector and what it last said, by link id. */
const runs = new Map();

// ---------------------------------------------------------------------------
// One copy, started when someone signs in

const isFirstInstance = app.requestSingleInstanceLock();
if (!isFirstInstance) app.quit();
else app.on('second-instance', () => showWindow());

// Its own name in Windows' startup list (Electron's default is shared by every
// Electron app, so the Gate Bridge and this app would overwrite each other).
const APP_ID = 'com.villasafe.whatsappconnector';
const STARTUP_NAME = 'VillaSafe WhatsApp Connector';
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

function startAtLogin() {
  if (!app.isPackaged || process.platform === 'linux') return;
  try {
    app.setLoginItemSettings(
      IS_MAC ? { openAtLogin: true } : { openAtLogin: true, openAsHidden: true, name: STARTUP_NAME, args: ['--hidden'] },
    );
  } catch (e) {
    log(`Could not set it to start at sign-in: ${e.message}`);
  }
}

function openedAtLogin() {
  if (process.argv.includes('--hidden')) return true;
  if (!IS_MAC) return false;
  try {
    return !!app.getLoginItemSettings().wasOpenedAtLogin;
  } catch {
    return false;
  }
}

/** The computer's name as people know it: "Office-MacBook.local" → "Office MacBook". */
function computerName() {
  let name = '';
  if (IS_MAC) {
    try {
      name = require('child_process').execFileSync('scutil', ['--get', 'ComputerName'], { encoding: 'utf8', timeout: 2000 }).trim();
    } catch { /* fall back to the host name */ }
  }
  if (!name) name = os.hostname().replace(/\.(local|lan|home)$/i, '').replace(/[-_]+/g, ' ');
  return name.trim().slice(0, 80) || (IS_MAC ? 'Mac' : 'Computer');
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
// Setup key and links, kept on this computer (the secret encrypted)

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

const newLinkId = () => `wa-${crypto.randomBytes(9).toString('base64url')}`;

function readFile() {
  try {
    return JSON.parse(fs.readFileSync(userFile('config.json'), 'utf8'));
  } catch {
    return {};
  }
}

function writeFile(c) {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(userFile('config.json'), JSON.stringify(c));
}

/**
 * The links on this computer. Before 1.1 there was one, logged in under
 * whatsapp-auth/; it carries on as the link 'legacy', which VillaSafe already
 * knows, so nothing has to be scanned again.
 */
function linksOf(c) {
  if (Array.isArray(c.links)) return c.links.filter((l) => l && /^[A-Za-z0-9_-]{4,64}$/.test(l.id) && typeof l.dir === 'string');
  if (fs.existsSync(userFile('whatsapp-auth'))) return [{ id: 'legacy', dir: 'whatsapp-auth' }];
  const id = newLinkId();
  return [{ id, dir: path.join('links', id, 'auth') }];
}

function readConfig() {
  const c = readFile();
  // Settle the links once (an old single link, or a first new one) so their ids never change.
  if (c.url && !Array.isArray(c.links)) {
    c.links = linksOf(c);
    try { writeFile(c); } catch { /* read-only: tried again next time */ }
  }
  try {
    const secret = c.secretEnc && safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(Buffer.from(c.secretEnc, 'base64'))
      : c.secret;
    return c.url && secret ? { url: c.url, secret, links: linksOf(c) } : null;
  } catch {
    return null;
  }
}

function saveKey({ url, secret }) {
  const c = readFile();
  const links = linksOf(c);
  const next = safeStorage.isEncryptionAvailable()
    ? { url, secretEnc: safeStorage.encryptString(secret).toString('base64'), links }
    : { url, secret, links };
  writeFile(next);
}

function saveLinks(links) {
  writeFile({ ...readFile(), links });
}

/** Does VillaSafe accept this key? */
async function checkKey({ url, secret }) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-connector-secret': secret },
      // A check only: no link's status is touched.
      body: JSON.stringify({ action: 'ping' }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error(`Can’t reach VillaSafe from ${SYSTEM}. Check the internet connection and try again.`);
  }
  if (res.status === 401) throw new Error('VillaSafe didn’t accept this setup key. Copy a fresh one from VillaSafe → Platform overview.');
  // 400: a VillaSafe from before "ping" — it took the key, which is all this checks.
  if (!res.ok && res.status !== 400) throw new Error(`VillaSafe answered ${res.status}. Try again in a moment.`);
}

// ---------------------------------------------------------------------------
// The connectors, one per link, kept running

const LABELS = {
  starting: 'Connecting to WhatsApp…',
  qr: 'Scan the QR code to link a number',
  logged_out: 'Unlinked — scan the new QR code',
  restarting: 'Restarting…',
  removing: 'Unlinking…',
  offline: 'Stopped',
};

function labelOf(s) {
  if (s.status === 'connected') return `Linked${s.phone ? ` to +${s.phone}` : ''}`;
  return LABELS[s.status] || s.status;
}

function snapshot() {
  const cfg = readConfig();
  const links = (cfg?.links || []).map((l) => {
    const s = runs.get(l.id)?.state || { status: 'starting' };
    return { id: l.id, ...s, label: labelOf(s) };
  });
  return {
    configured: !!cfg,
    setupNeeded: setupNeeded || !cfg,
    links,
    maxLinks: MAX_LINKS,
    platform: PLATFORM,
    device: computerName(),
    version: app.getVersion(),
    startsAtLogin: app.isPackaged && process.platform !== 'linux',
  };
}

function broadcast() {
  const s = snapshot();
  const linked = s.links.filter((l) => l.status === 'connected').length;
  const waiting = s.links.some((l) => l.status === 'qr' || l.status === 'logged_out');
  const summary = s.setupNeeded
    ? 'Needs its setup key'
    : !s.links.length
      ? 'No numbers linked'
      : `${linked} of ${s.links.length} number${s.links.length === 1 ? '' : 's'} linked${waiting ? ' · a QR code is waiting' : ''}`;
  if (tray) tray.setToolTip(`VillaSafe WhatsApp Connector — ${summary}`);
  if (win && !win.isDestroyed()) win.webContents.send('connector:state', s);
}

function runOf(id) {
  if (!runs.has(id)) runs.set(id, { child: null, timer: null, backoffMs: 2000, state: { status: 'starting', at: Date.now() } });
  return runs.get(id);
}

function setLinkState(id, patch) {
  const run = runOf(id);
  run.state = { ...run.state, ...patch, at: Date.now() };
  broadcast();
}

async function onConnectorMessage(id, m) {
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
  if (m.status === 'logged_out') {
    patch.phone = null;
    patch.name = null;
  }
  setLinkState(id, patch);
}

function startLink(link, cfg) {
  const run = runOf(link.id);
  if (run.child || quitting) return;
  setLinkState(link.id, { status: 'starting', detail: null });
  const startedAt = Date.now();
  const child = fork(path.join(__dirname, '..', 'index.js'), [], {
    cwd: app.getPath('userData'),
    env: {
      ...process.env,
      CONNECTOR_URL: cfg.url,
      CONNECTOR_SECRET: cfg.secret,
      CONNECTOR_ID: link.id,
      AUTH_DIR: userFile(link.dir),
      DEVICE_NAME,
      DEVICE_LABEL: computerName(),
      APP_VERSION: app.getVersion(),
      CONNECTOR_PLATFORM: PLATFORM,
      LOG_LEVEL: 'info',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  run.child = child;
  const tag = `[${link.id}] `;
  child.stdout.on('data', (d) => log(tag + d));
  child.stderr.on('data', (d) => log(tag + d));
  child.on('message', (m) => { onConnectorMessage(link.id, m).catch(() => {}); });
  child.on('exit', (code) => {
    run.child = null;
    if (quitting || run.removing || !readConfig()?.links.some((l) => l.id === link.id)) return;
    // Ran a good while: start again straight away. Failing at once, over and
    // over: wait longer each time, up to a minute.
    run.backoffMs = Date.now() - startedAt > 60_000 ? 2000 : Math.min(run.backoffMs * 2, 60_000);
    log(`${tag}connector stopped (code ${code}); starting again in ${Math.round(run.backoffMs / 1000)} s`);
    setLinkState(link.id, { status: 'restarting', detail: `Starting again in ${Math.round(run.backoffMs / 1000)} s` });
    clearTimeout(run.timer);
    run.timer = setTimeout(() => {
      const now = readConfig();
      const still = now?.links.find((l) => l.id === link.id);
      if (now && still) startLink(still, now);
    }, run.backoffMs);
  });
}

function startAll() {
  const cfg = readConfig();
  if (!cfg) {
    setupNeeded = true;
    broadcast();
    showWindow();
    return;
  }
  setupNeeded = false;
  for (const link of cfg.links) startLink(link, cfg);
  broadcast();
}

/** Stop one connector (it tells VillaSafe it's going offline first). */
function stopLink(id) {
  return new Promise((resolve) => {
    const run = runs.get(id);
    if (!run) return resolve();
    clearTimeout(run.timer);
    if (!run.child) return resolve();
    const c = run.child;
    const done = () => { clearTimeout(force); resolve(); };
    const force = setTimeout(() => { try { c.kill(); } catch { /* gone */ } resolve(); }, 5000);
    c.once('exit', done);
    try { c.send({ type: 'shutdown' }); } catch { c.kill(); }
  });
}

const stopAll = () => Promise.all([...runs.keys()].map(stopLink));

/** After sleep or a new key: a fresh start reconnects in seconds instead of waiting out a dead socket. */
async function restartAll() {
  for (const run of runs.values()) run.backoffMs = 2000;
  await stopAll();
  startAll();
}

async function restartLink(id) {
  const cfg = readConfig();
  const link = cfg?.links.find((l) => l.id === id);
  if (!link) return;
  runOf(id).backoffMs = 2000;
  await stopLink(id);
  startLink(link, cfg);
}

/** Another number on this computer: a new connection that shows its own QR code. */
function addLink() {
  const cfg = readConfig();
  if (!cfg) return { ok: false, error: 'Paste the setup key first.' };
  if (cfg.links.length >= MAX_LINKS) return { ok: false, error: `Up to ${MAX_LINKS} numbers on one computer.` };
  const id = newLinkId();
  const link = { id, dir: path.join('links', id, 'auth') };
  saveLinks([...cfg.links, link]);
  startLink(link, cfg);
  return { ok: true, id };
}

/** Unlink a number from this computer (the phone drops it from Linked devices) and forget its login. */
async function removeLink(id) {
  const cfg = readConfig();
  const link = cfg?.links.find((l) => l.id === id);
  if (!link) return { ok: true };
  const run = runOf(id);
  run.removing = true;
  setLinkState(id, { status: 'removing', qr: null, qrImage: null });
  if (run.child) {
    await new Promise((resolve) => {
      const c = run.child;
      const force = setTimeout(resolve, 8000);
      const onMessage = (m) => { if (m?.type === 'logged_out') { clearTimeout(force); c.off('message', onMessage); resolve(); } };
      c.on('message', onMessage);
      try { c.send({ type: 'logout' }); } catch { clearTimeout(force); resolve(); }
    });
  }
  await stopLink(id);
  runs.delete(id);
  saveLinks(readConfig().links.filter((l) => l.id !== id));
  // Its login, and the id file the connector keeps beside it.
  const authDir = userFile(link.dir);
  const folder = link.dir.startsWith('links') ? path.dirname(authDir) : authDir;
  try { fs.rmSync(folder, { recursive: true, force: true }); } catch { /* already gone */ }
  try { fs.rmSync(`${authDir}.id`, { force: true }); } catch { /* none */ }
  broadcast();
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Window and tray / menu bar

function showWindow() {
  if (!win || win.isDestroyed()) createWindow(true);
  if (IS_MAC) app.dock?.show();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow(show) {
  win = new BrowserWindow({
    width: 560,
    height: 720,
    minWidth: 460,
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
    // On a Mac it lives in the menu bar; the Dock icon goes with the window.
    if (IS_MAC) app.dock?.hide();
  });
}

function trayImage() {
  const image = nativeImage.createFromPath(ICON);
  if (!IS_MAC || image.isEmpty()) return image;
  return image.resize({ width: 18, height: 18, quality: 'best' });
}

function createTray() {
  try {
    tray = new Tray(trayImage());
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open VillaSafe WhatsApp Connector', click: showWindow },
      { label: 'Restart connections', click: () => { restartAll(); } },
      { type: 'separator' },
      { label: 'Quit (WhatsApp stops reaching the inbox from here)', click: () => { quitting = true; app.quit(); } },
    ]));
    if (!IS_MAC) tray.on('click', showWindow);
  } catch (e) {
    log(`No tray icon: ${e.message}`);
  }
}

ipcMain.handle('connector:get', () => snapshot());
ipcMain.handle('connector:setKey', async (_e, raw) => {
  const cfg = parseSetupKey(raw);
  if (!cfg) return { ok: false, error: 'That isn’t a setup key. Copy it from VillaSafe → Platform overview → WhatsApp connector.' };
  try {
    await checkKey(cfg);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  saveKey(cfg);
  await restartAll();
  return { ok: true };
});
ipcMain.handle('connector:restart', async (_e, id) => {
  if (id) await restartLink(id);
  else await restartAll();
  return { ok: true };
});
ipcMain.handle('connector:add', () => addLink());
ipcMain.handle('connector:remove', async (_e, id) => {
  const s = runs.get(id)?.state;
  const which = s?.phone ? `+${s.phone}` : 'this connection';
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Unlink', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    message: `Unlink ${which} from ${SYSTEM}?`,
    detail: 'It disappears from Linked devices on the phone. Other computers linked to the same number keep working. To link it here again, add a number and scan a new code.',
  });
  if (response !== 0) return { ok: false, cancelled: true };
  return removeLink(id);
});
ipcMain.handle('connector:openLog', () => shell.openPath(app.getPath('userData')));

// ---------------------------------------------------------------------------

app.whenReady().then(() => {
  if (!isFirstInstance) return;
  startAtLogin();
  // Keep running while the window is hidden (and stop the computer idling to sleep).
  powerSaveBlocker.start('prevent-app-suspension');
  createTray();
  const hidden = openedAtLogin();
  createWindow(!hidden);
  if (IS_MAC && hidden) app.dock?.hide();
  startAll();
  powerMonitor.on('resume', () => { log('woke from sleep — reconnecting'); restartAll(); });
});

// Clicking the Dock icon brings the window back.
app.on('activate', () => showWindow());

app.on('before-quit', async (e) => {
  if (![...runs.values()].some((r) => r.child)) return;
  e.preventDefault();
  quitting = true;
  await stopAll();
  app.quit();
});

app.on('window-all-closed', () => {
  if (!tray && !IS_MAC) { quitting = true; app.quit(); }
});
