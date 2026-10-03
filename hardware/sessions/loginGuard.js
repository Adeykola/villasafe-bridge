// Keeps the bridge from locking a controller's admin login.
//
// Hikvision controllers lock the account after a handful of wrong passwords
// (SDK error 153) for about 30 minutes. The bridge checks every lane every 20
// seconds, so without this it would retry a refused password until the
// controller locks — and lock it again each time the lock wears off.
//
// After a login is refused for its credentials (wrong password, unknown user,
// locked, not activated) the same address + user + password is not tried again:
//   - by the background health check, until the details change or 30 minutes pass;
//   - by a gate open or a test, at most once a minute (someone may have just
//     unlocked or power-cycled the controller).
// Changing the password (or address, port, user) in the Lane wizard clears it.
const crypto = require('crypto');

const BACKGROUND_WAIT_MS = 30 * 60_000;
const FOREGROUND_WAIT_MS = 60_000;

const refused = new Map(); // controllerId -> { fingerprint, error, failedAt }

function fingerprint(row) {
  return crypto
    .createHash('sha256')
    .update([row.ip, row.sdkPort || 8000, row.username || 'admin', row.password || ''].join('\u0000'))
    .digest('hex');
}

/**
 * The refusal that still applies to this controller row, or null when a login
 * may be attempted. `background` is true for automatic health checks.
 */
function blocked(row, { background = false, now = Date.now() } = {}) {
  const entry = refused.get(row.id);
  if (!entry) return null;
  if (entry.fingerprint !== fingerprint(row)) {
    refused.delete(row.id);
    return null;
  }
  const age = now - entry.failedAt;
  if (age >= BACKGROUND_WAIT_MS) {
    refused.delete(row.id);
    return null;
  }
  if (!background && age >= FOREGROUND_WAIT_MS) return null;
  return { ...entry, retryAt: entry.failedAt + (background ? BACKGROUND_WAIT_MS : FOREGROUND_WAIT_MS) };
}

/** Remember a login the controller refused for its credentials. */
function refuse(row, error, now = Date.now()) {
  refused.set(row.id, {
    fingerprint: fingerprint(row),
    error: { code: error.code, message: error.message, hint: error.hint || null },
    failedAt: now,
  });
}

function clear(controllerId) {
  refused.delete(controllerId);
}

module.exports = { blocked, refuse, clear, BACKGROUND_WAIT_MS, FOREGROUND_WAIT_MS };
