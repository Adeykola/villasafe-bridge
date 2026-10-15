// LAN gate mode.
//
// Keeps the estate's guest passes on this PC (codes hashed, refreshed through
// bridge-sync about once a minute) and serves a small API on the estate
// network. Guard devices signed by VillaSafe can scan a code here: the bridge
// decides locally, opens the lane straight away, and queues the check-in for
// upload — all without internet.
//
//   GET  /v1/health                → { ok, bridgeId, version, passes, passesAt, stale }
//   POST /v1/scan  { code | guestId, laneId, expect? } → decision (+ opens the lane when allowed)
//   POST /v1/open  { laneId, side } → manual open by a signed-in guard
//   GET  /v1/lanes                  → lanes guards can pick
//
// Passes that are finished (used once and left, expired, revoked) can be
// removed from the PC, and clear themselves AUTO_CLEAR_HOURS after they
// finish. A removed pass is remembered so the next sync doesn't bring it back
// (unless VillaSafe makes it usable again, e.g. extends it), and a scan of it
// still says why it can't be used.
//
// Every call except /health needs "Authorization: Bearer <token>" issued by the
// gate-lan-credentials function and signed with this bridge's LAN key.
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const diagnostics = require('./diagnostics.cjs');
const lanReach = require('./lanReach.cjs');

const DIR = path.join(os.homedir(), '.villasafe-gate-bridge');
const PASSES_FILE = path.join(DIR, 'passes.json');
const SCANS_FILE = path.join(DIR, 'lan-scans.json');
// Tests run beside a real bridge on the same PC, so they can pick another port.
const PORT = Number(process.env.VILLASAFE_LAN_PORT) || lanReach.PORT;
const REFRESH_MS = 60_000;
const AUTO_CLEAR_HOURS = 12;
const REMOVED_LIMIT = 5000;

