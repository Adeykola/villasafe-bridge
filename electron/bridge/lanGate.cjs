// LAN gate mode.
//
// Keeps the estate's guest passes on this PC (codes hashed, refreshed through
// bridge-sync about once a minute) and serves a small API on the estate
// network. Guard devices signed by VillaSafe can scan a code here: the bridge
// decides locally, opens the lane straight away, and queues the check-in for
// upload — all without internet.
//
//   GET  /v1/health                → { ok, version, passes, passesAt, stale }
//   POST /v1/scan  { code | guestId, laneId, expect? } → decision (+ opens the lane when allowed)
//   POST /v1/open  { laneId, side } → manual open by a signed-in guard
//   GET  /v1/lanes                  → lanes guards can pick
//
// Every call except /health needs "Authorization: Bearer <token>" issued by the
// gate-lan-credentials function and signed with this bridge's LAN key.
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const diagnostics = require('./diagnostics.cjs');

const DIR = path.join(os.homedir(), '.villasafe-gate-bridge');
const PASSES_FILE = path.join(DIR, 'passes.json');
const SCANS_FILE = path.join(DIR, 'lan-scans.json');
const PORT = 8787;
const REFRESH_MS = 60_000;

let state = {
  tenantId: null,
  bridgeId: null,
  lanSecret: null,
  passesAt: null,
  offlineMaxHours: 24,
  passes: new Map(), // code_hash -> pass
};
let lastRequestAt = 0;
let pendingScans = [];
let server = null;
let lastAnnounce = { sig: '', at: 0 };

// ---------------------------------------------------------------------------
// Storage

function ensureDir() {
  try { if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true }); } catch {}
}

function persistPasses() {
  ensureDir();
  try {
    fs.writeFileSync(PASSES_FILE, JSON.stringify({
      tenantId: state.tenantId,
      bridgeId: state.bridgeId,
      lanSecret: state.lanSecret,
      passesAt: state.passesAt,
      offlineMaxHours: state.offlineMaxHours,
      passes: [...state.passes.values()],
    }));
  } catch (e) { diagnostics.log(`LAN: could not save passes: ${e.message}`); }
}

function persistScans() {
  ensureDir();
  try { fs.writeFileSync(SCANS_FILE, JSON.stringify(pendingScans)); } catch {}
}

function load(cfg) {
  try {
    const saved = JSON.parse(fs.readFileSync(PASSES_FILE, 'utf8'));
    if (saved.bridgeId === cfg.bridgeId) {
      state = {
        tenantId: saved.tenantId,
        bridgeId: saved.bridgeId,
        lanSecret: saved.lanSecret,
        passesAt: saved.passesAt,
        offlineMaxHours: saved.offlineMaxHours || 24,
        passes: new Map((saved.passes || []).map((p) => [p.code_hash, p])),
      };
    }
  } catch {}
  try { pendingScans = JSON.parse(fs.readFileSync(SCANS_FILE, 'utf8')) || []; } catch { pendingScans = []; }
  state.tenantId = state.tenantId || cfg.tenantId;
  state.bridgeId = cfg.bridgeId;
}

// ---------------------------------------------------------------------------
// Codes and rules (mirror of src/lib/guestScanRules.ts)

function normalizeCode(raw) {
  let code = String(raw || '').trim();
  const prefix = code.match(/^gatepass:/i);
  if (prefix) code = code.slice(prefix[0].length);
  return code.trim().toUpperCase();
}

function hashCode(tenantId, code) {
  return crypto.createHash('sha256').update(`${tenantId}:${normalizeCode(code)}`).digest('hex');
}

const isInside = (p) => p.status === 'checked-in' || (!!p.check_in_time && !p.check_out_time);
const expiryOf = (p) => new Date(p.extended_until || p.valid_until).getTime();

