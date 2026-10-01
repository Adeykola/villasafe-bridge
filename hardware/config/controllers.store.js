// Controller repository — file-backed JSON with AES-GCM encrypted passwords.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { encrypt, decrypt } = require('../utils/crypto');

const { dataDir } = require('../paths');

const FILE = path.join(dataDir(), 'controllers.json');

function ensure() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  if (!fs.existsSync(FILE)) fs.writeFileSync(FILE, '[]', 'utf8');
}
function read() { ensure(); return JSON.parse(fs.readFileSync(FILE, 'utf8')); }
function write(rows) { ensure(); fs.writeFileSync(FILE, JSON.stringify(rows, null, 2), 'utf8'); }

function list() {
  return read().map(({ password, ...rest }) => rest);
}
function get(id) {
  const row = read().find(r => r.id === id);
  if (!row) return null;
  return { ...row, password: decrypt(row.password) };
}
function upsert(input) {
  const rows = read();
  const id = input.id || crypto.randomUUID();
  const encPwd = input.password !== undefined ? encrypt(input.password) : (rows.find(r => r.id === id)?.password || null);
  const next = {
    id,
    name: input.name,
    ip: input.ip,
    sdkPort: input.sdkPort || 8000,
    username: input.username || 'admin',
    password: encPwd,
    updatedAt: new Date().toISOString(),
  };
  const idx = rows.findIndex(r => r.id === id);
  if (idx >= 0) rows[idx] = { ...rows[idx], ...next };
  else rows.push({ createdAt: new Date().toISOString(), ...next });
  write(rows);
  return { ...next, password: undefined };
}
function remove(id) {
  write(read().filter(r => r.id !== id));
}

module.exports = { list, get, upsert, remove };