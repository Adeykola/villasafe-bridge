// AES-256-GCM encryption for controller passwords at rest.
// Key is read from BRIDGE_ENCRYPTION_KEY env or generated on first run.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { dataDir } = require('../paths');

const KEY_FILE = path.join(dataDir(), '.enc.key');

function loadKey() {
  if (process.env.BRIDGE_ENCRYPTION_KEY) {
    return Buffer.from(process.env.BRIDGE_ENCRYPTION_KEY, 'hex');
  }
  fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
  if (fs.existsSync(KEY_FILE)) return Buffer.from(fs.readFileSync(KEY_FILE, 'utf8'), 'hex');
  const k = crypto.randomBytes(32);
  fs.writeFileSync(KEY_FILE, k.toString('hex'), { mode: 0o600 });
  return k;
}

const KEY = loadKey();

function encrypt(plain) {
  if (plain == null || plain === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('hex')}:${tag.toString('hex')}:${ct.toString('hex')}`;
}

function decrypt(blob) {
  if (!blob) return '';
  const [ver, ivHex, tagHex, ctHex] = String(blob).split(':');
  if (ver !== 'v1') throw new Error('Unsupported encryption version');
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(ctHex, 'hex')), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt };