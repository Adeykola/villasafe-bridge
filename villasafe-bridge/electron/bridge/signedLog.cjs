// Hash-chained + Ed25519-signed activity log.
// File: ~/.villasafe-gate-bridge/activity.log.jsonl  (one JSON entry per line)
// Keys: ~/.villasafe-gate-bridge/keys.json (private key never leaves this PC)
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const DIR = path.join(os.homedir(), '.villasafe-gate-bridge');
const LOG = path.join(DIR, 'activity.log.jsonl');
const KEYS = path.join(DIR, 'keys.json');

function ensureDir() { if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true }); }

function getKeys() {
  ensureDir();
  if (fs.existsSync(KEYS)) {
    const parsed = JSON.parse(fs.readFileSync(KEYS, 'utf8'));
    return parsed;
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = publicKey.export({ format: 'pem', type: 'spki' });
  const priv = privateKey.export({ format: 'pem', type: 'pkcs8' });
  const out = { publicKey: pub, privateKey: priv, createdAt: new Date().toISOString() };
  fs.writeFileSync(KEYS, JSON.stringify(out, null, 2), { mode: 0o600 });
  return out;
}

function publicKey() { return getKeys().publicKey; }

function lastHash() {
  if (!fs.existsSync(LOG)) return 'GENESIS';
  try {
    const lines = fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean);
    if (!lines.length) return 'GENESIS';
    const last = JSON.parse(lines[lines.length - 1]);
    return last.hash || 'GENESIS';
  } catch { return 'GENESIS'; }
}

function append(entry) {
  ensureDir();
  const keys = getKeys();
  const prevHash = lastHash();
  const canonical = JSON.stringify({
    ts: entry.ts || new Date().toISOString(),
    action: entry.action,
    laneId: entry.laneId || null,
    payload: entry.payload || {},
    prevHash,
  });
  const hash = crypto.createHash('sha256').update(canonical).digest('hex');
  const privKey = crypto.createPrivateKey(keys.privateKey);
  const signature = crypto.sign(null, Buffer.from(canonical), privKey).toString('base64');
  const line = { canonical: JSON.parse(canonical), hash, signature };
  fs.appendFileSync(LOG, JSON.stringify(line) + '\n');
  return line;
}

function verify() {
  if (!fs.existsSync(LOG)) return { ok: true, count: 0, message: 'No entries' };
  const keys = getKeys();
  const pubKey = crypto.createPublicKey(keys.publicKey);
  const lines = fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean);
  let prev = 'GENESIS';
  for (let i = 0; i < lines.length; i++) {
    let row;
    try { row = JSON.parse(lines[i]); } catch { return { ok: false, brokenAt: i + 1, reason: 'unparseable' }; }
    if (row.canonical.prevHash !== prev) return { ok: false, brokenAt: i + 1, reason: 'chain mismatch' };
    const canonical = JSON.stringify(row.canonical);
    const expectHash = crypto.createHash('sha256').update(canonical).digest('hex');
    if (expectHash !== row.hash) return { ok: false, brokenAt: i + 1, reason: 'hash mismatch' };
    const sigOk = crypto.verify(null, Buffer.from(canonical), pubKey, Buffer.from(row.signature, 'base64'));
    if (!sigOk) return { ok: false, brokenAt: i + 1, reason: 'signature mismatch' };
    prev = row.hash;
  }
  return { ok: true, count: lines.length, message: `Verified ${lines.length} entries` };
}

function tail(n = 200) {
  if (!fs.existsSync(LOG)) return [];
  const lines = fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean);
  return lines.slice(-n).map(l => JSON.parse(l));
}

module.exports = { append, verify, publicKey, tail };