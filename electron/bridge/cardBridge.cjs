// Wiegand card path: reader → DS-K2804 → built-in Hikvision service → here → VillaSafe Cloud.
//
// Two jobs each sync tick:
//   1. drain buffered card swipes from the built-in Hikvision service and turn them
//      into rfidReads / gate events for the cloud,
//   2. push the approved (active, non-paused) tag list down to the bridge and
//      into every Hikvision controller so blocking survives an internet outage.
const fs = require('fs');
const os = require('os');
const path = require('path');
const hik = require('../drivers/hikvision.cjs');
const diagnostics = require('./diagnostics.cjs');

let lastProvisionSig = '';

// ---------------------------------------------------------------------------
// Card numbers as the controller shows them
//
// VillaSafe keeps tag numbers in hex (90ABCD); a Hikvision controller shows a
// Wiegand swipe as a decimal string (9481165, sometimes zero-padded). A card
// written to the controller in hex never matches its own swipe, so the boom
// wouldn't lift. The number the controller reports for each tag is learned from
// its swipes and kept on this PC; until a tag has been swiped, its decimal form
// is used.

const LEARNED_FILE = path.join(os.homedir(), '.villasafe-gate-bridge', 'controller-card-numbers.json');
const LEARNED_LIMIT = 20000;
let learned = null; // tag uid (uppercase hex) → card number as the controller reports it

function learnedMap() {
  if (learned) return learned;
  try { learned = new Map(Object.entries(JSON.parse(fs.readFileSync(LEARNED_FILE, 'utf8')))); }
  catch { learned = new Map(); }
  return learned;
}

function saveLearned() {
  try {
    fs.mkdirSync(path.dirname(LEARNED_FILE), { recursive: true });
    fs.writeFileSync(`${LEARNED_FILE}.tmp`, JSON.stringify(Object.fromEntries(learnedMap())));
    fs.renameSync(`${LEARNED_FILE}.tmp`, LEARNED_FILE);
  } catch { /* kept in memory until restart */ }
}

/** Remember how the controller showed this tag's number. True when it's new. */
function learnCardNumber(tagUid, rawCardNo) {
  const uid = String(tagUid || '').toUpperCase();
  const raw = String(rawCardNo || '').trim();
  if (!uid || !raw) return false;
  const map = learnedMap();
  if (map.get(uid) === raw) return false;
  map.delete(uid); // re-insert as newest
  map.set(uid, raw);
  while (map.size > LEARNED_LIMIT) map.delete(map.keys().next().value);
  saveLearned();
  return true;
}

/** The card number to write into a controller for this tag. */
function controllerCardNo(tagUid) {
  const uid = String(tagUid || '').replace(/[\s:_-]/g, '').toUpperCase();
  const seen = learnedMap().get(uid);
  if (seen) return seen;
  // A Wiegand-sized number (26/34-bit): the controller shows it in decimal.
  if (/^[0-9A-F]{1,9}$/.test(uid)) return BigInt(`0x${uid}`).toString(10);
  // A full EPC: a Wiegand-26 reader passes its last 3 bytes on.
  if (/^[0-9A-F]{16,}$/.test(uid)) return BigInt(`0x${uid.slice(-6)}`).toString(10);
  return uid;
}

function approvedFor(tags, laneId) {
  return (tags || [])
    .filter(t => t.is_active !== false && !t.paused)
    .filter(t => !laneId || !t.lane_id || t.lane_id === laneId);
}

/** Tell the Hikvision service which tags are approved so reads can be labelled. */
async function pushApprovedTags(tags) {
  const payload = (tags || []).map(t => ({
    tagUid: String(t.tag_uid || '').toUpperCase(),
    label: t.label || null,
    laneId: t.lane_id || null,
    paused: !!t.paused || t.is_active === false,
  })).filter(t => t.tagUid);
  await hik.bridgeRequest('POST', '/api/cards/approved', { tags: payload });
  return payload.length;
}

