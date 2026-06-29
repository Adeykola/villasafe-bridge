const net = require('net');

function send(host, port, cmd) {
  return new Promise((resolve, reject) => {
    const s = new net.Socket();
    const t = setTimeout(() => { s.destroy(); reject(new Error('TCP timeout')); }, 3000);
    s.connect(port, host, () => {
      s.write(cmd + '\r\n');
      setTimeout(() => { clearTimeout(t); s.destroy(); resolve(); }, 200);
    });
    s.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}

async function run(device, action) {
  const { host, port, openCmd, closeCmd } = device.params;
  const cmd = action === 'open' ? (openCmd || 'OPEN') : (closeCmd || 'CLOSE');
  return send(host, port, cmd);
}

function probe(device) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    const t = setTimeout(() => { s.destroy(); resolve({ ok: false, error: `TCP timeout to ${device.params.host}:${device.params.port}` }); }, 2000);
    s.connect(device.params.port, device.params.host, () => {
      clearTimeout(t); s.destroy();
      resolve({ ok: true, info: `Reached ${device.params.host}:${device.params.port}` });
    });
    s.on('error', (e) => { clearTimeout(t); resolve({ ok: false, error: e.message }); });
  });
}

module.exports = { run, probe };