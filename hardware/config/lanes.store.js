// Lane repository — plain JSON. Each lane binds a controller + door + optional
// barrier / spike / turnstile / loop / reader flags.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { dataDir } = require('../paths');

const FILE = path.join(dataDir(), 'lanes.json');

function ensure() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  if (!fs.existsSync(FILE)) fs.writeFileSync(FILE, '[]', 'utf8');
}
function read() { ensure(); return JSON.parse(fs.readFileSync(FILE, 'utf8')); }
function write(rows) { ensure(); fs.writeFileSync(FILE, JSON.stringify(rows, null, 2), 'utf8'); }

function list() { return read(); }
function get(id) { return read().find(l => l.id === id) || null; }
function upsert(input) {
  const rows = read();
  const id = input.id || crypto.randomUUID();
  const next = {
    id,
    name: input.name,
    controllerId: input.controllerId,
    doorNo: Number(input.doorNo || 1),
    barrierEnabled: !!input.barrierEnabled,
    tyreSpikeEnabled: !!input.tyreSpikeEnabled,
    loopDetectorEnabled: !!input.loopDetectorEnabled,
    rfidReaderEnabled: !!input.rfidReaderEnabled,
    turnstileEnabled: !!input.turnstileEnabled,
    entryDoorNo: input.entryDoorNo ?? null,
    exitDoorNo: input.exitDoorNo ?? null,
    updatedAt: new Date().toISOString(),
  };
  const idx = rows.findIndex(r => r.id === id);
  if (idx >= 0) rows[idx] = { ...rows[idx], ...next };
  else rows.push({ createdAt: new Date().toISOString(), ...next });
  write(rows);
  return next;
}
function remove(id) { write(read().filter(l => l.id !== id)); }

module.exports = { list, get, upsert, remove };