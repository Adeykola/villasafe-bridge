// Service layer for controllers — thin composition over the repo + registry.
const repo = require('../config/controllers.store');
const registry = require('../sessions/sessionRegistry');
const deviceInfo = require('../drivers/hikvision/deviceInfo');

async function list() { return repo.list(); }
async function upsert(input) { return repo.upsert(input); }
async function remove(id) { await registry.disconnect(id); repo.remove(id); }
// background: an automatic health check, which never retries a refused password.
async function connect(id, { background = false } = {}) { const s = await registry.ensure(id, { background }); return s.status(); }
async function disconnect(id) { await registry.disconnect(id); return { id, online: false }; }
async function status() { return registry.status(); }
async function info(id) {
  const s = await registry.ensure(id);
  return { ...s.status(), device: deviceInfo.get(s) };
}
async function restart(id) {
  // The SDK does not expose a generic reboot for K2 series without extra
  // XML; the safe fallback is close+reopen the session.
  await registry.disconnect(id);
  return connect(id);
}

module.exports = { list, upsert, remove, connect, disconnect, status, info, restart };