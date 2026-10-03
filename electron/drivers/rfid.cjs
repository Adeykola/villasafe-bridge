// Long-range UHF RFID reader driver.
// Supports:
//   - TCP push: reader (or a network→serial bridge) connects to us on a host:port and pushes EPCs
//   - Serial (USB/RS-232/RS-485): reader emits ASCII EPCs per line, STX/ETX frames, or the
//     S4A UHF-202420 native binary frame (BB … 7E) with a 12-byte EPC.
//
// Wizard writes config under device.params.*; older/hand-edited configs may use
// device.config.* or set fields directly on device. We merge in that order so
// whichever the caller uses, it reaches the driver.
const net = require('net');

let activeServers = [];
const lastReadAt = new Map(); // key: deviceId:tagUid → timestamp

function cfg(device) {
  return { ...(device || {}), ...(device?.config || {}), ...(device?.params || {}) };
}

// Normalize the wizard's human labels to internal values.
function normalizeAllowListMode(raw) {
  const v = String(raw || '').toLowerCase();
  if (v === 'whitelist' || v === 'allow_only_listed') return 'allow_only_listed';
  if (v === 'log-only' || v === 'log_only' || v === 'deny_listed') return 'log_only';
  return 'allow_all';
}

function shouldDebounce(device, uid) {
  const c = cfg(device);
  const ms = Number(c.debounceMs || c.timeoutMs || 1500);
  const key = `${device.id || device.name || 'dev'}:${uid}`;
  const now = Date.now();
  const last = lastReadAt.get(key) || 0;
  if (now - last < ms) return true;
  lastReadAt.set(key, now);
  return false;
}

function evaluateAllowList(device, uid) {
  const c = cfg(device);
  const mode = normalizeAllowListMode(c.allowListMode);
  const list = (c.allowList || []).map((s) => String(s).toUpperCase());
  // Returns { blocked, logOnly }.
  if (mode === 'allow_only_listed') {
    // An empty list means nothing is approved — never "let everyone in".
    return { blocked: !list.includes(uid), logOnly: false };
  }
  if (mode === 'log_only') return { blocked: false, logOnly: true };
  return { blocked: false, logOnly: false };
}

// -------- Frame parsers --------
// Return { epcs: string[], rest: Buffer } given a Buffer and a frame format.
function parseFrames(buf, frameFormat) {
  const fmt = String(frameFormat || 'ascii-line').toLowerCase();
  if (fmt === 's4a-binary' || fmt === 'binary') return parseS4ABinary(buf);
  // ascii-line (also handles STX/ETX and comma/newline bursts) — safe default
  return parseAsciiLine(buf);
}

function parseAsciiLine(buf) {
  const text = buf.toString('utf8');
  // Split on newline, carriage return, comma, STX or ETX
  const parts = text.split(/[\r\n,\x02\x03]+/);
  const rest = parts.pop() || '';
  const epcs = [];
  for (const raw of parts) {
    const s = raw.trim().toUpperCase();
    if (!s) continue;
    // Accept plain hex EPCs (typical: 24 hex chars = 12 bytes; also allow 16/20/32)
    if (/^[0-9A-F]{8,32}$/.test(s)) epcs.push(s);
  }
  return { epcs, rest: Buffer.from(rest, 'utf8') };
}

// S4A UHF-202420 native frame (its M100/R200 reader module):
//   0xBB <TYPE> <CMD> <LEN_H> <LEN_L> <payload…> <CHECKSUM> 0x7E
// A tag notice is type 02, command 22, payload RSSI(1) PC(2) EPC(n) CRC(2);
// the checksum is the low byte of TYPE…payload. Reading by the length field
// means an EPC that happens to contain 0x7E is still read whole. Frames that
// don't check out fall back to the original reading (12-byte EPC, 8 bytes in).
const MAX_PENDING = 512;

