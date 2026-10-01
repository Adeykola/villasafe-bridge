// Tyre-spike driver. Retract = same relay pulse as open door (spike drops).
// Raise = close (spike returns). Wired to a spare DS-K2804 door output.
const door = require('../hikvision/door');

async function retract(session, doorNo) { return door.open(session, doorNo); }
async function raise(session, doorNo) { return door.close(session, doorNo); }

module.exports = { retract, raise };