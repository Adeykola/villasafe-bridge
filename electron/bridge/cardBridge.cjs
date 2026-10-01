// Wiegand card path: reader → DS-K2804 → built-in Hikvision service → here → VillaSafe Cloud.
//
// Two jobs each sync tick:
//   1. drain buffered card swipes from the built-in Hikvision service and turn them
//      into rfidReads / gate events for the cloud,
//   2. push the approved (active, non-paused) tag list down to the bridge and
//      into every Hikvision controller so blocking survives an internet outage.
const hik = require('../drivers/hikvision.cjs');
const diagnostics = require('./diagnostics.cjs');

let lastProvisionSig = '';

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
      const cards = approvedFor(tags, lane.id).map(t => ({
        cardNo: String(t.tag_uid).toUpperCase(),
        employeeNo: String(t.tag_uid).toUpperCase(),
      }));
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
 * Re-sync the bridge + controllers when the tag list changes.
 * Cheap no-op when nothing changed (runs every 5s otherwise).
 */
async function syncApproved(lanes, tags, { force = false } = {}) {
  const sig = JSON.stringify((tags || [])
    .map(t => `${t.tag_uid}:${t.paused ? 1 : 0}:${t.is_active === false ? 0 : 1}:${t.lane_id || ''}`)
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

/** Arm the alarm channels (called on startup and after lane changes). */
async function armControllers() {
  try { return await hik.bridgeRequest('POST', '/api/cards/arm', {}); }
  catch (e) { diagnostics.log(`Could not arm card channels: ${e.message}`); return null; }
}

module.exports = { syncApproved, drainCardEvents, armControllers, pushApprovedTags, provisionControllers };
