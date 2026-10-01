// End-to-end diagnostics: ping → SDK port reachability → SDK login → relay test.
const net = require('net');
const dgram = require('dgram');
const { exec } = require('child_process');
const controllers = require('../config/controllers.store');
const registry = require('../sessions/sessionRegistry');
const door = require('../drivers/hikvision/door');
const sdkLoader = require('../drivers/hikvision/sdkLoader');

function ping(host) {
  return new Promise(resolve => {
    const cmd = process.platform === 'win32' ? `ping -n 1 -w 1500 ${host}` : `ping -c 1 -W 2 ${host}`;
    exec(cmd, (err) => resolve({ name: 'ping', ok: !err, detail: err ? 'no reply' : 'reply received' }));
  });
}

function portOpen(host, port, timeoutMs = 2500) {
  return new Promise(resolve => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok, detail) => { if (done) return; done = true; try { sock.destroy(); } catch {} resolve({ name: `port ${port}`, ok, detail }); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true, 'connected'));
    sock.once('timeout', () => finish(false, 'timed out'));
    sock.once('error', (e) => finish(false, e.code || e.message));
    sock.connect(port, host);
  });
}

async function run({ controllerId, testDoorNo }) {
  const c = controllers.get(controllerId);
  if (!c) throw new Error('Unknown controller');
  const results = [];
  results.push(await ping(c.ip));
  results.push(await portOpen(c.ip, c.sdkPort || 8000));
  const sdk = sdkLoader.status();
  results.push({ name: 'sdk loaded', ok: sdk.loaded, detail: sdk.loaded ? `${sdk.platform}/${sdk.libraryName}` : (sdk.lastError?.message || 'not loaded') });

  let session = null;
  try {
    session = await registry.ensure(controllerId);
    results.push({ name: 'sdk login', ok: session.online, detail: session.online ? `userId=${session.userId}` : (session.lastError?.message || 'unknown') });
  } catch (e) {
    results.push({ name: 'sdk login', ok: false, detail: e.message, hint: e.hint });
  }

  if (session && session.online && testDoorNo) {
    try {
      await door.open(session, testDoorNo);
      results.push({ name: `relay test door ${testDoorNo}`, ok: true, detail: 'pulse sent' });
    } catch (e) {
      results.push({ name: `relay test door ${testDoorNo}`, ok: false, detail: e.message });
    }
  }

  return { controllerId, ranAt: new Date().toISOString(), results };
}

module.exports = { run, ping, portOpen };