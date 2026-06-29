let ModbusRTU;
try { ModbusRTU = require('modbus-serial'); } catch { ModbusRTU = null; }

async function run(device, action) {
  if (!ModbusRTU) throw new Error('modbus-serial not installed');
  const client = new ModbusRTU();
  await client.connectRTUBuffered(device.params.port, { baudRate: device.params.baud || 9600 });
  client.setID(device.params.unitId || 1);
  const value = action === 'open' ? (device.params.openValue ?? 1) : (device.params.closeValue ?? 0);
  await client.writeRegister(device.params.register || 0, value);
  client.close(() => {});
}

async function probe(device) {
  if (!ModbusRTU) return { ok: false, error: 'modbus-serial module not installed' };
  const client = new ModbusRTU();
  try {
    await client.connectRTUBuffered(device.params.port, { baudRate: device.params.baud || 9600 });
    client.setID(device.params.unitId || 1);
    try { await client.readHoldingRegisters(device.params.register || 0, 1); } catch { /* slave may not answer that register; port itself opened */ }
    client.close(() => {});
    return { ok: true, info: `Modbus port ${device.params.port} open, slave ${device.params.unitId || 1}` };
  } catch (e) {
    try { client.close(() => {}); } catch {}
    return { ok: false, error: e.message };
  }
}

module.exports = { run, probe };