let state = {
  tenantId: null,
  bridgeId: null,
  lanSecret: null,
  passesAt: null,
  offlineMaxHours: 24,
  passes: new Map(), // code_hash -> pass
  removed: new Map(), // code_hash -> { id, name, reason, at }: finished passes taken off this PC
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
      removed: [...state.removed.entries()],
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
        removed: new Map(Array.isArray(saved.removed) ? saved.removed : []),
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

/** Why a pass can't be used any more, or null while it can (or the guest is inside). */
function finishedReason(p, at = Date.now()) {
  if (isInside(p)) return null;
  if (p.is_revoked) return 'revoked';
  if (expiryOf(p) < at) return 'expired';
  if (p.status === 'checked-out' && p.access_type !== 'recurring') return 'used';
  return null;
}

/** Where a pass is up to: inside, ready, upcoming, or finished (used, expired, revoked). */
function statusOf(p, at = Date.now()) {
  if (isInside(p)) return 'inside';
  const finished = finishedReason(p, at);
  if (finished) return finished;
  return new Date(p.valid_from).getTime() > at ? 'upcoming' : 'ready';
}

/** When a finished pass finished, for clearing it later. Revoked: when it would have run out. */
function finishedAt(p, reason) {
  if (reason === 'used') return new Date(p.check_out_time || 0).getTime() || Date.now();
  return expiryOf(p);
}

function forget(hash, p, reason, at) {
  state.passes.delete(hash);
  state.removed.delete(hash); // re-insert as newest
  state.removed.set(hash, { id: p.id, name: p.name, reason, at: new Date(at).toISOString() });
  while (state.removed.size > REMOVED_LIMIT) state.removed.delete(state.removed.keys().next().value);
}

/** Take finished passes off the PC once they've been finished for AUTO_CLEAR_HOURS. */
function autoClear(at = Date.now()) {
  let cleared = 0;
  for (const [hash, p] of state.passes) {
    const reason = finishedReason(p, at);
    if (reason && at - finishedAt(p, reason) > AUTO_CLEAR_HOURS * 3600_000) {
      forget(hash, p, reason, at);
      cleared++;
    }
  }
  return cleared;
}

/**
 * Remove finished passes now: the ones given (by pass id), or all of them.
 * Passes that can still be used, and guests inside, are never removed.
 */
function removeFinished(ids, at = Date.now()) {
  const only = Array.isArray(ids) && ids.length ? new Set(ids) : null;
  let removed = 0;
  for (const [hash, p] of state.passes) {
    if (only && !only.has(p.id)) continue;
    const reason = finishedReason(p, at);
    if (!reason) continue;
    forget(hash, p, reason, at);
    removed++;
  }
  if (removed) {
    persistPasses();
    diagnostics.log(`LAN: removed ${removed} finished pass${removed === 1 ? '' : 'es'} from this PC`);
  }
  return removed;
}

const REMOVED_DECISION = {
  used: (r) => ({ action: 'deny', title: 'Already Used', reason: `${r.name}'s pass has been used and was removed from this PC` }),
  expired: () => ({ action: 'deny', title: 'Expired Code', reason: 'This guest code has expired' }),
  revoked: () => ({ action: 'deny', title: 'Code Revoked', reason: 'This guest code has been revoked' }),
};

/** The passes on this PC for the bridge window, with where each is up to. */
function listPasses(at = Date.now()) {
  if (autoClear(at)) persistPasses();
  const order = { inside: 0, ready: 1, upcoming: 2, used: 3, expired: 4, revoked: 5 };
  const counts = { inside: 0, ready: 0, upcoming: 0, used: 0, expired: 0, revoked: 0 };
  const passes = [...state.passes.values()].map((p) => {
    const status = statusOf(p, at);
    counts[status]++;
    return {
      id: p.id,
      name: p.name,
      purpose: p.purpose || null,
      code_hint: p.code_hint || null,
      status,
      access_type: p.access_type || null,
      valid_from: p.valid_from,
      valid_until: p.extended_until || p.valid_until,
      check_in_time: p.check_in_time || null,
      check_out_time: p.check_out_time || null,
      lanes: (p.allowed_lane_ids || []).length,
    };
  });
  passes.sort((a, b) => order[a.status] - order[b.status]
    || (a.status === 'used' ? String(b.check_out_time).localeCompare(String(a.check_out_time)) : String(a.valid_until).localeCompare(String(b.valid_until))));
  return { passes, counts, removed: state.removed.size, autoClearHours: AUTO_CLEAR_HOURS, passesAt: state.passesAt };
}

function decide(pass, lane, at = Date.now()) {
  const inside = isInside(pass);
  if (!inside && pass.is_revoked) return { action: 'deny', title: 'Code Revoked', reason: 'This guest code has been revoked' };
  if (!inside && new Date(pass.valid_from).getTime() > at) return { action: 'deny', title: 'Not Yet Valid', reason: `Valid from ${new Date(pass.valid_from).toLocaleString()}` };
  if (!inside && expiryOf(pass) < at) return { action: 'deny', title: 'Expired Code', reason: 'This guest code has expired' };
  // Recurring passes (regular visitors, contractors) come and go until they expire.
  if (!inside && pass.status === 'checked-out' && pass.access_type !== 'recurring') return { action: 'deny', title: 'Already Checked Out', reason: `${pass.name} has already checked out` };

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
  // Passes taken off this PC stay off while they're still finished; one that
  // VillaSafe makes usable again comes back. Removals VillaSafe no longer
  // sends are forgotten.
  for (const hash of [...state.removed.keys()]) {
    const p = next.get(hash);
    if (!p) state.removed.delete(hash);
    else if (finishedReason(p)) next.delete(hash);
    else state.removed.delete(hash);
  }
  state.passes = next;
  autoClear();
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

/**
 * LAN addresses to announce, best first (phones try them in this order), sent
 * when they change — e.g. the PC moves from cable to Wi-Fi or DHCP hands it a
 * new address — or every 30 minutes.
 */
function announcement() {
  const addresses = lanReach.lanAddresses().map((a) => a.address);
  const sig = addresses.join(',');
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

function start(cfg, { getLanes, openLane, isOnline, isLicensed = () => true, onEvent, version }) {
  stop();
  load(cfg);

  server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') return send(res, 204, {});
    const url = new URL(req.url, 'http://bridge');

    if (req.method === 'GET' && url.pathname === '/v1/health') {
      // bridgeId lets a phone that lost this PC's address recognise it again.
      return send(res, 200, { ok: true, bridgeId: state.bridgeId, version, passes: state.passes.size, passesAt: state.passesAt, stale: isStale(), online: isOnline() });
    }

    const auth = verifyToken(req.headers.authorization);
    if (auth.error) return send(res, 401, { error: auth.error });
    const guard = auth.claims;

    // Without a desktop licence this PC can't open lanes or record check-ins;
    // guard devices fall back to checking in through VillaSafe.
    if (req.method === 'POST' && !isLicensed()) {
      return send(res, 503, { error: 'This gate PC is locked until the estate enters its VillaSafe desktop licence key.' });
    }

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
        // Taken off this PC once it was finished: still say why it can't be used.
        const gone = body.guestId
          ? [...state.removed.values()].find((r) => r.id === body.guestId)
          : state.removed.get(hashCode(state.tenantId, code));
        if (gone) {
          return send(res, 200, { decision: REMOVED_DECISION[gone.reason]?.(gone) || REMOVED_DECISION.used(gone), stale: isStale(), ms: Date.now() - t0 });
        }
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
  const { counts } = listPasses();
  return {
    port: PORT, addresses: lanReach.lanAddresses(), passes: state.passes.size, passesAt: state.passesAt, stale: isStale(), pendingScans: pendingScans.length, hasKey: !!state.lanSecret,
    // Passes a guest can still use (or is inside on), and finished ones still on the PC.
    usable: counts.ready + counts.upcoming + counts.inside,
    inside: counts.inside,
    finished: counts.used + counts.expired + counts.revoked,
  };
}

module.exports = {
  start, stop, needsPasses, updateFromSync, drainScans, requeueScans, announcement, getLanStatus,
  listPasses, removeFinished,
  // exported for tests
  _internal: { decide, statusOf, finishedReason, autoClear, hashCode, normalizeCode, verifyToken, setState: (s) => Object.assign(state, s), AUTO_CLEAR_HOURS },
};
