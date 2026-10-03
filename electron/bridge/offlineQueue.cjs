const fs = require('fs');
const path = require('path');
const os = require('os');

const DIR = path.join(os.homedir(), '.villasafe-gate-bridge');
const FILE = path.join(DIR, 'queue.json');

function load() {
  try {
    if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
    if (!fs.existsSync(FILE)) return { events: [], commandResults: [], pendingCommands: [], rfidReads: [] };
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!data.pendingCommands) data.pendingCommands = [];
    if (!data.rfidReads) data.rfidReads = [];
    return data;
  } catch {
    return { events: [], commandResults: [], pendingCommands: [], rfidReads: [] };
  }
}

function save(q) {
  try { fs.writeFileSync(FILE, JSON.stringify(q, null, 2)); } catch {}
}

function enqueueEvent(evt) {
  const q = load();
  q.events.push({ ...evt, replayed: true, queuedAt: Date.now() });
  save(q);
}

function enqueueResult(r) {
  const q = load();
  q.commandResults.push(r);
  save(q);
}

function enqueuePendingCommand(c) {
  const q = load();
  q.pendingCommands.push({ ...c, queuedAt: Date.now() });
  save(q);
}

function drainPendingCommands() {
  const q = load();
  const out = q.pendingCommands || [];
  q.pendingCommands = [];
  save(q);
  return out;
}

function drain() {
  const q = load();
  const out = { events: q.events, commandResults: q.commandResults, rfidReads: q.rfidReads };
  q.events = []; q.commandResults = []; q.rfidReads = [];
  save(q);
  return out;
}

function size() {
  const q = load();
  return q.events.length + q.commandResults.length + (q.pendingCommands || []).length + q.rfidReads.length;
}

// Tag reads too: a resident let in while offline is uploaded with the read,
// so VillaSafe knows who it was. Past this many, the oldest are dropped.
const MAX_READS = 5000;

function requeue(events, commandResults, rfidReads = []) {
  const q = load();
  q.events.unshift(...events);
  q.commandResults.unshift(...commandResults);
  q.rfidReads.unshift(...rfidReads);
  if (q.rfidReads.length > MAX_READS) q.rfidReads = q.rfidReads.slice(-MAX_READS);
  save(q);
}

module.exports = {
  enqueueEvent, enqueueResult, drain, size, requeue,
  enqueuePendingCommand, drainPendingCommands,
};