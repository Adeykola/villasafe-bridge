// Orchestrates the open-lane sequence across barrier / spike / turnstile.
// Never force-closes the barrier while the loop detector is active.
const lanes = require('../config/lanes.store');
const registry = require('../sessions/sessionRegistry');
const barrier = require('../drivers/barrier');
const spike = require('../drivers/tyreSpike');
const turnstile = require('../drivers/turnstile');
const door = require('../drivers/hikvision/door');
const loop = require('../utils/loopDetector');
const log = require('../logger');
const { BridgeError } = require('../utils/errorMap');

function getLane(id) {
  const lane = lanes.get(id);
  if (!lane) throw new BridgeError('LANE_NOT_FOUND', `Unknown lane ${id}`);
  return lane;
}

// side: 'entry' | 'exit' — a full-height turnstile is one lane with two rotors,
// so the caller tells us which side to release.
async function openLane(laneId, { loopProbe, side } = {}) {
  const lane = getLane(laneId);
  const session = await registry.ensure(lane.controllerId);
  const ctx = { laneId, controllerId: lane.controllerId, side: side || 'entry' };
  log.info('Lane open sequence start', ctx);

  const sideDoorNo = side === 'exit' ? lane.exitDoorNo : lane.entryDoorNo;
  if (lane.turnstileEnabled && sideDoorNo) {
    if (side === 'exit' && typeof turnstile.allowExit === 'function') {
      await turnstile.allowExit(session, sideDoorNo);
    } else {
      await turnstile.allowEntry(session, sideDoorNo);
    }
  } else {
    await barrier.open(session, sideDoorNo || lane.doorNo);
  }
  if (lane.tyreSpikeEnabled) await spike.retract(session, lane.doorNo);

  if (lane.loopDetectorEnabled) {
    const wentActive = await loop.waitForActive(loopProbe, { timeoutMs: 20000 });
    if (!wentActive) log.warn('Loop never went active — closing early', ctx);
    await loop.waitForClear(loopProbe, { timeoutMs: 60000 });
  }

  if (lane.tyreSpikeEnabled) await spike.raise(session, lane.doorNo);
  if (!lane.turnstileEnabled) await barrier.close(session, lane.doorNo);
  log.info('Lane open sequence complete', ctx);
}

async function closeLane(laneId) {
  const lane = getLane(laneId);
  const session = await registry.ensure(lane.controllerId);
  await door.close(session, lane.doorNo);
}

async function openDoor(controllerId, doorNo) {
  const session = await registry.ensure(controllerId);
  await door.open(session, doorNo);
}
async function closeDoor(controllerId, doorNo) {
  const session = await registry.ensure(controllerId);
  await door.close(session, doorNo);
}

module.exports = { openLane, closeLane, openDoor, closeDoor, list: lanes.list, upsert: lanes.upsert, remove: lanes.remove, get: lanes.get };