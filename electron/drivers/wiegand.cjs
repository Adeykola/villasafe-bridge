// Wiegand reader emulator stub. Real implementations bit-bang GPIO on the host PC;
// here we send the configured card ID over a serial line to a Wiegand-to-serial adapter.
let SerialPort;
try { ({ SerialPort } = require('serialport')); } catch { SerialPort = null; }

async function run(device, action) {
  if (action !== 'open') return;
  if (!SerialPort) throw new Error('serialport not installed');
  const port = new SerialPort({ path: device.params.port, baudRate: 9600, autoOpen: false });
  await new Promise((res, rej) => port.open((e) => (e ? rej(e) : res())));
  await new Promise((res, rej) => port.write(String(device.params.cardId) + '\r\n', (e) => (e ? rej(e) : res())));
  await new Promise((res) => port.close(() => res()));
}

async function probe(device) {
  if (!SerialPort) return { ok: false, error: 'serialport module not installed' };
  try {
    const list = await SerialPort.list();
    const found = list.find(p => p.path === device.params.port);
    if (!found) return { ok: false, error: `Wiegand adapter on ${device.params.port} not detected` };
    return { ok: true, info: `Wiegand adapter present on ${device.params.port}` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { run, probe };