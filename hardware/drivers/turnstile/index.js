// Full-height turnstile driver. Two door outputs — entry and exit.
// Anti-passback state is tracked externally; this driver just pulses relays.
const door = require('../hikvision/door');

async function allowEntry(session, entryDoorNo) { return door.open(session, entryDoorNo); }
async function allowExit(session, exitDoorNo) { return door.open(session, exitDoorNo); }
async function lock(session, doorNo) { return door.close(session, doorNo); }

module.exports = { allowEntry, allowExit, lock };