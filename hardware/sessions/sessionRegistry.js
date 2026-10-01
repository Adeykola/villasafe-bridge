// Central registry of live ControllerSession instances keyed by controllerId.
const { ControllerSession } = require('../drivers/hikvision/session');
const controllers = require('../config/controllers.store');
const log = require('../logger');

const registry = new Map();

async function ensure(controllerId) {
  const existing = registry.get(controllerId);
  if (existing && existing.online) return existing;
  const row = controllers.get(controllerId);
  if (!row) throw new Error(`Unknown controller ${controllerId}`);
  if (existing) { try { await existing.disconnect(); } catch { /* noop */ } }
  const s = new ControllerSession(row);
  registry.set(controllerId, s);
  await s.connect();
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