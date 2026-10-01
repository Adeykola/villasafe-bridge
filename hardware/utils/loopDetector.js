// Loop detector abstraction. The physical loop is wired to a separate relay
// board (not the DS-K2804 alarm input), so we poll a status callback the
// lane wiring provides. Falls back to a timed wait when no probe is bound.
const log = require('../logger');

async function wait(cond, { timeoutMs, pollMs = 200, label }) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (await cond()) return true;
    } catch (e) {
      log.warn(`loopDetector.${label} probe failed`, { error: e.message });
    }
    await new Promise(r => setTimeout(r, pollMs));
  }
  return false;
}

// probeActive() → boolean (true while a vehicle is over the loop)
async function waitForActive(probeActive, { timeoutMs = 15000 } = {}) {
  if (!probeActive) { await new Promise(r => setTimeout(r, 2000)); return true; }
  return wait(probeActive, { timeoutMs, label: 'waitForActive' });
}

async function waitForClear(probeActive, { timeoutMs = 60000 } = {}) {
  if (!probeActive) { await new Promise(r => setTimeout(r, 4000)); return true; }
  return wait(async () => !(await probeActive()), { timeoutMs, label: 'waitForClear' });
}

module.exports = { waitForActive, waitForClear };