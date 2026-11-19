// RFID tags kept on this PC, the same way LAN gate mode keeps guest passes.
//
// Each sync brings the estate's full tag list (with what VillaSafe knows: is it
// suspended, is the resident owing, when does it run out). It's saved to disk,
// so after a restart with no internet the PC still knows every tag, and every
// read — S4A reader on serial/TCP, or a Wiegand card through the Hikvision
// controller — is decided here by one rule:
//
//   suspended  → refused (estate switched it off)
//   owing      → refused (resident has an overdue bill, unless overridden).
//                VillaSafe also sends owing_from: when the resident's next
//                unpaid bill falls overdue. Checked against this PC's clock,
//                so a bill that falls due during an outage pauses the tag on
//                time, with no internet.
//   expired    → refused (valid_until has passed — checked against this PC's
//                clock, so it expires on time even offline)
//   wrong lane → refused
//   wrong kind of lane → refused: a tag the estate set to vehicle lanes only
//                (a windscreen tag) at a pedestrian turnstile, or a card set to
//                pedestrian gates only at a boom barrier
//   otherwise  → opens
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = path.join(os.homedir(), '.villasafe-gate-bridge');
const FILE = path.join(DIR, 'rfid-tags.json');

let state = { bridgeId: null, savedAt: null, tags: [] };

const uidOf = (t) => String(t?.tag_uid || '').toUpperCase();

function load(bridgeId) {
  try {
    const saved = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (saved.bridgeId === bridgeId && Array.isArray(saved.tags)) state = saved;
    else state = { bridgeId, savedAt: null, tags: [] };
  } catch {
    state = { bridgeId, savedAt: null, tags: [] };
  }
  return state.tags;
}

function save(bridgeId, tags) {
  state = { bridgeId, savedAt: new Date().toISOString(), tags: Array.isArray(tags) ? tags : [] };
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, FILE);
  } catch { /* the in-memory copy still works until restart */ }
  return state.tags;
}

function clear() {
  state = { bridgeId: null, savedAt: null, tags: [] };
  try { fs.unlinkSync(FILE); } catch { /* none saved */ }
}

const tags = () => state.tags;
const savedAt = () => state.savedAt;

/**
 * Same card? The same number, the same with leading zeros, or a Wiegand number
 * that is the end of an EPC: a reader on Wiegand-26 passes only the last 6 hex
 * digits on (Wiegand-34, the last 8). So a card enrolled from the number
 * printed on it still opens when the long-range reader sends the full EPC.
 */
function sameCard(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const az = a.replace(/^0+/, '');
  if (az && az === b.replace(/^0+/, '')) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return long.length >= 16 && (short.length === 6 || short.length === 8) && long.endsWith(short);
}

/** The enrolled tag for a read: an exact match, else the one tag it can only be. */
function find(uid) {
  const want = String(uid || '').replace(/[\s:_-]/g, '').toUpperCase();
  if (!want) return null;
  const exact = state.tags.find((t) => uidOf(t) === want);
  if (exact) return exact;
  const close = state.tags.filter((t) => sameCard(want, uidOf(t)));
  return close.length === 1 ? close[0] : null;
}

/**
 * Who a lane is for: 'vehicle', 'pedestrian' or 'both'. The estate sets it on
 * the lane (traffic); a lane saved before that is worked out from its devices:
 * a turnstile alone is for people on foot, a boom or tyre killer for vehicles.
 * Null when there's no lane to go by.
 */
function laneTraffic(lane) {
  if (!lane) return null;
  const set = String(lane.traffic || '').toLowerCase();
  if (set === 'vehicle' || set === 'pedestrian' || set === 'both') return set;
  const kinds = new Set((lane.devices || []).map((d) => d.kind));
  const onFoot = kinds.has('turnstile');
  const driving = kinds.has('barrier') || kinds.has('spike');
  if (onFoot && !driving) return 'pedestrian';
  if (driving && !onFoot) return 'vehicle';
  return 'both';
}

/** Where a tag may open: 'vehicle' lanes, 'pedestrian' gates, or 'any' (every lane, as before). */
function accessOf(tag) {
  const mode = String(tag?.access_mode || '').toLowerCase();
  return mode === 'vehicle' || mode === 'pedestrian' ? mode : 'any';
}

/** Why this tag may not open a lane for this traffic, or null when it may. */
function trafficRefusal(tag, traffic) {
  const mode = accessOf(tag);
  if (mode === 'vehicle' && traffic === 'pedestrian') return 'vehicle_only';
  if (mode === 'pedestrian' && traffic === 'vehicle') return 'pedestrian_only';
  return null;
}

const fitsTraffic = (tag, traffic) => !trafficRefusal(tag, traffic);

/**
 * Why a tag may not open, or null when it may.
 * traffic: who the lane is for (laneTraffic), when the read came from a lane.
 * @returns {null | 'unknown' | 'suspended' | 'owing' | 'expired' | 'wrong_lane' | 'vehicle_only' | 'pedestrian_only'}
 */
function refusal(tag, laneId, now = Date.now(), traffic = null) {
  if (!tag) return 'unknown';
  if (tag.is_active === false) return 'suspended';
  if (tag.paused) return tag.pause_reason === 'owing' || !tag.pause_reason ? 'owing' : tag.pause_reason;
  if (tag.owing_from && !tag.owing_override && new Date(tag.owing_from).getTime() <= now) return 'owing';
  if (tag.valid_until && new Date(tag.valid_until).getTime() <= now) return 'expired';
  if (tag.lane_id && laneId && tag.lane_id !== laneId) return 'wrong_lane';
  return trafficRefusal(tag, traffic);
}

const REASON_TEXT = {
  unknown: 'unknown tag',
  suspended: 'suspended by the estate',
  owing: 'resident has an overdue bill',
  expired: 'access has expired',
  wrong_lane: 'tag not allowed on this lane',
  vehicle_only: 'vehicle tag — not for a pedestrian gate',
  pedestrian_only: 'pedestrian card — not for a vehicle lane',
};

/** Tags allowed to open right now (optionally on one lane). */
function allowed(laneId, now = Date.now()) {
  return state.tags.filter((t) => !refusal(t, laneId, now));
}

/**
 * The same list with `paused` set for anything that may not open now, for the
 * code that pushes approved cards into Hikvision controllers.
 */
function effective(now = Date.now()) {
  return state.tags.map((t) => {
    const why = refusal(t, null, now);
    return why ? { ...t, paused: true, pause_reason: why } : t;
  });
}

/**
 * Changes whenever which tags may open changes — including a tag expiring
 * with no sync at all — so readers and controllers can be refreshed.
 */
function signature(now = Date.now()) {
  return state.tags
    .map((t) => `${uidOf(t)}:${refusal(t, null, now) || 'ok'}:${t.lane_id || ''}:${accessOf(t)}`)
    .sort()
    .join('|');
}

module.exports = {
  load, save, clear, tags, savedAt, find, refusal, allowed, effective, signature, REASON_TEXT,
  laneTraffic, accessOf, fitsTraffic,
};
