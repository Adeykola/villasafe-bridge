// Long-range UHF RFID reader driver.
// Supports two common modes:
//   - TCP push: reader connects to a host:port and pushes EPC strings
//   - Serial: USB/RS-232 reader emitting \x02<EPC>\x03 frames
// On each tag read, we invoke onTagSeen(tagUid).
const net = require('net');

let activeServers = [];
const lastReadAt = new Map(); // key: deviceId:tagUid → timestamp

function shouldDebounce(device, uid) {
  const ms = Number(device.timeoutMs || device.config?.timeoutMs || 1500);
  const key = `${device.id || device.name || 'dev'}:${uid}`;
  const now = Date.now();
  const last = lastReadAt.get(key) || 0;
  if (now - last < ms) return true;
  lastReadAt.set(key, now);
  return false;
}

function passesAllowList(device, uid) {
  const mode = device.allowListMode || device.config?.allowListMode || 'allow_all';
  const list = (device.allowList || device.config?.allowList || []).map((s) => String(s).toUpperCase());
  if (mode === 'allow_only_listed') return list.includes(uid);
  if (mode === 'deny_listed') return !list.includes(uid);
  return true;
}

function startReader(device, onTagSeen) {
  const wrapped = (uid, dev) => {
    if (shouldDebounce(device, uid)) return;
    if (!passesAllowList(device, uid)) {
      try { onTagSeen(uid, dev, { blocked: true }); } catch {}
      return;
    }
    try { onTagSeen(uid, dev); } catch {}
  };
  const mode = (device.mode || device.config?.mode || 'tcp').toLowerCase();
  if (mode === 'tcp' || mode === 'tcp_push') return startTcp(device, wrapped);
  if (mode === 'serial' || mode === 'serial_wiegand' || mode === 'serial_aba') return startSerial(device, wrapped);
  throw new Error('Unknown RFID mode: ' + mode);
}

function startTcp(device, onTagSeen) {
  const port = Number(device.port || device.config?.port || 9090);
  const server = net.createServer((sock) => {
    sock.on('data', (buf) => {
      const text = buf.toString('utf8');
      // Strip \x02 \x03 framing + whitespace, accept comma/newline separated bursts
      text.split(/[\r\n,]+/).map(s => s.replace(/[\x02\x03]/g, '').trim())
        .filter(Boolean).forEach((uid) => {
          try { onTagSeen(uid.toUpperCase(), device); } catch {}
        });
    });
    sock.on('error', () => {});
  });
  server.listen(port, () => {});
  activeServers.push(server);
  return { ok: true, mode: 'tcp', port };
}

function startSerial(device, onTagSeen) {
  let SerialPort;
  try { SerialPort = require('serialport').SerialPort; } catch { return { ok: false, error: 'serialport not installed' }; }
  const port = new SerialPort({ path: device.port || device.config?.port, baudRate: device.baudRate || 9600 });
  let buffer = '';
  port.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    const re = /\x02([^\x03]+)\x03/g;
    let m;
    while ((m = re.exec(buffer))) {
      try { onTagSeen(m[1].trim().toUpperCase(), device); } catch {}
    }
    buffer = buffer.slice(buffer.lastIndexOf('\x03') + 1);
  });
  port.on('error', () => {});
  activeServers.push({ close: () => port.close(() => {}) });
  return { ok: true, mode: 'serial' };
}

function stopAll() {
  for (const s of activeServers) { try { s.close(() => {}); } catch {} }
  activeServers = [];
}

async function probe(device) {
  return { ok: true, message: `RFID reader (${device.mode || 'tcp'}) listening` };
}

module.exports = { startReader, stopAll, probe, run: async () => ({ ok: true }) };