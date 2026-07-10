// Hikvision network access controller driver (DS-K2804 / K2700 / K2600 series).
// One controller has up to 4 relay outputs (Door 1-4). Create one lane per
// door, all pointing at the same host with a different `doorNo`.
// Uses ISAPI over HTTP Digest auth — no vendor SDK required.
const http = require('http');
const https = require('https');
const crypto = require('crypto');

function md5(s) { return crypto.createHash('md5').update(s).digest('hex'); }

const TRANSIENT = new Set(['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNREFUSED', 'EHOSTUNREACH']);

function requestOnce(params, method, path, body, contentType, useHttps) {
  return new Promise((resolve, reject) => {
    const { host, username = 'admin', password = '' } = params;
    const port = useHttps ? (params.httpsPort || 443) : (params.port || 80);
    const lib = useHttps ? https : http;
    const data = body
      ? Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
      : null;

    const doRequest = (authHeader) => {
      const headers = {
        'Content-Type': contentType,
        'Accept': '*/*',
        'Connection': 'close',
        'User-Agent': 'VillaSafeBridge/1.0',
      };
      if (data) headers['Content-Length'] = data.length;
      if (authHeader) headers['Authorization'] = authHeader;
      const opts = { host, port, method, path, headers, timeout: 8000 };
      if (useHttps) opts.rejectUnauthorized = false;
      const req = lib.request(opts, (res) => {
        let chunks = '';
        res.on('data', (c) => (chunks += c));
        res.on('end', () => {
          if (res.statusCode === 401 && !authHeader && res.headers['www-authenticate']) {
            const wa = res.headers['www-authenticate'];
            const parts = {};
            wa.replace(/(\w+)="?([^",]+)"?/g, (_, k, v) => { parts[k.toLowerCase()] = v; });
            const nc = '00000001';
            const cnonce = crypto.randomBytes(8).toString('hex');
            const ha1 = md5(`${username}:${parts.realm}:${password}`);
            const ha2 = md5(`${method}:${path}`);
            const response = md5(`${ha1}:${parts.nonce}:${nc}:${cnonce}:${parts.qop || 'auth'}:${ha2}`);
            const auth = `Digest username="${username}", realm="${parts.realm}", nonce="${parts.nonce}", uri="${path}", qop=${parts.qop || 'auth'}, nc=${nc}, cnonce="${cnonce}", response="${response}"`;
            doRequest(auth);
          } else if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ status: res.statusCode, body: chunks });
          } else {
            reject(new Error(`Hikvision HTTP ${res.statusCode}: ${chunks.slice(0, 200)}`));
          }
        });
        res.on('error', (err) => reject(decorate(err, host, port)));
      });
      req.on('timeout', () => { req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })); });
      req.on('error', (err) => reject(decorate(err, host, port)));
      if (data) req.write(data);
      req.end();
    };

    doRequest(null);
  });
}

function decorate(err, host, port) {
  const code = err.code || '';
  const hint =
    code === 'ECONNRESET' ? 'controller closed the socket — HTTP/ISAPI may be disabled or port wrong' :
    code === 'ETIMEDOUT' ? 'no reply from controller — check LAN reachability' :
    code === 'ECONNREFUSED' ? 'nothing listening on that port' :
    code === 'EHOSTUNREACH' ? 'no route to controller' :
    err.message || 'unknown error';
  const e = new Error(`Hikvision ${code || 'error'} at ${host}:${port} — ${hint}`);
  e.code = code;
  return e;
}

async function request(params, method, path, body, contentType = 'application/xml') {
  // Attempt: HTTP → HTTP retry (transient) → HTTPS → HTTPS retry
  const attempts = [
    { useHttps: false },
    { useHttps: false, backoff: 250 },
    { useHttps: true },
    { useHttps: true, backoff: 250 },
  ];
  let lastErr;
  for (const a of attempts) {
    if (a.backoff) await new Promise(r => setTimeout(r, a.backoff));
    try {
      return await requestOnce(params, method, path, body, contentType, a.useHttps);
    } catch (e) {
      lastErr = e;
      // Only retry / fall through on transient socket errors
      if (!TRANSIENT.has(e.code)) throw e;
    }
  }
  throw lastErr;
}

async function run(device, action) {
  const doorNo = parseInt(device.params.doorNo, 10) || 1;
  const cmd = action === 'open' ? 'open' : 'close';
  const path = `/ISAPI/AccessControl/RemoteControl/door/${doorNo}`;
  const xml = `<?xml version="1.0" encoding="UTF-8"?><RemoteControlDoor><cmd>${cmd}</cmd></RemoteControlDoor>`;
  try {
    await request(device.params, 'PUT', path, xml, 'application/xml');
  } catch (e) {
    if (/HTTP 400/.test(e.message)) {
      await request(
        device.params,
        'PUT',
        `${path}?format=json`,
        JSON.stringify({ RemoteControlDoor: { cmd } }),
        'application/json',
      );
    } else {
      throw e;
    }
  }
}

async function probe(device) {
  try {
    const res = await request(device.params, 'GET', '/ISAPI/System/deviceInfo', null);
    return { ok: true, info: `Hikvision reachable at ${device.params.host} (HTTP ${res.status})` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { run, probe };