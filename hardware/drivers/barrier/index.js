// Boom-barrier driver. On Hikvision-connected barriers, "open" is the same
// gateway relay pulse — the barrier auto-closes when the loop clears. This
// wrapper exists so laneManager can compose drivers polymorphically and so
// non-Hikvision barrier boards can be added without touching services.
const door = require('../hikvision/door');

async function open(session, doorNo) { return door.open(session, doorNo); }
async function close(session, doorNo) { return door.close(session, doorNo); }

module.exports = { open, close };