function parseS4ABinary(buf) {
  const epcs = [];
  let i = 0;
  while (i < buf.length) {
    const start = buf.indexOf(0xBB, i);
    if (start < 0) { i = buf.length; break; }
    if (buf.length - start < 7) { i = start; break; }

    const len = (buf[start + 3] << 8) | buf[start + 4];
    const end = start + len + 6;
    if (len <= 128 && end >= buf.length) { i = start; break; } // wait for the rest

    if (len <= 128 && buf[end] === 0x7E) {
      let sum = 0;
      for (let k = start + 1; k < end - 1; k++) sum = (sum + buf[k]) & 0xFF;
      if (sum === buf[end - 1]) {
        if (buf[start + 1] === 0x02 && buf[start + 2] === 0x22 && len >= 9) {
          const pc = (buf[start + 6] << 8) | buf[start + 7];
          let epcLen = len - 5;
          const words = pc >> 11;
          if (words > 0 && words * 2 <= epcLen) epcLen = words * 2;
          epcs.push(buf.slice(start + 8, start + 8 + epcLen).toString('hex').toUpperCase());
        }
        i = end + 1;
        continue;
      }
    }

    // Not a clean module frame: the original reading.
    const loose = buf.indexOf(0x7E, start + 1);
    if (loose < 0) {
      if (buf.length - start > 64) { i = start + 1; continue; }
      i = start;
      break;
    }
    const frameLen = loose - start + 1;
    if (frameLen >= 20 && frameLen <= 40) {
      const epc = buf.slice(start + 8, Math.min(start + 20, loose - 2));
      if (epc.length >= 8) epcs.push(epc.toString('hex').toUpperCase());
      i = loose + 1;
    } else {
      i = start + 1;
    }
  }
  const rest = buf.slice(i);
  return { epcs, rest: rest.length > MAX_PENDING ? rest.slice(rest.length - MAX_PENDING) : rest };
}

// -------- Connections, and what each reader is doing --------
// Every reader keeps a status (keyed by where it's plugged in), so the bridge
// screen and VillaSafe can say exactly what's wrong — port not on this PC,
// port busy, cable pulled, data arriving but no tag numbers — instead of the
// reader failing silently. A serial reader that can't open keeps retrying, so
// plugging the cable in later just works.

let RETRY_MS = 5000;
// This much data with no tag number in it means the settings don't match the reader.
const NO_TAGS_AFTER_BYTES = 120;
const readers = new Map(); // key → status
const statusListeners = new Set();
let SerialPortImpl = null; // tests swap in a fake

function serialPortClass() {
  if (SerialPortImpl) return SerialPortImpl;
  try { return require('serialport').SerialPort; } catch { return null; }
}

const isTcp = (c) => ['tcp', 'tcp_push'].includes(String(c.mode || 'tcp').toLowerCase());
const tcpPortOf = (c) => Number(c.tcpPort || c.port || 9090);
const keyOf = (c) => (isTcp(c) ? `tcp:${tcpPortOf(c)}` : `serial:${String(c.port || '').toUpperCase()}`);

function setStatus(st, patch) {
  const before = `${st.state}|${st.error}|${st.path}|${st.format}`;
  Object.assign(st, patch);
  if (`${st.state}|${st.error}|${st.path}|${st.format}` !== before) {
    for (const fn of statusListeners) { try { fn(st); } catch {} }
  }
}

/**
 * Which output the reader is set to, from what it has sent: printable text with
 * line breaks is ASCII; binary bytes are the S4A's native frames. Null until clear.
 */
function detectFormat(buf) {
  let lineBreak = false;
  for (const b of buf) {
    if (b === 0x0D || b === 0x0A || b === 0x03) { lineBreak = true; continue; }
    if (b === 0x02 || b === 0x09) continue;
    if (b < 0x20 || b > 0x7E) return 's4a-binary';
  }
  return lineBreak ? 'ascii-line' : null;
}

const formatName = (f) => (f === 's4a-binary' ? 'native binary' : 'ASCII');

/** Feed incoming bytes through the parser, switching ASCII ↔ native if the reader is set the other way. */
function makeFeeder(st, onTagSeen, device) {
  let buf = Buffer.alloc(0);
  let sample = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    sample = Buffer.concat([sample, chunk]).subarray(-512);
    st.bytes += chunk.length;
    st.lastDataAt = Date.now();
    let { epcs, rest } = parseFrames(buf, st.format);
    if (!epcs.length && st.tags === 0) {
      const seen = detectFormat(sample);
      if (seen && seen !== st.format) {
        const again = parseFrames(Buffer.concat([sample]), seen);
        setStatus(st, { format: seen });
        st.log?.(`RFID reader on ${st.where}: it sends ${formatName(seen)} output — reading it that way`);
        ({ epcs, rest } = again);
      }
    }
    buf = rest;
    if (epcs.length) {
      st.tags += epcs.length;
      st.lastTagAt = Date.now();
      setStatus(st, { state: 'ok', error: null });
      for (const uid of epcs) { try { onTagSeen(uid, device); } catch {} }
    } else if (st.tags === 0 && st.bytes >= NO_TAGS_AFTER_BYTES && st.state !== 'no_tags') {
      setStatus(st, {
        state: 'no_tags',
        error: `Data is arriving on ${st.where} but there are no tag numbers in it. Check the speed in the S4A tool matches the lane's Baud (${st.baud}).`,
      });
    }
  };
}

