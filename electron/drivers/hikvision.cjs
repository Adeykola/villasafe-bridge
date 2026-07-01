// Hikvision network access controller driver (DS-K2804 / K2700 / K2600 series).
// One controller has up to 4 relay outputs (Door 1-4). Create one lane per
// door, all pointing at the same host with a different `doorNo`.
// Uses ISAPI over HTTP Digest auth — no vendor SDK required.
const http = require('http');
const crypto = require('crypto');

function md5(s) { return crypto.createHash('md5').update(s).digest('hex'); }

function request(params, method, path, body) {
  return new Promise((resolve, reject) => {
    const { host, port = 80, username = 'admin', password = '' } = params;
    const data = body ? Buffer.from(JSON.stringify(body)) : null;

    const doRequest = (authHeader) => {
      const headers = { 'Content-Type': 'application/json' };
      if (data) headers['Content-Length'] = data.length;
      if (authHeader) headers['Authorization'] = authHeader;
      const req = http.request({ host, port, method, path, headers, timeout: 4000 }, (res) => {
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
      });
      req.on('timeout', () => { req.destroy(new Error('Hikvision request timeout')); });
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    };

    doRequest(null);
  });
}

async function run(device, action) {
  const doorNo = parseInt(device.params.doorNo, 10) || 1;
  const cmd = action === 'open' ? 'open' : 'close';
  const path = `/ISAPI/AccessControl/RemoteControl/door/${doorNo}`;
  await request(device.params, 'PUT', path, { RemoteControlDoor: { cmd } });
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