// Installs Hikvision's HCNetSDK on this PC from the zip Hikvision gives out.
//
// Hikvision doesn't let VillaSafe ship the SDK, and its download server only
// hands the zip to a person who clicks Download on Hikvision's own page. So
// the person downloads it (in the bridge's Hikvision window, or in a browser,
// or from a USB stick) and this does the rest: it finds the folder in the zip
// that holds the SDK library — the zip is mostly demos and documents — and
// unpacks just that folder, with HCNetSDKCom\ and everything else beside the
// library, into ~/.villasafe-gate-bridge/hcnetsdk/<platform>/, the first place
// the Hikvision service looks. Nothing is downloaded here.
const fs = require('fs');
const path = require('path');
const yauzl = require('yauzl');
const { HOME_DIR, platformDir } = require('../../hardware/paths.js');

const LIB_NAME = { win32: 'HCNetSDK.dll', linux: 'libhcnetsdk.so', darwin: 'libhcnetsdk.dylib' };
const CORE_NAME = { win32: 'HCCore.dll', linux: 'libHCCore.so', darwin: 'libHCCore.dylib' };
// What Hikvision calls the zip for each platform (EN-HCNetSDKV6.1.11.40_build20260922_win64.zip).
const ZIP_PATTERN = { win32: /hcnetsdk.*win64.*\.zip$/i, linux: /hcnetsdk.*linux64.*\.zip$/i, darwin: /hcnetsdk.*\.zip$/i };
const PAGE_URL = {
  win32: 'https://www.hikvision.com/en/support/tools/hitools/clc33f9cd4117c753a/',
};
// The library folder is a few hundred MB at most; anything far bigger isn't it.
const MAX_BYTES = 1536 * 1024 * 1024;
const MAX_FILES = 5000;

const targetDir = (plat = platformDir()) => path.join(HOME_DIR, 'hcnetsdk', plat);
const downloadsDir = () => path.join(HOME_DIR, 'downloads');

class SdkInstallError extends Error {}

function openZip(file) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: false }, (err, zip) => {
      if (err) reject(new SdkInstallError(`That file isn't a zip Hikvision's SDK comes in (${err.message}).`));
      else resolve(zip);
    });
  });
}

/** Every entry in the zip, without reading any file data. */
function listEntries(zip) {
  return new Promise((resolve, reject) => {
    const entries = [];
    zip.on('entry', (e) => { entries.push(e); zip.readEntry(); });
    zip.on('end', () => resolve(entries));
    zip.on('error', (e) => reject(new SdkInstallError(`The zip is damaged (${e.message}). Download it again.`)));
    zip.readEntry();
  });
}

/**
 * The folder in the zip that holds the SDK library: the shallowest copy of it.
 * Hikvision's zip has the library folder near the top, and more copies deep
 * inside its demo programs.
 * @returns {string|null} '' for the zip's top level, 'a/b/' for a folder
 */
function findSdkRoot(names, libName) {
  const want = libName.toLowerCase();
  const hits = names
    .filter((n) => !n.endsWith('/') && path.posix.basename(n).toLowerCase() === want)
    .sort((a, b) => a.split('/').length - b.split('/').length || a.length - b.length);
  if (!hits.length) return null;
  const dir = path.posix.dirname(hits[0]);
  return dir === '.' ? '' : `${dir}/`;
}

/** The CPU a Windows or Linux library was built for, or null when it can't tell. */
function libraryArch(file) {
  let buf;
  try {
    const fd = fs.openSync(file, 'r');
    buf = Buffer.alloc(4096);
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
  } catch { return null; }
  if (buf[0] === 0x4d && buf[1] === 0x5a) { // "MZ": a Windows DLL
    const pe = buf.readUInt32LE(0x3c);
    if (pe + 6 > buf.length || buf.readUInt32LE(pe) !== 0x00004550) return null;
    return { 0x8664: 'x64', 0x014c: 'ia32', 0xaa64: 'arm64' }[buf.readUInt16LE(pe + 4)] || 'other';
  }
  if (buf.readUInt32BE(0) === 0x7f454c46) { // ELF
    return { 0x3e: 'x64', 0x03: 'ia32', 0xb7: 'arm64' }[buf.readUInt16LE(0x12)] || 'other';
  }
  return null;
}

function extractEntry(zip, entry, dest) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err) return reject(new SdkInstallError(`Couldn't unpack ${entry.fileName} (${err.message}).`));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const out = fs.createWriteStream(dest);
      stream.on('error', (e) => { out.destroy(); reject(new SdkInstallError(`Couldn't unpack ${entry.fileName} (${e.message}). Download the zip again.`)); });
      out.on('error', (e) => reject(new SdkInstallError(`Couldn't write ${dest} (${e.message}).`)));
      out.on('finish', resolve);
      stream.pipe(out);
    });
  });
}

const sdkVersionOf = (name) => {
  const m = /HCNetSDKV?([\d.]+\d)(?:_build(\d+))?/i.exec(path.basename(String(name || '')));
  return m ? `${m[1]}${m[2] ? ` (build ${m[2]})` : ''}` : null;
};

