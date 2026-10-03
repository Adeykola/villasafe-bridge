const os = require('os');
const { probeDriver } = require('../drivers/index.cjs');
const hikvision = require('../drivers/hikvision.cjs');
const { gatewayHealth } = require('./pairing.cjs');
const lanReach = require('./lanReach.cjs');

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

  if (cfg.bridgeId) {
    steps.push({ id: 'licence', label: 'Desktop licence accepted by VillaSafe',
      ok: !cfg.licenseLock,
      hint: cfg.licenseLock?.message || 'Ask VillaSafe for this estate\'s desktop licence key and enter it on the Gates page.' });
  }

  // Guard phones reach this PC on port 8787 over cable or Wi-Fi.
  const lanAddrs = lanReach.lanAddresses().filter((a) => a.kind !== 'virtual');
  steps.push({ id: 'lan-address', label: lanAddrs.length
      ? `On the estate network: ${lanAddrs.map((a) => `${a.address} (${a.kind === 'wifi' ? 'Wi-Fi' : a.kind === 'ethernet' ? 'cable' : a.iface})`).join(', ')}`
      : 'On the estate network',
    ok: lanAddrs.length > 0,
    hint: 'This PC has no network address. Connect it to the estate router by cable or Wi-Fi.' });
  const fw = await lanReach.firewallStatus({ fresh: true });
  if (fw.supported) {
    steps.push({ id: 'lan-firewall', label: 'Windows Firewall lets guard phones in',
      ok: fw.state !== 'blocked',
      hint: 'Windows Firewall is blocking phones on this network (common on Wi-Fi marked "Public"). Open Offline scanning and press "Let guard phones in".' });
  }

  // The Hikvision service runs inside this app; the SDK itself is the part a
  // PC can be missing. Only a failure when a lane actually uses Hikvision.
  const usesHikvision = lanes.some((l) => (l.devices || []).some((d) => d.driver === 'hikvision'));
  const h = await hikvision.bridgeHealth();
  const sdk = h.body?.sdk;
  if (!h.reachable) {
    steps.push({ id: 'hikvision', label: 'Hikvision service running', ok: !usesHikvision,
      hint: 'The built-in Hikvision service did not start. Restart the Gate Bridge app; if it persists, send this report to support.' });
  } else {
    steps.push({ id: 'hikvision', label: sdk?.loaded ? 'Hikvision SDK loaded' : usesHikvision ? 'Hikvision SDK loaded' : 'Hikvision SDK not installed (no Hikvision devices, so not needed)',
      ok: !!sdk?.loaded || !usesHikvision,
      hint: `Copy the whole Hikvision HCNetSDK folder into ${sdk?.folder || 'the hcnetsdk folder'}, then press Retry SDK.` +
        (sdk?.lastError?.message ? ` (${sdk.lastError.message})` : '') });
  }

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
  if (driver === 'hikvision') {
    // Login refusals already carry their own fix (wrong password, locked, not activated…).
    if (/\(code: (WRONG_PASSWORD|ACCOUNT_LOCKED|UNKNOWN_USER|NOT_ACTIVATED|TOO_MANY_CONNECTIONS|SDK_MISMATCH)\)/.test(result.error || '')) return null;
    return 'Check this PC reaches the controller on SDK port 8000 (not 80) — Hikvision controllers often ignore ping — and check the admin password and door number in the Lane wizard.';
  }
  return 'Recheck driver parameters in the Lane wizard.';
}

module.exports = { runFull, log, getLogs };