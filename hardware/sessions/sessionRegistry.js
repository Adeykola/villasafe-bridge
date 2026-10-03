// Central registry of live ControllerSession instances keyed by controllerId.
const { ControllerSession } = require('../drivers/hikvision/session');
const controllers = require('../config/controllers.store');
const { BridgeError } = require('../utils/errorMap');
const loginGuard = require('./loginGuard');
const log = require('../logger');

const registry = new Map();

/** The controller's last refusal, returned without logging in again (see loginGuard). */
function refusedAgain(refusal) {
  const at = new Date(refusal.retryAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const hint = [
    refusal.error.hint,
    "The bridge is holding off so the controller isn't locked again — " +
      `it tries again at ${at}, or straight away once the password is changed in the Lane wizard.`,
  ].filter(Boolean).join(' ');
  const err = new BridgeError(refusal.error.code, refusal.error.message, hint);
  err.credential = true;
  return err;
}

/**
 * The open session for a controller, logging in if needed. `background` marks
 * automatic health checks, which never retry a refused password (loginGuard).
 */
async function ensure(controllerId, { background = false } = {}) {
  const existing = registry.get(controllerId);
  if (existing && existing.online) return existing;
  const row = controllers.get(controllerId);
  if (!row) throw new Error(`Unknown controller ${controllerId}`);

  const refusal = loginGuard.blocked(row, { background });
  if (refusal) throw refusedAgain(refusal);

  if (existing) { try { await existing.disconnect(); } catch { /* noop */ } }
  const s = new ControllerSession(row);
  registry.set(controllerId, s);
  try {
    await s.connect();
  } catch (e) {
    if (e && e.credential) {
      loginGuard.refuse(row, e);
      log.warn('Controller refused the login — not retrying the same password', { controllerId, code: e.code });
    }
    throw e;
  }
  loginGuard.clear(controllerId);
  return s;
}

async function disconnect(controllerId) {
  const s = registry.get(controllerId);
  if (!s) return;
  await s.disconnect();
  registry.delete(controllerId);
  log.info('Controller session closed', { controllerId });
}

function status() {
  return Array.from(registry.values()).map(s => s.status());
}

function get(controllerId) { return registry.get(controllerId) || null; }

module.exports = { ensure, disconnect, status, get };
