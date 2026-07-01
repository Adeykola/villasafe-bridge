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
    return { blocked: list.length > 0 ? !list.includes(uid) : false, logOnly: false };
  }
  if (mode === 'log_only') return { blocked: false, logOnly: true };
  return { blocked: false, logOnly: false };
}

function startReader(device, onTagSeen) {
  const wrapped = (uid, dev) => {
    if (!uid) return;
    if (shouldDebounce(device, uid)) return;
    const { blocked, logOnly } = evaluateAllowList(device, uid);
    try { onTagSeen(uid, dev, { blocked, logOnly }); } catch {}
  };
  const c = cfg(device);
  const mode = String(c.mode || 'tcp').toLowerCase();
  if (mode === 'tcp' || mode === 'tcp_push') return startTcp(device, wrapped);
  if (mode === 'serial' || mode === 'serial_wiegand' || mode === 'serial_aba') return startSerial(device, wrapped);
  throw new Error('Unknown RFID mode: ' + mode);
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

// S4A UHF-202420 native frame:
//   0xBB <TYPE> <CMD> <LEN_H> <LEN_L> <RSSI> <PC_H> <PC_L> <EPC 12B> <CRC_H> <CRC_L> 0x7E
// We conservatively scan for 0xBB … 0x7E, then extract 12 bytes of EPC from a
// known offset when the payload length matches the "single-tag notify" frame.
function parseS4ABinary(buf) {
  const epcs = [];
  let i = 0;
  let lastEnd = 0;
  while (i < buf.length) {
    const start = buf.indexOf(0xBB, i);
    if (start < 0) break;
    const end = buf.indexOf(0x7E, start + 1);
    if (end < 0) break; // wait for more data
    const frame = buf.slice(start, end + 1);
    // Typical single-tag notify: length ~= 22-24 bytes, EPC 12B starts 8 bytes in.
    if (frame.length >= 20 && frame.length <= 40) {
      // Try the common S4A/JADAK offset first (8..20 = 12B EPC).
      const epc = frame.slice(8, Math.min(20, frame.length - 3));
      if (epc.length >= 8) {
        epcs.push(epc.toString('hex').toUpperCase());
      }
    }
    lastEnd = end + 1;
    i = lastEnd;
  }
  return { epcs, rest: buf.slice(lastEnd) };
}

function startTcp(device, onTagSeen) {
  const c = cfg(device);
  const port = Number(c.tcpPort || c.port || 9090);
  const frameFormat = c.frameFormat || 'ascii-line';
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const { epcs, rest } = parseFrames(buf, frameFormat);
      buf = rest;
      for (const uid of epcs) { try { onTagSeen(uid, device); } catch {} }
    });
    sock.on('error', () => {});
  });
  server.on('error', () => {});
  server.listen(port, () => {});
  activeServers.push(server);
  return { ok: true, mode: 'tcp', port, frameFormat };
}

function startSerial(device, onTagSeen) {
  let SerialPort;
  try { SerialPort = require('serialport').SerialPort; } catch { return { ok: false, error: 'serialport not installed' }; }
  const c = cfg(device);
  const path = c.port;
  if (!path) return { ok: false, error: 'Serial port not set' };
  const baudRate = Number(c.baud || c.baudRate || 115200);
  const frameFormat = c.frameFormat || 'ascii-line';
  let port;
  try { port = new SerialPort({ path, baudRate }); } catch (e) { return { ok: false, error: e.message }; }
  let buf = Buffer.alloc(0);
  port.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    const { epcs, rest } = parseFrames(buf, frameFormat);
    buf = rest;
    for (const uid of epcs) { try { onTagSeen(uid, device); } catch {} }
  });
  port.on('error', () => {});
  activeServers.push({ close: () => { try { port.close(() => {}); } catch {} } });
  return { ok: true, mode: 'serial', path, baudRate, frameFormat };
}

function stopAll() {
  for (const s of activeServers) { try { s.close(() => {}); } catch {} }
  activeServers = [];
}

async function probe(device) {
  const c = cfg(device);
  const mode = c.mode || 'tcp';
  const detail = mode === 'serial'
    ? `${c.port || '?'} @ ${c.baud || 115200}`
    : `:${c.tcpPort || c.port || 9090}`;
  return { ok: true, message: `RFID reader (${mode}, ${c.frameFormat || 'ascii-line'}) ${detail}` };
}

module.exports = { startReader, stopAll, probe, run: async () => ({ ok: true }) };