/** Write the approved card list into each Hikvision controller behind a lane. */
async function provisionControllers(lanes, tags) {
  const results = [];
  const seen = new Set();
  for (const lane of lanes || []) {
    for (const d of (lane.devices || []).filter(x => x.driver === 'hikvision')) {
      const params = d.params || {};
      const controllerId = hik.controllerIdFor(params);
      if (seen.has(controllerId)) continue;
      seen.add(controllerId);
      const cards = approvedFor(tags, lane.id).map(t => {
        const cardNo = controllerCardNo(t.tag_uid);
        return { cardNo, employeeNo: cardNo };
      });
      try {
        await hik.ensureController(params);
        const r = await hik.bridgeRequest('POST', '/api/cards/provision', { controllerId, cards });
        results.push(r);
      } catch (e) {
        diagnostics.log(`Card provisioning failed for ${controllerId}: ${e.message}`);
        results.push({ controllerId, error: e.message });
      }
    }
  }
  return results;
}

/**
 * Re-sync the bridge + controllers when the tag list changes — or when a
 * controller turns out to show a tag's number differently.
 * Cheap no-op when nothing changed (runs every 5s otherwise).
 */
async function syncApproved(lanes, tags, { force = false } = {}) {
  const sig = JSON.stringify((tags || [])
    .map(t => `${t.tag_uid}:${controllerCardNo(t.tag_uid)}:${t.paused ? 1 : 0}:${t.is_active === false ? 0 : 1}:${t.lane_id || ''}`)
    .sort()) + JSON.stringify((lanes || []).map(l => l.id));
  if (!force && sig === lastProvisionSig) return null;
  // After a failure, retry once a minute rather than on every 5-second tick,
  // so an unplugged controller isn't hammered with logins.
  if (!force && sig === failedSig && Date.now() < retryAt) return null;
  lastProvisionSig = sig;
  try {
    const count = await pushApprovedTags(tags);
    const provisioned = await provisionControllers(lanes, tags);
    const failed = provisioned.some(r => r.error || (r.errors && r.errors.length));
    if (failed) markFailed(sig);
    diagnostics.log(`Card list synced (${count} approved tags${failed ? ', some controllers failed — retrying in a minute' : ''})`);
    return { count, provisioned };
  } catch (e) {
    // the Hikvision service may have no controllers or no SDK (direct-reader setups)
    markFailed(sig);
    return { error: e.message };
  }
}

let failedSig = '';
let retryAt = 0;
function markFailed(sig) {
  lastProvisionSig = '';
  failedSig = sig;
  retryAt = Date.now() + 60_000;
}

/** Drain card swipes buffered by the Hikvision service. */
async function drainCardEvents() {
  try {
    const r = await hik.bridgeRequest('GET', '/api/cards/events?limit=100', null);
    return (r && r.events) || [];
  } catch {
    return [];
  }
}

/** The Hikvision devices behind the lanes, one per controller. */
function controllersOf(lanes) {
  const byId = new Map();
  for (const lane of lanes || []) {
    for (const d of (lane.devices || []).filter(x => x.driver === 'hikvision')) {
      const params = d.params || {};
      const id = hik.controllerIdFor(params);
      if (!byId.has(id)) byId.set(id, params);
    }
  }
  return byId;
}

/**
 * Listen for card swipes on every controller behind a lane, so a card held to
 * a reader wired into it reaches VillaSafe. Safe to call often: a controller
 * already listening is left alone, and one that refused the password isn't
 * logged in to again (the service's background login guard).
 */
let armFailedSig = '';
async function armControllers(lanes) {
  const controllers = controllersOf(lanes);
  if (!controllers.size) return null;
  const ids = [];
  for (const [id, params] of controllers) {
    try { await hik.ensureController(params); ids.push(id); }
    catch (e) { diagnostics.log(`Could not register controller ${id}: ${e.message}`); }
  }
  if (!ids.length) return null;
  try {
    const r = await hik.bridgeRequest('POST', '/api/cards/arm', { controllerIds: ids });
    const failed = (r && r.controllers || []).filter((c) => c && c.ok === false);
    const sig = failed.map((c) => `${c.controllerId}:${c.error}`).join('|');
    if (sig && sig !== armFailedSig) {
      diagnostics.log(`Card swipes not reaching the bridge from ${failed.map((c) => `${c.controllerId} (${c.error})`).join(', ')}`);
    }
    armFailedSig = sig;
    return r;
  } catch (e) {
    diagnostics.log(`Could not arm card channels: ${e.message}`);
    return null;
  }
}

module.exports = {
  syncApproved, drainCardEvents, armControllers, pushApprovedTags, provisionControllers,
  learnCardNumber, controllerCardNo,
};
