// Hikvision driver — routes all controller I/O through the Hikvision service
// built into this app (desktop/hardware, started by main.cjs on loopback). The
// service speaks Hikvision HCNetSDK on port 8000, replacing the deprecated
// ISAPI/HTTP path (DS-K2804 firmware ships with HTTP/HTTPS disabled by default,
// so ISAPI is unreachable).
//
// Device shape from lane config:
//   { driver: 'hikvision', params: { host, username, password, doorNo, sdkPort?, controllerId? } }
const http = require('http');

// main.cjs calls configure() once the built-in service is listening. The env
// vars let a developer point at a service started by hand instead.
let BRIDGE_HOST = process.env.VILLASAFE_BRIDGE_HOST || '127.0.0.1';
let BRIDGE_PORT = Number(process.env.VILLASAFE_BRIDGE_PORT || 8788);
let BRIDGE_TOKEN = process.env.VILLASAFE_BRIDGE_TOKEN || '';
let serviceError = null;

function configure({ host, port, token, error } = {}) {
  if (host) BRIDGE_HOST = host;
  if (port) BRIDGE_PORT = Number(port);
  if (token !== undefined) BRIDGE_TOKEN = token;
  serviceError = error || null;
}

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
      {
        host: BRIDGE_HOST, port: BRIDGE_PORT, method: 'GET', path: '/api/health', timeout: 3000,
        headers: BRIDGE_TOKEN ? { 'X-Bridge-Token': BRIDGE_TOKEN } : {},
      },
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
      'The Hikvision service inside the Gate Bridge did not start' +
      (serviceError ? ` (${serviceError})` : '') +
      '. Restart the Gate Bridge app. Underlying: ' + originalError.message,
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
      'HCNetSDK is not loaded. ' +
      `Copy the Hikvision SDK files into ${sdk.folder || 'the hcnetsdk folder'} (see INSTALL-HIKVISION.md), ` +
      'then press Retry SDK on the Health page. ' +
      (last ? `SDK error: ${last}. ` : '') +
      'Underlying: ' + originalError.message,
    );
  }
  if (/ECONNRESET/i.test(originalError.message)) {
    return new Error(
      'The Hikvision service reset the connection mid-response — check the Health page logs, then retry. ' +
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
          reject(new Error(`Hikvision: ${formatBridgeError(parsed, res.statusCode)}`));
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('Hikvision service timed out')));
    req.on('error', (err) => {
      if (err.code === 'ECONNREFUSED') {
        reject(new Error(`The built-in Hikvision service is not running on ${BRIDGE_HOST}:${BRIDGE_PORT}. Restart the Gate Bridge app.`));
      } else {
        reject(new Error(`Hikvision service unreachable: ${err.message} (${err.code || 'no-code'})`));
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
    // The next request logs in; logging in here too would spend two of the
    // controller's few password tries on every command.
    connect: false,
  });
  return id;
}

function doorNoFor(params, side) {
  // Turnstiles wired as one lane with two rotors: entryDoorNo / exitDoorNo.
  const sided = side === 'exit' ? params.exitDoorNo : side === 'entry' ? params.entryDoorNo : undefined;
  return parseInt(sided, 10) || parseInt(params.doorNo, 10) || 1;
}

async function run(device, action, opts = {}) {
  try {
    const params = device.params || {};
    const doorNo = doorNoFor(params, opts.side);
    const controllerId = await ensureController(params);
    const path = action === 'open' ? '/api/door/open' : '/api/door/close';
    await bridgeRequest('POST', path, { controllerId, doorNo });
  } catch (e) {
    throw await diagnoseBridgeFailure(e);
  }
}

// opts.background: the automatic health check — it never retries a refused password.
async function probe(device, opts = {}) {
  try {
    const params = device.params || {};
    const controllerId = await ensureController(params);
    const r = await bridgeRequest('POST', `/api/controller/${encodeURIComponent(controllerId)}/connect`, {
      background: !!opts.background,
    });
    const info = (r && r.deviceInfo && (r.deviceInfo.byDVRType || r.deviceInfo.serialNumber))
      ? `Hikvision online at ${params.host} (SDK ${params.sdkPort || 8000})`
      : `Hikvision online at ${params.host}`;
    return { ok: true, info };
  } catch (e) {
    const diag = await diagnoseBridgeFailure(e);
    return { ok: false, error: diag.message };
  }
}

module.exports = { configure, run, probe, bridgeRequest, bridgeHealth, controllerIdFor, ensureController, doorNoFor };