/**
 * Unpack the SDK library folder from Hikvision's zip into this PC's SDK folder.
 * @param {string} zipFile
 * @param {object} [opts]
 * @param {(p: {done: number, total: number}) => void} [opts.onProgress]
 * @param {string} [opts.target]    defaults to ~/.villasafe-gate-bridge/hcnetsdk/<platform>
 * @param {string} [opts.platform]  defaults to this PC's (tests pass another)
 * @param {string} [opts.arch]      defaults to this PC's
 */
async function installFromZip(zipFile, opts = {}) {
  const platform = opts.platform || process.platform;
  const arch = opts.arch || process.arch;
  const libName = LIB_NAME[platform];
  if (!libName) throw new SdkInstallError(`Hikvision has no SDK for ${platform}.`);
  const target = opts.target || targetDir();
  if (!zipFile || !fs.existsSync(zipFile)) throw new SdkInstallError('That zip file is no longer there.');

  const zip = await openZip(zipFile);
  const staging = `${target}.installing-${Date.now()}`;
  try {
    const entries = await listEntries(zip);
    const root = findSdkRoot(entries.map((e) => e.fileName), libName);
    if (root === null) {
      throw new SdkInstallError(platform === 'win32'
        ? `There's no ${libName} in this zip. Download "Device Network SDK_Win64" from Hikvision (not the 32-bit one, a demo or a manual).`
        : `There's no ${libName} in this zip. Download Hikvision's Device Network SDK for this computer.`);
    }
    const files = entries.filter((e) => e.fileName.startsWith(root) && !e.fileName.endsWith('/'));
    const total = files.reduce((s, e) => s + e.uncompressedSize, 0);
    if (files.length > MAX_FILES || total > MAX_BYTES) {
      throw new SdkInstallError("This zip's SDK folder is far bigger than Hikvision's. Check it's the Device Network SDK.");
    }

    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });
    let done = 0;
    for (const e of files) {
      const rel = e.fileName.slice(root.length);
      const dest = path.join(staging, ...rel.split('/'));
      // yauzl already refuses absolute and ".." names; this keeps every file inside the folder regardless.
      if (!path.resolve(dest).startsWith(path.resolve(staging) + path.sep)) continue;
      await extractEntry(zip, e, dest);
      done += e.uncompressedSize;
      if (opts.onProgress) opts.onProgress({ done, total });
    }

    const lib = path.join(staging, libName);
    if (!fs.existsSync(lib)) throw new SdkInstallError(`${libName} didn't unpack. Download the zip again.`);
    const core = CORE_NAME[platform];
    if (core && !fs.existsSync(path.join(staging, core))) {
      throw new SdkInstallError(`The zip has ${libName} but not ${core} beside it, so it isn't the full SDK. Download "Device Network SDK" from Hikvision again.`);
    }
    const built = libraryArch(lib);
    if (built && built !== arch && built !== 'other') {
      throw new SdkInstallError(built === 'ia32'
        ? 'This is the 32-bit SDK. Download "Device Network SDK_Win64" from Hikvision instead.'
        : `This SDK is for ${built} computers, and this PC is ${arch}.`);
    }

    // Swap it in. The old folder is moved aside first, so a failure leaves it as it was.
    const old = `${target}.old-${Date.now()}`;
    const hadOld = fs.existsSync(target);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (hadOld) {
      try { fs.renameSync(target, old); }
      catch (e) { throw new SdkInstallError(`The SDK folder is in use (${e.code || e.message}). Quit the bridge from its tray icon, open it again, and install again.`); }
    }
    try { fs.renameSync(staging, target); }
    catch (e) {
      if (hadOld) { try { fs.renameSync(old, target); } catch { /* left beside it */ } }
      throw new SdkInstallError(`Couldn't put the SDK in ${target} (${e.code || e.message}).`);
    }
    if (hadOld) fs.rmSync(old, { recursive: true, force: true });

    return { ok: true, folder: target, files: files.length, bytes: total, version: sdkVersionOf(zipFile) };
  } finally {
    zip.close();
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * The newest Hikvision SDK zip already on this PC: in the bridge's own download
 * folder, or the user's Downloads (fully downloaded, so no .crdownload).
 * @param {string[]} dirs
 */
function findDownloadedZip(dirs, platform = process.platform) {
  const pattern = ZIP_PATTERN[platform];
  if (!pattern) return null;
  const found = [];
  for (const dir of dirs.filter(Boolean)) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!pattern.test(name)) continue;
      try {
        const st = fs.statSync(path.join(dir, name));
        if (st.isFile() && st.size > 1024 * 1024) found.push({ file: path.join(dir, name), name, size: st.size, modified: st.mtime.toISOString(), version: sdkVersionOf(name) });
      } catch { /* gone */ }
    }
  }
  return found.sort((a, b) => b.modified.localeCompare(a.modified))[0] || null;
}

module.exports = {
  installFromZip, findDownloadedZip, findSdkRoot, libraryArch, sdkVersionOf,
  targetDir, downloadsDir, SdkInstallError, LIB_NAME, PAGE_URL, ZIP_PATTERN,
};
