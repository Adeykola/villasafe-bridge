const os = require('os');
const { probeDriver } = require('../drivers/index.cjs');
const { gatewayHealth } = require('./pairing.cjs');

const logBuffer = [];
function log(line) {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  logBuffer.push(stamped);
  if (logBuffer.length > 200) logBuffer.shift();
}
function getLogs() { return logBuffer.slice(); }

async function runFull(cfg, lanes) {
  const steps = [];
  steps.push({ id: 'config', label: 'Gateway URL configured',
    ok: !!cfg.gatewayUrl,
    hint: 'Reinstall the bridge — the VillaSafe gateway URL should ship with the app.' });

  let reachable = false;
  let gatewayHint = 'Check internet on this PC. Whitelist villasafe.com on the firewall.';
  try {
    if (cfg.gatewayUrl) {
      const r = await gatewayHealth(cfg.gatewayUrl);
      reachable = !!r.ok;
      if (!r.ok) gatewayHint = r.error || gatewayHint;
    }
  } catch (e) { gatewayHint = e.message || gatewayHint; }
  steps.push({ id: 'internet', label: 'VillaSafe gateway reachable',
    ok: reachable, hint: gatewayHint });

  steps.push({ id: 'pair', label: 'Bridge paired',
    ok: !!(cfg.bridgeId && cfg.bridgeToken),
    hint: 'Enter the 6-digit pairing code from VillaSafe → Gate Bridges.' });

  const deviceProbes = [];
  for (const lane of lanes) {
    for (let i = 0; i < (lane.devices || []).length; i++) {
      const d = lane.devices[i];
      const r = await probeDriver(d);
      deviceProbes.push({
        lane: lane.name,
        device: d.name,
        driver: d.driver,
        kind: d.kind,
        ok: r.ok,
        message: r.ok ? r.info : r.error,
        hint: hintFor(d.driver, r),
      });
    }
  }

  return {
    host: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    steps,
    devices: deviceProbes,
    logs: getLogs(),
    generatedAt: new Date().toISOString(),
  };
}

function hintFor(driver, result) {
  if (result.ok) return null;
  if (driver === 'relay') return 'Check USB cable, install CH340/FTDI driver, confirm COM port in Device Manager. On Linux: user must be in the dialout group.';
  if (driver === 'tcp') return 'Ping the controller IP. Open the configured TCP port on Windows Firewall / router.';
  if (driver === 'modbus') return 'Verify RS-485 A/B wiring (not swapped), 120Ω termination, matching baud rate, correct slave ID.';
  if (driver === 'wiegand') return 'Plug the Wiegand-to-serial adapter into a USB 2.0 port and install its driver.';
  return 'Recheck driver parameters in the Lane wizard.';
}

module.exports = { runFull, log, getLogs };