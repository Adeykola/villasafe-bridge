const relay = require('./relay.cjs');
const tcp = require('./tcp.cjs');
const modbus = require('./modbus.cjs');
const wiegand = require('./wiegand.cjs');
const rfid = require('./rfid.cjs');
const hikvision = require('./hikvision.cjs');

const drivers = { relay, tcp, modbus, wiegand, rfid, hikvision };

// opts may carry { side: 'entry' | 'exit' } for full-height turnstiles that
// expose one rotor per direction on the same controller.
async function runDriver(device, action, opts = {}) {
  const drv = drivers[device.driver];
  if (!drv) throw new Error('Unknown driver: ' + device.driver);
  return drv.run(device, action, opts);
}

// opts.background marks the automatic health check (drivers that log in, like
// Hikvision, then never retry a password the controller refused).
async function probeDriver(device, opts = {}) {
  const drv = drivers[device.driver];
  if (!drv || !drv.probe) return { ok: false, error: 'No probe for driver ' + device.driver };
  try { return await drv.probe(device, opts); } catch (e) { return { ok: false, error: e.message }; }
}

module.exports = { runDriver, probeDriver };