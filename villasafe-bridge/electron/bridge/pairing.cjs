const os = require('os');
const Store = require('../config/laneStore.cjs');
const pkg = require('../../package.json');

const BRIDGE_VERSION = pkg.version || '1.0.0';
const FALLBACKS = [Store.DEFAULT_GATEWAY_URL];
const FUNCTION_SEGMENTS = new Set(['pair-gate-bridge', 'bridge-sync']);

function cleanBase(base) {
  const normalized = Store.normalizeGatewayUrl(base || Store.DEFAULT_GATEWAY_URL).replace(/\/$/, '');
  try {
    const url = new URL(normalized);
    const parts = url.pathname.split('/').filter(Boolean);
    while (parts.length && FUNCTION_SEGMENTS.has(parts[parts.length - 1])) parts.pop();
    url.pathname = parts.length ? `/${parts.join('/')}` : '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return Store.DEFAULT_GATEWAY_URL;
  }
}

function displayGateway(base) {
  return /villasafe\.com/i.test(base) ? 'VillaSafe gateway' : 'Configured gateway';
}

function userMessage(message) {
  if (/token_expired/i.test(message)) return 'Token expired — re-pairing required';
  if (/missing bridgeId/i.test(message)) return 'Bridge ID missing — please unpair and pair again';
  if (/missing bridgeToken|pairingCode/i.test(message)) return 'Bridge token missing — please pair again';
  if (/blank response/i.test(message)) return 'VillaSafe gateway returned a blank response. Check that /bridge routes are deployed.';
  if (/HTML response/i.test(message)) return 'VillaSafe gateway returned a web page instead of JSON. Check that /bridge routes are deployed.';
  if (/non-JSON|invalid JSON/i.test(message)) return 'VillaSafe gateway returned an invalid response. Check that /bridge routes are deployed.';
  return message;
}

async function safeFetch(url, body) {
  let res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    redirect: 'manual',
  });
  if ([301, 302, 303, 307, 308].includes(res.status)) {
    const location = res.headers.get('location');
    if (!location) throw new Error(`HTTP ${res.status}: gateway redirected without a destination`);
    res = await fetch(new URL(location, url).toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'manual',
    });
  }
  const text = await res.text();
  const contentType = res.headers.get('content-type') || 'unknown';
  if (!text.trim()) {
    throw new Error(`HTTP ${res.status}: gateway returned a blank response (content-type: ${contentType})`);
  }
  if (/text\/html/i.test(contentType) || /^\s*</.test(text)) {
    throw new Error(`HTTP ${res.status}: gateway returned an HTML response (content-type: ${contentType})`);
  }
  let data = null;
  try { data = JSON.parse(text); }
  catch {
    throw new Error(`HTTP ${res.status}: gateway returned invalid JSON (content-type: ${contentType}, body: ${text.slice(0, 80)})`);
  }
  if (!res.ok) throw new Error(`${data?.error || `HTTP ${res.status}`}${data?.hint ? ` — ${data.hint}` : ''}`);
  return data;
}

async function gatewayHealth(gatewayUrl) {
  try {
    const { data, gatewayUsed } = await callWithFallback(gatewayUrl, '/pair-gate-bridge', {
      healthCheck: true,
      version: BRIDGE_VERSION,
      hostname: os.hostname(),
    });
    return { ok: !!data?.ok, gatewayUsed, message: data?.message || 'Gateway ready' };
  } catch (e) {
    return { ok: false, error: userMessage(e.message), rawError: e.message };
  }
}

async function callWithFallback(primary, path, body) {
  const tried = [];
  const normalizedPrimary = cleanBase(primary);
  const candidates = [normalizedPrimary, ...FALLBACKS.filter((u) => u && cleanBase(u) !== normalizedPrimary).map(cleanBase)];
  let lastErr = null;
  for (const base of candidates) {
    try {
      const data = await safeFetch(`${base}${path}`, body);
      if (base !== primary) {
        try { Store.update({ gatewayUrl: base }); } catch {}
      }
      return { data, gatewayUsed: base };
    } catch (e) {
      tried.push(`${displayGateway(base)}: ${userMessage(e.message)}`);
      lastErr = e;
    }
  }
  const err = new Error(`All gateways failed.\n${tried.join('\n')}`);
  err.cause = lastErr;
  throw err;
}

async function previewPairing(gatewayUrl, code) {
  try {
    const health = await gatewayHealth(gatewayUrl);
    if (!health.ok) throw new Error(health.error || 'VillaSafe gateway is not ready');
    const { data } = await callWithFallback(gatewayUrl, '/pair-gate-bridge', {
      code, hostname: os.hostname(), version: BRIDGE_VERSION, confirmOnly: false,
    });
    return { ok: true, preview: data };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function pairWithCode(gatewayUrl, code, publicKey) {
  try {
    const health = await gatewayHealth(gatewayUrl);
    if (!health.ok) throw new Error(health.error || 'VillaSafe gateway is not ready');
    const { data } = await callWithFallback(gatewayUrl, '/pair-gate-bridge', {
      code, hostname: os.hostname(), version: BRIDGE_VERSION, publicKey,
    });
    return {
      ok: true,
      bridgeId: data.bridgeId,
      tenantId: data.tenantId,
      tenantName: data.tenantName,
      bridgeToken: data.bridgeToken,
      tokenExpiresAt: data.tokenExpiresAt,
      lanes: data.lanes || [],
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { pairWithCode, previewPairing, safeFetch, callWithFallback, gatewayHealth, cleanBase, BRIDGE_VERSION };