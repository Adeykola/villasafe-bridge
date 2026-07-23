// Hikvision driver — routes all controller I/O through the local hardware-bridge
// REST service (default http://127.0.0.1:8787). The bridge speaks Hikvision
// HCNetSDK on port 8000, replacing the deprecated ISAPI/HTTP path (DS-K2804
// firmware ships with HTTP/HTTPS disabled by default, so ISAPI is unreachable).
//
// Device shape from lane config:
//   { driver: 'hikvision', params: { host, username, password, doorNo, sdkPort?, controllerId? } }
const http = require('http');

const BRIDGE_HOST = process.env.VILLASAFE_BRIDGE_HOST || '127.0.0.1';
const BRIDGE_PORT = Number(process.env.VILLASAFE_BRIDGE_PORT || 8787);
const BRIDGE_TOKEN = process.env.VILLASAFE_BRIDGE_TOKEN || '';

// Unwrap a bridge error payload — the hardware-bridge returns errors as
// BridgeError.toJSON() objects like { code, message, hint }. A naive template
// literal renders them as "[object Object]" and hides the real cause.
function formatBridgeError(parsed, statusCode) {
  if (parsed && typeof parsed === 'object') {
    const err = parsed.error != null ? parsed.error : parsed;
    if (typeof err === 'string') return err;
    if (err && typeof err === 'object') {
      const parts = [];
      if (err.message) parts.push(String(err.message));
      else if (parsed.message) parts.push(String(parsed.message));
      if (err.code) parts.push(`(code: ${err.code})`);
      if (err.hint) parts.push(`— Hint: ${err.hint}`);
      if (parts.length) return parts.join(' ');
    }
    if (parsed.message) return String(parsed.message);
  }
  return `HTTP ${statusCode}`;
}

function bridgeHealth() {
  return new Promise((resolve) => {
    const req = http.request(
      { host: BRIDGE_HOST, port: BRIDGE_PORT, method: 'GET', path: '/api/health', timeout: 3000 },
      (res) => {
        let chunks = '';
        res.on('data', (c) => (chunks += c));
        res.on('end', () => {
          try { resolve({ reachable: true, body: JSON.parse(chunks || '{}') }); }
          catch { resolve({ reachable: true, body: {} }); }
        });
      },
    );
    req.on('timeout', () => { req.destroy(); resolve({ reachable: false, error: 'timeout' }); });
    req.on('error', (e) => resolve({ reachable: false, error: e.code || e.message }));
    req.end();
  });
}

async function diagnoseBridgeFailure(originalError) {
  const h = await bridgeHealth();
  if (!h.reachable) {
    return new Error(
      'VillaSafeHardwareBridge service is not running on this PC (127.0.0.1:8787). ' +
      'Install/start it, then retry. Underlying: ' + originalError.message,
    );
  }
  const sdk = h.body && h.body.sdk;
  if (sdk && sdk.loaded === false) {
    const le = sdk.lastError || {};
    const parts = [];
    if (le.message) parts.push(String(le.message));
    if (le.code) parts.push(`(code: ${le.code})`);
    if (le.hint) parts.push(`— Hint: ${le.hint}`);
    const last = parts.join(' ');
    return new Error(
      'Hardware bridge is running but HCNetSDK is not loaded. ' +
      'Copy the Hikvision SDK files into vendor/hcnetsdk/win-x64/ (see docs/SDK_INSTALL.md). ' +
      (last ? `SDK error: ${last}. ` : '') +
      'Underlying: ' + originalError.message,
    );
  }
  if (/ECONNRESET/i.test(originalError.message)) {
    return new Error(
      'hardware-bridge reset the connection mid-response — check its console for a crash, then retry. ' +
      'Underlying: ' + originalError.message,
    );
  }
  return originalError;
}

function bridgeRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const headers = { 'Accept': 'application/json' };
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = data.length;
    }
    if (BRIDGE_TOKEN) headers['X-Bridge-Token'] = BRIDGE_TOKEN;
    const req = http.request(
      { host: BRIDGE_HOST, port: BRIDGE_PORT, method, path, headers, timeout: 15000 },
      (res) => {
        let chunks = '';
        res.on('data', (c) => (chunks += c));
        res.on('end', () => {
          let parsed = null;
          try { parsed = chunks ? JSON.parse(chunks) : null; } catch { parsed = { raw: chunks }; }
          if (res.statusCode >= 200 && res.statusCode < 300) return resolve(parsed);
          reject(new Error(`hardware-bridge: ${formatBridgeError(parsed, res.statusCode)}`));
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('hardware-bridge timeout')));
    req.on('error', (err) => {
      if (err.code === 'ECONNREFUSED') {
        reject(new Error('hardware-bridge is not running on 127.0.0.1:8787. Start VillaSafeHardwareBridge on the guardhouse PC.'));
      } else {
        reject(new Error(`hardware-bridge unreachable: ${err.message} (${err.code || 'no-code'})`));
      }
    });
    if (data) req.write(data);
    req.end();
  });
}

function controllerIdFor(params) {
  return params.controllerId || `hik-${params.host}`.replace(/[^a-zA-Z0-9-]/g, '-');
}

async function ensureController(params) {
  const id = controllerIdFor(params);
  await bridgeRequest('POST', '/api/controller', {
    id,
    name: params.name || params.host,
    ip: params.host,
    sdkPort: Number(params.sdkPort || params.port || 8000),
    username: params.username || 'admin',
    password: params.password || '',
  });
  return id;
}

async function run(device, action) {
  try {
    const params = device.params || {};
    const doorNo = parseInt(params.doorNo, 10) || 1;
    const controllerId = await ensureController(params);
    const path = action === 'open' ? '/api/door/open' : '/api/door/close';
    await bridgeRequest('POST', path, { controllerId, doorNo });
  } catch (e) {
    throw await diagnoseBridgeFailure(e);
  }
}

async function probe(device) {
  try {
    const params = device.params || {};
    const controllerId = await ensureController(params);
    const r = await bridgeRequest('POST', `/api/controller/${encodeURIComponent(controllerId)}/connect`, {});
    const info = (r && r.deviceInfo && (r.deviceInfo.byDVRType || r.deviceInfo.serialNumber))
      ? `Hikvision online at ${params.host} (SDK ${params.sdkPort || 8000})`
      : `Hikvision online at ${params.host}`;
    return { ok: true, info };
  } catch (e) {
    const diag = await diagnoseBridgeFailure(e);
    return { ok: false, error: diag.message };
  }
}

module.exports = { run, probe };