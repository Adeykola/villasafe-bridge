// USB / serial relay board driver. Sends an open/close pulse on the configured channel.
// Compatible with KMtronic, Numato, Sainsmart and any board accepting plain serial commands.
let SerialPort;
try { ({ SerialPort } = require('serialport')); } catch { SerialPort = null; }

async function pulse(params, value) {
  if (!SerialPort) throw new Error('serialport not installed');
  const port = new SerialPort({ path: params.port, baudRate: params.baud || 9600, autoOpen: false });
  await new Promise((res, rej) => port.open((e) => (e ? rej(e) : res())));
  // Generic ON/OFF byte protocol — many boards use single bytes
  const onByte = Buffer.from([0xA0, params.channel || 1, value ? 0x01 : 0x00, 0xA1 + (params.channel || 1)]);
  await new Promise((res, rej) => port.write(onByte, (e) => (e ? rej(e) : res())));
  await new Promise((r) => setTimeout(r, params.pulseMs || 500));
  await new Promise((res) => port.close(() => res()));
}

async function run(device, action) {
  if (action === 'open') return pulse(device.params, true);
  if (action === 'close') return pulse(device.params, false);
}

async function probe(device) {
  if (!SerialPort) return { ok: false, error: 'serialport module not installed' };
  try {
    const list = await SerialPort.list();
    const found = list.find(p => p.path === device.params.port);
    if (!found) return { ok: false, error: `Port ${device.params.port} not present` };
    return { ok: true, info: `Port ${device.params.port} detected (${found.manufacturer || 'unknown'})` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { run, probe };