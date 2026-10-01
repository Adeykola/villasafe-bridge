// Central logger — pino JSON to stdout + a ring buffer the UI can tail.
const pino = require('pino');

const RING_SIZE = 500;
const ring = [];

function push(entry) {
  ring.push(entry);
  if (ring.length > RING_SIZE) ring.shift();
}

const base = pino({ level: process.env.LOG_LEVEL || 'info' });

function wrap(level) {
  return (msg, ctx) => {
    const entry = { ts: new Date().toISOString(), level, msg, ...ctx };
    push(entry);
    base[level](ctx || {}, msg);
  };
}

module.exports = {
  info: wrap('info'),
  warn: wrap('warn'),
  error: wrap('error'),
  debug: wrap('debug'),
  tail: (limit = 100, filter = {}) => {
    let out = ring;
    if (filter.controllerId) out = out.filter(e => e.controllerId === filter.controllerId);
    if (filter.laneId) out = out.filter(e => e.laneId === filter.laneId);
    return out.slice(-limit);
  },
};