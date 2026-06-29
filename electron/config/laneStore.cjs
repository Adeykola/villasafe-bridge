const fs = require('fs');
const path = require('path');
const os = require('os');

const DIR = path.join(os.homedir(), '.villasafe-gate-bridge');
const FILE = path.join(DIR, 'config.json');

// The desktop app ships with ONE non-sensitive value: the VillaSafe gateway URL.
// All traffic is proxied by villasafe.com to the backend — no backend URL or
// anon key is bundled with the desktop binary.
const DEFAULT_GATEWAY_URL = 'https://villasafe.com/bridge';

function normalizeGatewayUrl(value) {
  const raw = String(value || '').trim().replace(/\/$/, '');
  if (!raw) return DEFAULT_GATEWAY_URL;
  // Heal older installs that stored direct backend function hosts. The bridge
  // should only talk to the VillaSafe gateway so internal project URLs are not
  // exposed in the desktop app or diagnostics.
  if (/supabase\.co|functions\.supabase\.co/i.test(raw)) return DEFAULT_GATEWAY_URL;
  try {
    const url = new URL(raw);
    const parts = url.pathname.split('/').filter(Boolean);
    while (['pair-gate-bridge', 'bridge-sync'].includes(parts[parts.length - 1])) parts.pop();
    url.pathname = parts.length ? `/${parts.join('/')}` : '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return DEFAULT_GATEWAY_URL;
  }
}

function load() {
  try {
    if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
    if (!fs.existsSync(FILE)) return defaults();
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const merged = { ...defaults(), ...parsed };
    // Strip any legacy Supabase credentials that older installs may have stored.
    let mutated = false;
    if ('supabaseUrl' in merged) { delete merged.supabaseUrl; mutated = true; }
    if ('supabaseAnonKey' in merged) { delete merged.supabaseAnonKey; mutated = true; }
    const normalizedGateway = normalizeGatewayUrl(merged.gatewayUrl);
    if (merged.gatewayUrl !== normalizedGateway) { merged.gatewayUrl = normalizedGateway; mutated = true; }
    if (mutated) {
      try { fs.writeFileSync(FILE, JSON.stringify(merged, null, 2)); } catch {}
    }
    return merged;
  } catch {
    return defaults();
  }
}

function update(patch) {
  const cur = load();
  const next = { ...cur, ...patch };
  if ('gatewayUrl' in next) next.gatewayUrl = normalizeGatewayUrl(next.gatewayUrl);
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2));
  return next;
}

function defaults() {
  return {
    gatewayUrl: DEFAULT_GATEWAY_URL,
    bridgeId: null,
    tenantId: null,
    bridgeToken: null,
    lanesCache: [],
    eventQueue: [],
  };
}

module.exports = { load, update, DEFAULT_GATEWAY_URL, normalizeGatewayUrl };