function decide(pass, lane, at = Date.now()) {
  const inside = isInside(pass);
  if (!inside && pass.is_revoked) return { action: 'deny', title: 'Code Revoked', reason: 'This guest code has been revoked' };
  if (!inside && new Date(pass.valid_from).getTime() > at) return { action: 'deny', title: 'Not Yet Valid', reason: `Valid from ${new Date(pass.valid_from).toLocaleString()}` };
  if (!inside && expiryOf(pass) < at) return { action: 'deny', title: 'Expired Code', reason: 'This guest code has expired' };
  if (!inside && pass.status === 'checked-out') return { action: 'deny', title: 'Already Checked Out', reason: `${pass.name} has already checked out` };

  const allowed = pass.allowed_lane_ids || [];
  if (lane && allowed.length && !allowed.includes(lane.id)) {
    return { action: 'deny', title: 'Wrong Lane', reason: `This code is not authorised for ${lane.name}` };
  }

  const direction = String(lane?.direction || 'bidirectional').toLowerCase();
  const overstay = inside && expiryOf(pass) < at;
  if (direction === 'entry') {
    return inside
      ? { action: 'deny', title: 'Already Inside', reason: `${pass.name} is already inside — use the exit lane` }
      : { action: 'check-in', side: 'entry', overstay: false };
  }
  if (direction === 'exit') {
    return inside
      ? { action: 'check-out', side: 'exit', overstay }
      : { action: 'deny', title: 'Not Checked In', reason: `${pass.name} has not checked in yet` };
  }
  return inside ? { action: 'check-out', side: 'exit', overstay } : { action: 'check-in', side: 'entry', overstay: false };
}

// ---------------------------------------------------------------------------
// Tokens

function b64urlDecode(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function verifyToken(header) {
  if (!state.lanSecret) return { error: 'This bridge has not received its LAN key yet — connect it to the internet once.' };
  const token = String(header || '').replace(/^Bearer\s+/i, '');
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return { error: 'Missing or malformed token' };
  const expected = crypto.createHmac('sha256', state.lanSecret).update(payload).digest();
  const given = b64urlDecode(sig);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return { error: 'Invalid token' };
  let claims;
  try { claims = JSON.parse(b64urlDecode(payload).toString('utf8')); } catch { return { error: 'Invalid token' }; }
  if (claims.b !== state.bridgeId) return { error: 'Token is for another bridge' };
  if (!claims.exp || claims.exp * 1000 < Date.now()) return { error: 'Token expired — sign in on the guard device while online' };
  return { claims };
}

// ---------------------------------------------------------------------------
// Sync hooks (called by commandRunner)

function needsPasses() {
  const due = !state.passesAt || Date.now() - lastRequestAt > REFRESH_MS;
  if (due) lastRequestAt = Date.now();
  return due;
}

function updateFromSync(data, cfg) {
  if (!Array.isArray(data?.guestPasses)) return;
  state.tenantId = cfg.tenantId;
  state.bridgeId = cfg.bridgeId;
  if (data.lanSecret) state.lanSecret = data.lanSecret;
  if (data.offlineMaxHours) state.offlineMaxHours = Number(data.offlineMaxHours) || 24;
  state.passesAt = data.passesAt || new Date().toISOString();
  const next = new Map(data.guestPasses.map((p) => [p.code_hash, p]));
  // Scans not yet uploaded still win over the server copy.
  for (const ev of pendingScans) {
    const hit = [...next.values()].find((p) => p.id === ev.subject_id);
    if (!hit) continue;
    if (ev.kind === 'guest-check-in') Object.assign(hit, { status: 'checked-in', check_in_time: ev.at });
    else Object.assign(hit, { status: 'checked-out', check_out_time: ev.at });
  }
  state.passes = next;
  persistPasses();
}

function drainScans() {
  const out = pendingScans;
  pendingScans = [];
  persistScans();
  return out;
}

function requeueScans(scans) {
  if (!scans?.length) return;
  pendingScans = [...scans, ...pendingScans];
  persistScans();
}

/** LAN addresses to announce; sent when they change or every 30 minutes. */
function announcement() {
  const addresses = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) addresses.push(a.address);
    }
  }
  const sig = addresses.sort().join(',');
  if (!addresses.length) return null;
  if (sig === lastAnnounce.sig && Date.now() - lastAnnounce.at < 30 * 60_000) return null;
  lastAnnounce = { sig, at: Date.now() };
  return { addresses, port: PORT };
}

const isStale = () => !state.passesAt || Date.now() - new Date(state.passesAt).getTime() > state.offlineMaxHours * 3600_000;

// ---------------------------------------------------------------------------
// HTTP API

function send(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Private-Network': 'true',
  });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 16_000) req.destroy(); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); } });
  });
}