const isBluetooth = (p) => /bluetooth|bthenum/i.test(`${p.friendlyName || ''} ${p.pnpId || ''} ${p.manufacturer || ''}`);
// A USB serial adapter (or a reader's own USB) — not a laptop's built-in
// virtual ports like Intel AMT's Serial-over-LAN, which have no USB IDs.
const isUsb = (p) => !!p.vendorId || /^(USB|FTDIBUS)[\\]/i.test(String(p.pnpId || ''));
const portLabel = (p) => `${p.path}${p.friendlyName || p.manufacturer ? ` (${String(p.friendlyName || p.manufacturer).replace(/\s*\(COM\d+\)\s*$/i, '')})` : ''}`;

async function listPorts() {
  const SerialPort = serialPortClass();
  if (!SerialPort || !SerialPort.list) return [];
  try { return await SerialPort.list(); } catch { return []; }
}

/** Plain-English reason a serial port wouldn't open. */
function openErrorText(path, err, ports) {
  const msg = String(err?.message || err || '');
  const here = ports.filter((p) => !isBluetooth(p)).map(portLabel);
  const list = here.length ? `Serial ports on this PC: ${here.join(', ')}.` : 'No serial ports found on this PC — check the cable and the USB adapter’s driver.';
  if (/file not found|no such file|cannot find|ENOENT|unknown error code 2\b/i.test(msg)) {
    return `${path} isn't on this PC. ${list} Set the lane's Serial port to the S4A's one (Device Manager → Ports).`;
  }
  if (/access denied|resource busy|EBUSY|cannot lock|locked/i.test(msg)) {
    return `${path} is in use by another program. Close the S4A tool (or anything else using the port); the bridge will connect by itself.`;
  }
  if (/permission denied|EACCES/i.test(msg)) {
    return `No permission to open ${path}. On Linux, add this user to the "dialout" group.`;
  }
  return `Couldn't open ${path}: ${msg}`;
}

function startReader(device, onTagSeen, opts = {}) {
  const wrapped = (uid, dev) => {
    if (!uid) return;
    if (shouldDebounce(device, uid)) return;
    const { blocked, logOnly } = evaluateAllowList(device, uid);
    try { onTagSeen(uid, dev, { blocked, logOnly }); } catch {}
  };
  const c = cfg(device);
  const mode = String(c.mode || 'tcp').toLowerCase();
  if (isTcp(c)) return startTcp(device, wrapped, opts);
  if (mode === 'serial' || mode === 'serial_wiegand' || mode === 'serial_aba') return startSerial(device, wrapped, opts);
  throw new Error('Unknown RFID mode: ' + mode);
}

function newStatus(c, extra) {
  return {
    key: keyOf(c),
    state: 'starting',
    error: null,
    format: String(c.frameFormat || 'ascii-line').toLowerCase() === 's4a-binary' ? 's4a-binary' : 'ascii-line',
    bytes: 0,
    tags: 0,
    lastDataAt: null,
    lastTagAt: null,
    stopped: false,
    ...extra,
  };
}

function startTcp(device, onTagSeen, opts = {}) {
  const c = cfg(device);
  const port = tcpPortOf(c);
  const st = newStatus(c, { mode: 'tcp', where: `TCP port ${port}`, path: null, baud: null, log: opts.log });
  readers.set(st.key, st);
  const server = net.createServer((sock) => {
    setStatus(st, { state: st.tags ? 'ok' : 'waiting', error: null, peer: sock.remoteAddress });
    const feed = makeFeeder(st, onTagSeen, device);
    sock.on('data', feed);
    sock.on('error', () => {});
  });
  server.on('listening', () => setStatus(st, { state: 'waiting', error: null }));
  server.on('error', (e) => setStatus(st, {
    state: 'error',
    error: e && e.code === 'EADDRINUSE'
      ? `TCP port ${port} is already in use on this PC. Pick another port in the lane and in the S4A tool.`
      : `Couldn't listen on TCP port ${port}: ${e && e.message}`,
  }));
  server.listen(port);
  activeServers.push({ close: () => { st.stopped = true; readers.delete(st.key); try { server.close(() => {}); } catch {} } });
  return { ok: true, mode: 'tcp', port, frameFormat: st.format };
}

