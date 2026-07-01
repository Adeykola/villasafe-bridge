const relay = require('./relay.cjs');
const tcp = require('./tcp.cjs');
const modbus = require('./modbus.cjs');
const wiegand = require('./wiegand.cjs');
const rfid = require('./rfid.cjs');
const hikvision = require('./hikvision.cjs');

const drivers = { relay, tcp, modbus, wiegand, rfid, hikvision };

async function runDriver(device, action) {
  const drv = drivers[device.driver];
  if (!drv) throw new Error('Unknown driver: ' + device.driver);
  return drv.run(device, action);
}

async function probeDriver(device) {
  const drv = drivers[device.driver];
  if (!drv || !drv.probe) return { ok: false, error: 'No probe for driver ' + device.driver };
  try { return await drv.probe(device); } catch (e) { return { ok: false, error: e.message }; }
}

module.exports = { runDriver, probeDriver };