function start(cfg, { getLanes, openLane, isOnline, onEvent, version }) {
  stop();
  load(cfg);

  server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') return send(res, 204, {});
    const url = new URL(req.url, 'http://bridge');

    if (req.method === 'GET' && url.pathname === '/v1/health') {
      return send(res, 200, { ok: true, version, passes: state.passes.size, passesAt: state.passesAt, stale: isStale(), online: isOnline() });
    }

    const auth = verifyToken(req.headers.authorization);
    if (auth.error) return send(res, 401, { error: auth.error });
    const guard = auth.claims;

    if (req.method === 'GET' && url.pathname === '/v1/lanes') {
      return send(res, 200, { lanes: (getLanes() || []).map((l) => ({ id: l.id, name: l.name, direction: l.direction || 'bidirectional' })) });
    }

    if (req.method === 'POST' && url.pathname === '/v1/open') {
      const body = await readBody(req);
      const lane = (getLanes() || []).find((l) => l.id === body.laneId);
      if (!lane) return send(res, 404, { error: 'Lane not found on this bridge' });
      const r = await openLane(lane.id, 'open', body.side);
      onEvent?.({ laneId: lane.id, action: 'open', source: 'lan-guard', success: !!r.ok, details: { guard: guard.n } });
      return send(res, r.ok ? 200 : 502, { opened: !!r.ok, error: r.error || null });
    }

    if (req.method === 'POST' && url.pathname === '/v1/scan') {
      const t0 = Date.now();
      const body = await readBody(req);
      const code = normalizeCode(body.code);
      if (!code && !body.guestId) return send(res, 400, { error: 'code or guestId required' });
      const lanes = getLanes() || [];
      const lane = body.laneId ? lanes.find((l) => l.id === body.laneId) : null;
      if (body.laneId && !lane) return send(res, 404, { error: 'Lane not found on this bridge' });

      const pass = body.guestId
        ? [...state.passes.values()].find((p) => p.id === body.guestId)
        : state.passes.get(hashCode(state.tenantId, code));
      if (!pass) {
        return send(res, 200, { decision: { action: 'deny', title: 'Invalid Code', reason: 'No guest pass with this code' }, stale: isStale(), ms: Date.now() - t0 });
      }
      const decision = decide(pass, lane);
      const guest = { id: pass.id, name: pass.name, purpose: pass.purpose, hostId: pass.host_id };
      // The caller already decided (e.g. a guard approved a check-in); if this
      // bridge sees the guest differently, record nothing and let it fall back.
      if (body.expect && decision.action !== 'deny' && decision.action !== body.expect) {
        return send(res, 200, { decision, guest, mismatch: true, stale: isStale(), ms: Date.now() - t0 });
      }
      if (decision.action === 'deny' || body.confirm === false) {
        return send(res, 200, { decision, guest, stale: isStale(), ms: Date.now() - t0 });
      }

      const at = new Date().toISOString();
      if (decision.action === 'check-in') Object.assign(pass, { status: 'checked-in', check_in_time: at });
      else Object.assign(pass, { status: 'checked-out', check_out_time: at });
      persistPasses();

      pendingScans.push({
        id: crypto.randomUUID(),
        kind: decision.action === 'check-in' ? 'guest-check-in' : 'guest-check-out',
        subject_id: pass.id,
        subject_name: pass.name,
        host_id: pass.host_id,
        lane_id: lane?.id || null,
        lane_name: lane?.name || null,
        at,
        actor_id: guard.u,
        actor_name: guard.n,
        actor_role: guard.r,
        stale: isStale(),
        offline: !isOnline(),
      });
      persistScans();

      let opened = false;
      if (lane) {
        const r = await openLane(lane.id, 'open', decision.side);
        opened = !!r.ok;
      }
      diagnostics.log(`LAN ${decision.action} ${pass.name} by ${guard.n}${lane ? ` on ${lane.name}` : ''} (${Date.now() - t0} ms)`);
      return send(res, 200, { decision, guest, opened, stale: isStale(), ms: Date.now() - t0 });
    }

    return send(res, 404, { error: 'Not found' });
  });

  server.on('error', (e) => diagnostics.log(`LAN gate server error: ${e.message}`));
  server.listen(PORT, '0.0.0.0', () => diagnostics.log(`LAN gate listening on port ${PORT} (${state.passes.size} passes)`));
}

function stop() {
  if (server) { try { server.close(); } catch {} }
  server = null;
}

function getLanStatus() {
  return { port: PORT, passes: state.passes.size, passesAt: state.passesAt, stale: isStale(), pendingScans: pendingScans.length, hasKey: !!state.lanSecret };
}

module.exports = {
  start, stop, needsPasses, updateFromSync, drainScans, requeueScans, announcement, getLanStatus,
  // exported for tests
  _internal: { decide, hashCode, normalizeCode, verifyToken, setState: (s) => Object.assign(state, s) },
};