function startSerial(device, onTagSeen, opts = {}) {
  const c = cfg(device);
  const configured = String(c.port || '').trim();
  const baudRate = Number(c.baud || c.baudRate || 115200);
  const st = newStatus(c, { mode: 'serial', where: configured || 'serial port', path: configured || null, baud: baudRate, log: opts.log });
  readers.set(st.key, st);
  const reserved = new Set((opts.reservedPorts || []).map((p) => String(p).toUpperCase()));
  let port = null;
  let retry = null;

  const SerialPort = serialPortClass();
  if (!SerialPort) {
    setStatus(st, { state: 'error', error: 'This copy of the Gate Bridge is missing its serial-port support. Reinstall it from VillaSafe.' });
    return { ok: false, error: st.error };
  }

  const scheduleRetry = () => {
    if (st.stopped || retry) return;
    retry = setTimeout(() => { retry = null; void connect(); }, RETRY_MS);
  };

  async function connect() {
    if (st.stopped) return;
    const ports = await listPorts();
    let path = configured;
    // The lane names a port this PC doesn't have, but there's exactly one USB
    // serial port nobody else uses: that's the reader.
    const real = ports.filter((p) => isUsb(p) && !isBluetooth(p) && !reserved.has(String(p.path).toUpperCase()));
    const present = (name) => ports.some((p) => String(p.path).toUpperCase() === String(name).toUpperCase());
    let note = null;
    if ((!path || (ports.length && !present(path))) && real.length === 1) {
      path = real[0].path;
      note = path !== configured ? `${configured || 'No port'} was set, which isn't on this PC — using ${portLabel(real[0])}. Set the lane's Serial port to ${path} to keep it.` : null;
    }
    if (!path) {
      setStatus(st, { state: 'error', error: openErrorText('The serial port', new Error('file not found'), ports) });
      return scheduleRetry();
    }
    if (st.stopped) return;
    let p;
    try {
      p = new SerialPort({ path, baudRate, autoOpen: false });
    } catch (e) {
      setStatus(st, { state: 'error', error: openErrorText(path, e, ports) });
      return scheduleRetry();
    }
    p.open((err) => {
      if (st.stopped) { try { p.close(() => {}); } catch {} return; }
      if (err) {
        setStatus(st, { state: 'error', error: openErrorText(path, err, ports), path });
        return scheduleRetry();
      }
      port = p;
      st.bytes = 0;
      setStatus(st, { state: st.tags ? 'ok' : 'waiting', error: null, path, where: path, note });
      if (note) st.log?.(`RFID reader: ${note}`);
      st.log?.(`RFID reader connected on ${path} at ${baudRate} baud`);
    });
    p.on('data', makeFeeder(st, onTagSeen, device));
    p.on('error', () => {});
    p.on('close', () => {
      if (port !== p) return;
      port = null;
      if (st.stopped) return;
      setStatus(st, { state: 'error', error: `The reader on ${path} was disconnected. The bridge reconnects when it's plugged back in.` });
      scheduleRetry();
    });
  }

  void connect();
  activeServers.push({
    close: () => {
      st.stopped = true;
      readers.delete(st.key);
      if (retry) clearTimeout(retry);
      try { port && port.close(() => {}); } catch {}
    },
  });
  return { ok: true, mode: 'serial', path: configured, baudRate, frameFormat: st.format };
}

function stopAll() {
  for (const s of activeServers) { try { s.close(() => {}); } catch {} }
  activeServers = [];
}

/** Be told when a reader connects, fails or starts reading tags. */
function onStatusChange(fn) {
  statusListeners.add(fn);
  return () => statusListeners.delete(fn);
}

const STATE_NOTE = {
  waiting: (st) => `Connected on ${st.where}. Nothing received yet — hold a tag at the reader. If nothing ever arrives, turn on Auto-read in the S4A tool.`,
};

/**
 * How a reader is doing, for the bridge screen and VillaSafe's device health.
 * A reader that's running reports its live status; one that isn't (the lane
 * wizard's Test connection) checks the port is on this PC.
 */
async function probe(device) {
  const c = cfg(device);
  const st = readers.get(keyOf(c));
  if (st) {
    if (st.state === 'error' || st.state === 'no_tags') return { ok: false, error: st.error };
    if (st.state === 'starting') return { ok: true, note: `Connecting to ${st.where}…` };
    const note = st.note || (st.state === 'waiting' ? STATE_NOTE.waiting(st) : null);
    return { ok: true, note, info: `${st.where} · ${formatName(st.format)} · ${st.tags} tag read${st.tags === 1 ? '' : 's'}` };
  }
  if (isTcp(c)) return { ok: true, info: `Listens on TCP port ${tcpPortOf(c)} for the reader` };
  const ports = await listPorts();
  const path = String(c.port || '').trim();
  const found = ports.find((p) => String(p.path).toUpperCase() === path.toUpperCase());
  if (found) return { ok: true, info: `${portLabel(found)} is on this PC` };
  return { ok: false, error: openErrorText(path || 'The serial port', new Error('file not found'), ports) };
}

/** Live status of every running reader. */
const statuses = () => [...readers.values()].map(({ log, ...st }) => st);

module.exports = {
  startReader, stopAll, probe, onStatusChange, statuses,
  run: async () => ({ ok: true }),
  _internal: { evaluateAllowList, parseFrames, detectFormat, setSerialPort: (impl) => { SerialPortImpl = impl; }, setRetryMs: (ms) => { RETRY_MS = ms; } },
};
