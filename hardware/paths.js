// Where the Hikvision service keeps its files.
//
// It runs inside the Gate Bridge app, whose own folder is read-only once
// installed (and packed into app.asar), so controller records live in the
// user's profile next to the rest of the bridge's state, and the HCNetSDK
// libraries — which Hikvision doesn't let us ship — are looked for in the
// places an installer can put them.
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME_DIR = path.join(os.homedir(), '.villasafe-gate-bridge');

function dataDir() {
  return process.env.VILLASAFE_HW_DATA_DIR || path.join(HOME_DIR, 'hardware');
}

function platformDir() {
  const p = os.platform();
  const a = os.arch();
  if (p === 'win32' && a === 'x64') return 'win-x64';
  if (p === 'linux' && a === 'x64') return 'linux-x64';
  if (p === 'darwin') return a === 'arm64' ? 'mac-arm64' : 'mac-x64';
  return `${p}-${a}`;
}

/** Folders that may hold HCNetSDK for this platform, most specific first. */
function sdkCandidates() {
  const plat = platformDir();
  const list = [];
  if (process.env.HCNETSDK_DIR) list.push(process.env.HCNETSDK_DIR);
  // Dropped in by the guard PC's installer or by hand.
  list.push(path.join(HOME_DIR, 'hcnetsdk', plat));
  // Bundled into a packaged build (electron-builder extraResources).
  if (process.resourcesPath) list.push(path.join(process.resourcesPath, 'hcnetsdk', plat));
  // Running from source: desktop/vendor/hcnetsdk/<platform>.
  list.push(path.join(__dirname, '..', 'vendor', 'hcnetsdk', plat));
  // Where the old standalone hardware-bridge told people to put it.
  if (os.platform() === 'win32') list.push(path.join('C:\\VillaSafe', 'hardware-bridge', 'vendor', 'hcnetsdk', plat));
  return list;
}

/** First candidate that exists, or the preferred location when none do. */
function sdkDir() {
  const list = sdkCandidates();
  return list.find((dir) => {
    try { return fs.statSync(dir).isDirectory(); } catch { return false; }
  }) || path.join(HOME_DIR, 'hcnetsdk', platformDir());
}

module.exports = { HOME_DIR, dataDir, platformDir, sdkCandidates, sdkDir };
