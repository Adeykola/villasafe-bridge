// Buffers card swipes coming off the controller so the desktop bridge can pull
// them and forward them to VillaSafe Cloud as `rfidReads`.
const events = require('../drivers/hikvision/events');
const registry = require('../sessions/sessionRegistry');
const lanes = require('../config/lanes.store');
const log = require('../logger');
const { candidateForms } = require('../utils/wiegand');

const MAX_BUFFER = 500;
let buffer = [];       // newest last
let seq = 0;
let approved = [];     // [{ tagUid, label, laneId, paused }]
let started = false;

/** Map a controller door/reader number back to a configured lane. */
function laneForEvent(evt) {
  const all = lanes.list();
  const byDoor = all.find(l =>
    Number(l.doorNo) === Number(evt.doorNo) ||
    Number(l.entryDoorNo) === Number(evt.doorNo) ||
    Number(l.exitDoorNo) === Number(evt.doorNo));
  return byDoor || all[0] || null;
}

function matchTag(tagUid, rawCardNo) {
  const forms = new Set([...candidateForms(tagUid), ...candidateForms(rawCardNo)]);
  return approved.find(t => candidateForms(t.tagUid).some(f => forms.has(f))) || null;
}

function push(evt) {
  const lane = laneForEvent(evt);
  const tag = matchTag(evt.tagUid, evt.rawCardNo);
  const record = {
    id: ++seq,
    tagUid: evt.tagUid || evt.rawCardNo,
    rawCardNo: evt.rawCardNo,
    // Which controller it came from, so the bridge can find the lane (door
    // numbers repeat across controllers).
    controllerId: registry.byUserId(evt.userId)?.controller?.id || null,
    laneId: lane?.id || null,
    laneName: lane?.name || null,
    doorNo: evt.doorNo,
    readerNo: evt.readerNo,
    label: tag?.label || null,
    known: !!tag,
    paused: !!tag?.paused,
    authorized: !!tag && !tag.paused,
    at: evt.at || new Date().toISOString(),
  };
  buffer.push(record);
  if (buffer.length > MAX_BUFFER) buffer = buffer.slice(-MAX_BUFFER);
  return record;
}

function start() {
  if (started) return;
  started = true;
  events.onEvent((evt) => { if (evt.type === 'card') push(evt); });
  log.info('Card event service started');
}

/**
 * Arm card events on these controllers (the Gate Bridge passes the ones behind
 * its VillaSafe lanes), or on every controller in this service's own lanes.
 * Logs in as a background check, so a refused password is never retried.
 */
async function armAll(controllerIds) {
  const results = [];
  const ids = [...new Set((controllerIds && controllerIds.length ? controllerIds : lanes.list().map(l => l.controllerId)).filter(Boolean))];
  for (const id of ids) {
    try {
      const session = await registry.ensure(id, { background: true });
      results.push({ controllerId: id, ...events.subscribe(session) });
    } catch (e) {
      results.push({ controllerId: id, ok: false, error: e.message });
    }
  }
  return results;
}

/** Drain buffered reads (called by the desktop bridge each sync). */
function drain(limit = 100) {
  return buffer.splice(0, limit);
}

function peek(limit = 50) {
  return buffer.slice(-limit).reverse();
}

/** Cache the cloud's approved-tag list so reads can be labelled locally. */
function setApprovedTags(tags) {
  approved = (tags || [])
    .filter(t => t && t.tagUid)
    .map(t => ({
      tagUid: String(t.tagUid).toUpperCase(),
      label: t.label || null,
      laneId: t.laneId || null,
      paused: !!t.paused,
    }));
  return approved.length;
}

function getApprovedTags() { return approved; }

function status() {
  return {
    started,
    buffered: buffer.length,
    approvedTags: approved.length,
    listener: events.status(),
  };
}

module.exports = { start, armAll, drain, peek, push, setApprovedTags, getApprovedTags, status };
