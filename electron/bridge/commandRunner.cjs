const Store = require('../config/laneStore.cjs');
const { runDriver, probeDriver } = require('../drivers/index.cjs');
const rfid = require('../drivers/rfid.cjs');
const cardBridge = require('./cardBridge.cjs');
const tagStore = require('./tagStore.cjs');
const offlineQueue = require('./offlineQueue.cjs');
const diagnostics = require('./diagnostics.cjs');
const signedLog = require('./signedLog.cjs');
const { callWithFallback, pairWithCode, gatewayHealth, licenceError, BRIDGE_VERSION } = require('./pairing.cjs');
const os = require('os');
const lanGate = require('./lanGate.cjs');

let pollTimer = null;
let probeTimer = null;
let status = { online: false, lastError: null, queuedOffline: 0, gateway: 'VillaSafe gateway' };
let onEvent = null;
let lanes = [];
let deviceHealth = []; // [{ lane_id, device_index, device_name, device_kind, driver, status, last_error }]
let pendingEvents = [];
let pendingResults = [];
let pendingRfidReads = [];
let lastCommandAt = {}; // key: laneId:deviceIndex -> ms
const COOLDOWN_MS = 5000;
// Set when VillaSafe says this estate has no valid desktop licence. Kept in the
// config file so a restart while offline stays locked; cleared by the next
// sync VillaSafe accepts.
let licence = { locked: false, reason: null, message: null };

function lockedResult() {
  return { success: false, error: licence.message || 'This PC needs a VillaSafe desktop licence key.' };
}

async function executeLane(lane, action, commandId, opts = {}) {
  if (licence.locked) return lockedResult();
  const side = opts.side === 'exit' || opts.side === 'entry' ? opts.side : undefined;
  const evtBase = { laneId: lane.id, commandId, action, side };
  diagnostics.log(`exec ${action} on lane ${lane.name}`);
  try {
    if (action === 'lockdown') {
      for (const d of lane.devices) { try { await runDriver(d, 'close'); } catch {} }
      recordEvent({ ...evtBase, success: true, source: 'lockdown' });
      return { success: true };
    }
    const order = action === 'close'
      ? ['turnstile', 'barrier', 'spike']
      : ['spike', 'barrier', 'turnstile'];
    for (const kind of order) {
      for (const d of lane.devices.filter(x => x.kind === kind)) {
        await runDriver(d, action === 'close' ? 'close' : 'open', { side });
      }
    }
    recordEvent({ ...evtBase, success: true });
    if (action === 'open' && lane.default_open_seconds) {
      setTimeout(async () => {
        for (const d of [...lane.devices].reverse()) {
          try { await runDriver(d, 'close', { side }); } catch {}
        }
        recordEvent({ ...evtBase, action: 'auto-close', success: true });
      }, lane.default_open_seconds * 1000);
    }
    return { success: true };
  } catch (e) {
    diagnostics.log(`FAIL ${action} ${lane.name}: ${e.message}`);
    recordEvent({ ...evtBase, success: false, error: e.message });
    return { success: false, error: e.message };
  }
}

async function executeDevice(lane, deviceIndex, action) {
  if (licence.locked) return lockedResult();
  const d = lane.devices[deviceIndex];
  if (!d) return { success: false, error: 'Device not found' };
  const key = `${lane.id}:${deviceIndex}`;
  const since = Date.now() - (lastCommandAt[key] || 0);
  if (since < COOLDOWN_MS) return { success: false, error: `Cooldown ${Math.ceil((COOLDOWN_MS - since)/1000)}s` };
  lastCommandAt[key] = Date.now();
  const t0 = Date.now();
  try {
    await runDriver(d, action);
    const latency = Date.now() - t0;
    recordEvent({ laneId: lane.id, action: `${action}:${d.kind}`, success: true, details: { device: d.name, latencyMs: latency } });
    return { success: true, latencyMs: latency };
  } catch (e) {
    recordEvent({ laneId: lane.id, action: `${action}:${d.kind}`, success: false, error: e.message, details: { device: d.name } });
    return { success: false, error: e.message };
  }
}

function recordEvent(evt) {
  pendingEvents.push(evt);
  try { signedLog.append({ action: evt.action, laneId: evt.laneId, payload: evt }); } catch {}
  onEvent?.(evt);
}

async function refreshDeviceHealth() {
  return refreshDeviceHealthInner();
}

/**
 * Pull card swipes the DS-K2804 reported over the SDK (reader wired via
 * Wiegand) and turn them into the same events the direct-reader path emits.
 */
async function drainWiegandReads() {
  let events = [];
  try { events = await cardBridge.drainCardEvents(); } catch { return; }
  for (const e of events) {
    const tagUid = String(e.tagUid || e.rawCardNo || '').toUpperCase();
    if (!tagUid) continue;
    // The controller already decided (it holds only approved cards); this
    // records the read with VillaSafe's reason.
    await handleTagRead({ laneId: e.laneId || null, tagUid, via: 'wiegand', extra: { rawCardNo: e.rawCardNo, doorNo: e.doorNo }, open: false });
  }
}

// Event names the web's RFID activity tab understands.
const REFUSAL_ACTION = { unknown: 'rfid_denied', wrong_lane: 'rfid_blocked', suspended: 'rfid_paused', owing: 'rfid_paused', expired: 'rfid_paused' };

/**
 * One decision for every tag read, from any reader, using the tag list saved
 * on this PC (tagStore) — so it works the same with or without internet.
 */
async function handleTagRead({ lane = null, laneId = lane?.id || null, tagUid, via, extra = {}, open = true, logOnly = false }) {
  const tag = tagStore.find(tagUid);
  const why = tagStore.refusal(tag, laneId);
  const details = { tagUid, label: tag?.label || null, via, ...extra };
  // "logged": this PC records its own detailed rfid_* event for the read, so
  // VillaSafe only bumps last_seen and doesn't log it a second time. A tag
  // that opens the gate is logged by VillaSafe (the PC logs the gate "open").
  const read = { tagUid, laneId, label: tag?.label || null, authorized: !why, via, logged: true };
  pendingRfidReads.push(read);
  if (why) {
    recordEvent({ laneId, action: REFUSAL_ACTION[why] || 'rfid_denied', source: 'rfid', success: false,
      error: tagStore.REASON_TEXT[why] || why, details: { ...details, reason: why } });
    return false;
  }
  if (logOnly) {
    recordEvent({ laneId, action: 'rfid_read', source: 'rfid', success: true, details: { ...details, logOnly: true } });
    return true;
  }
  if (open && lane) {
    read.logged = false;
    await executeLane(lane, 'open', null);
  } else {
    recordEvent({ laneId, action: 'rfid_read', source: 'rfid', success: true, details });
  }
  return true;
}

/**
 * Re-check which tags may open — every tick, even offline, so a tag whose
 * access runs out is refused on time — and push the change to Hikvision
 * controllers, which decide Wiegand swipes by themselves.
 */
function applyTagChanges({ force = false } = {}) {
  // Until a real list has arrived, an empty one would wipe every card from
  // the controllers — and with no internet, lock every resident out.
  if (!tagStore.savedAt()) return;
  // Cheap when nothing changed: cardBridge skips an unchanged card list.
  cardBridge.syncApproved(lanes, tagStore.effective(), { force }).catch(() => {});
}

async function refreshDeviceHealthInner() {
  const next = [];
  for (const lane of lanes) {
    for (let i = 0; i < (lane.devices || []).length; i++) {
      const d = lane.devices[i];
      const r = d.driver === 'rfid'
        ? await rfid.probe(d)
        : await probeDriver(d, { background: true });
      next.push({
        lane_id: lane.id,
        device_index: i,
        device_name: d.name,
        device_kind: d.kind,
        driver: d.driver,
        status: r.ok ? 'online' : 'error',
        last_error: r.ok ? null : r.error,
      });
    }
  }
  deviceHealth = next;
}

/**
 * (Re)start the directly connected readers (e.g. S4A on USB/RS-485 or TCP).
 * Only when the readers' own settings change: which tags may open is decided
 * per read by handleTagRead, so a tag list change never closes a serial port
 * while a car is at the boom.
 */
let readerSignature = null;
function refreshRfidReaders({ force = false } = {}) {
  const readers = lanes.flatMap((lane) => (lane.devices || [])
    .filter((x) => x.driver === 'rfid')
    .map((d) => ({ lane, d })));
  const sig = JSON.stringify(readers.map(({ lane, d }) => [lane.id, d.name, d.params || d.config || {}]));
  if (!force && sig === readerSignature) return;
  readerSignature = sig;
  rfid.stopAll();
  for (const { lane, d } of readers) {
    try {
      // The driver only debounces and reports; "log only" is the one mode it keeps.
      rfid.startReader(d, async (tagUid, _dev, meta) => {
        await handleTagRead({ lane, tagUid, via: 'reader', logOnly: !!meta?.logOnly });
      });
    } catch (e) { diagnostics.log(`RFID start failed: ${e.message}`); }
  }
}

async function syncOnce(cfg) {
  // Tags can expire between syncs, or with no internet at all.
  applyTagChanges();
  // Drain offline queue (events + results) first
  const buffered = offlineQueue.drain();
  // Drain Wiegand card swipes reported by the built-in Hikvision service
  await drainWiegandReads();
  // Drain any pending local commands that were queued while offline
  const queuedCmds = offlineQueue.drainPendingCommands();
  for (const qc of queuedCmds) {
    const lane = lanes.find(l => l.id === qc.laneId);
    if (lane) await executeLane(lane, qc.action, null, { side: qc.side });
  }
  const body = {
    bridgeId: cfg.bridgeId,
    bridgeToken: cfg.bridgeToken,
    // Belt-and-braces: also send the cached pairing code so a stale-deployed
    // server (still expecting pairingCode) still accepts our heartbeat.
    pairingCode: cfg.pairingCode || undefined,
    version: BRIDGE_VERSION,
    events: [...buffered.events, ...pendingEvents.splice(0, pendingEvents.length)],
    commandResults: [...buffered.commandResults, ...pendingResults.splice(0, pendingResults.length)],
    rfidReads: pendingRfidReads.splice(0, pendingRfidReads.length),
    deviceHealth,
    cpuLoad: os.loadavg()[0] || 0,
    lastError: status.lastError,
    // LAN gate mode: check-ins decided locally, pass list refresh, LAN address
    lanScans: lanGate.drainScans(),
    wantPasses: lanGate.needsPasses(),
    lan: lanGate.announcement() || undefined,
  };
  const applySyncData = async (data, gatewayUsed) => {
    status.gateway = /villasafe\.com/i.test(gatewayUsed || '') ? 'VillaSafe gateway' : 'Configured gateway';
    if (licence.locked) setLicence(null);
    // Honor rotated token
    if (data.rotatedToken) {
      Store.update({ bridgeToken: data.rotatedToken, tokenExpiresAt: data.tokenExpiresAt || cfg.tokenExpiresAt });
      cfg.bridgeToken = data.rotatedToken;
      diagnostics.log('Bridge token refreshed by server');
    }
    lanes = data.lanes || [];
    lanGate.updateFromSync(data, cfg);
    // Save the estate's tags on this PC so they keep working offline and
    // across restarts, then bring readers and Hikvision controllers in step.
    if (Array.isArray(data.rfidTags)) tagStore.save(cfg.bridgeId, data.rfidTags);
    refreshRfidReaders();
    applyTagChanges();
    Store.update({ lanesCache: lanes });
    status.online = true; status.lastError = null;
    status.queuedOffline = 0;
    for (const cmd of data.commands || []) {
      // Ad-hoc probe requested by the web (Lane Wizard "Test connection")
      if (cmd.action === 'probe_device') {
        const dev = cmd.payload && cmd.payload.device;
        if (!dev || !dev.driver) {
          pendingResults.push({ commandId: cmd.id, success: false, result: { error: 'Missing device payload' } });
          continue;
        }
        try {
          const r = dev.driver === 'rfid' ? await rfid.probe(dev) : await probeDriver(dev);
          pendingResults.push({ commandId: cmd.id, success: !!r.ok, result: r });
        } catch (e) {
          pendingResults.push({ commandId: cmd.id, success: false, result: { error: e.message } });
        }
        continue;
      }
      const lane = lanes.find(l => l.id === cmd.lane_id);
      if (!lane) {
        pendingResults.push({ commandId: cmd.id, success: false, result: { error: 'Lane not found' } });
        continue;
      }
      let r;
      if (typeof cmd.device_index === 'number') {
        r = await executeDevice(lane, cmd.device_index, cmd.action);
      } else {
        const sideFromCmd = (cmd.payload && (cmd.payload.side || (cmd.payload.context && cmd.payload.context.side))) || undefined;
        r = await executeLane(lane, cmd.action, cmd.id, { side: sideFromCmd });
      }
      pendingResults.push({ commandId: cmd.id, success: r.success, result: r });
    }
  };
  try {
    const { data, gatewayUsed } = await callWithFallback(cfg.gatewayUrl, '/bridge-sync', body);
    await applySyncData(data, gatewayUsed);
  } catch (e) {
    // VillaSafe answered, but this estate's desktop licence is missing,
    // revoked or replaced. Lock the gates until a valid key is entered here.
    const refusal = licenceError(e);
    if (refusal) {
      setLicence(refusal);
      status.online = true;
      status.lastError = licence.message;
      offlineQueue.requeue(body.events, body.commandResults);
      lanGate.requeueScans(body.lanScans);
      return;
    }
    // Auto-recover: stale-token or "bridge out of date" → re-pair using the cached code
    const looksAuthFail = /token_expired|Unauthorized bridge|missing bridgeToken|missing bridgeId|Token expired|Bridge token missing|Bridge ID missing|HTTP 401|HTTP 400/i.test(e.message);
    if (looksAuthFail && cfg.pairingCode) {
      try {
        // Keep recovery noise out of the web UI; log locally only.
        status.lastError = null;
        const health = await gatewayHealth(cfg.gatewayUrl);
        if (!health.ok) throw new Error(health.error || 'VillaSafe gateway is not ready');
        diagnostics.log('Heartbeat auth failed — attempting auto re-pair…');
        const r = await pairWithCode(cfg.gatewayUrl, cfg.pairingCode, undefined, cfg.licenseKey);
        if (r.ok && r.bridgeToken) {
          Store.update({
            bridgeId: r.bridgeId, tenantId: r.tenantId, bridgeToken: r.bridgeToken,
            tenantName: r.tenantName, tokenExpiresAt: r.tokenExpiresAt,
          });
          cfg.bridgeId = r.bridgeId; cfg.bridgeToken = r.bridgeToken;
          body.bridgeId = r.bridgeId; body.bridgeToken = r.bridgeToken;
          const retry = await callWithFallback(cfg.gatewayUrl, '/bridge-sync', body);
          await applySyncData(retry.data, retry.gatewayUsed);
          diagnostics.log('Auto re-pair OK');
          return;
        } else {
          diagnostics.log('Auto re-pair failed: ' + (r.error || 'unknown'));
        }
      } catch (re) { diagnostics.log('Auto re-pair error: ' + re.message); }
    }
    status.online = false;
    // Don't surface transient pairing-recovery strings to the web card.
    if (/token_expired|missing bridgeId|missing bridgeToken|Token expired/i.test(e.message)) {
      status.lastError = null;
    } else if (/fetch failed|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|network|TLS/i.test(e.message)) {
      status.lastError = "Can't reach VillaSafe gateway from this PC. Check internet, DNS, and any corporate proxy/antivirus TLS interception. (" + e.message + ')';
    } else {
      status.lastError = e.message;
    }
    // Persist them in the offline queue so they survive restarts too
    offlineQueue.requeue(body.events, body.commandResults);
    lanGate.requeueScans(body.lanScans);
    status.queuedOffline = offlineQueue.size();
    diagnostics.log(`sync offline: ${e.message} — queued ${status.queuedOffline}`);
  }
}

/** Record (or clear, with null) VillaSafe's licence refusal and tell the UI. */
function setLicence(refusal) {
  const next = refusal
    ? { locked: true, reason: refusal.reason || 'missing', message: refusal.message || 'This PC needs a VillaSafe desktop licence key.' }
    : { locked: false, reason: null, message: null };
  const changed = next.locked !== licence.locked || next.reason !== licence.reason;
  licence = next;
  if (!changed) return;
  Store.update({ licenseLock: next.locked ? { reason: next.reason, message: next.message } : null });
  diagnostics.log(next.locked ? `Licence: gates locked (${next.reason})` : 'Licence: accepted by VillaSafe');
  onEvent?.({ action: 'licence', success: !next.locked, details: next });
}

function startBridge(cfg, eventCb) {
  stopBridge();
  onEvent = eventCb;
  if (!cfg.bridgeId || !cfg.bridgeToken) return;
  licence = cfg.licenseLock
    ? { locked: true, reason: cfg.licenseLock.reason || 'missing', message: cfg.licenseLock.message || null }
    : { locked: false, reason: null, message: null };
  // Don't carry the last loop's error into the first heartbeat — after a
  // licence key is accepted it would put "enter the licence key" straight
  // back on the web card.
  status.lastError = licence.locked ? licence.message : null;
  // Hydrate cached lanes and the tags saved on this PC, so readers work
  // straight away — including after a restart with no internet.
  lanes = cfg.lanesCache || [];
  tagStore.load(cfg.bridgeId);
  refreshRfidReaders({ force: true });
  applyTagChanges({ force: true });
  // Arm Hikvision card (Wiegand) channels — no-op when no controllers are set up.
  cardBridge.armControllers().catch(() => {});
  // Immediate sync, then every 5s
  syncOnce(cfg);
  pollTimer = setInterval(() => syncOnce(cfg), 5000);
  // Device probes every 20s
  refreshDeviceHealth();
  probeTimer = setInterval(() => refreshDeviceHealth(), 20000);
}

function stopBridge() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  if (probeTimer) clearInterval(probeTimer);
  probeTimer = null;
  rfid.stopAll();
}

function getStatus() {
  return {
    ...status,
    licence,
    tags: { total: tagStore.tags().length, allowed: tagStore.allowed().length, savedAt: tagStore.savedAt() },
    lan: lanGate.getLanStatus(),
    queuedOffline: offlineQueue.size(),
    lanes: lanes.map(l => ({ id: l.id, name: l.name, devices: l.devices })),
    deviceHealth,
  };
}

async function runCommandLocal(laneId, action, side) {
  const lane = lanes.find(l => l.id === laneId);
  if (!lane) return { ok: false, error: 'Lane not loaded' };
  // If we're offline, queue and still execute locally so OPEN/CLOSE never blocks the guard
  if (status.online === false) {
    offlineQueue.enqueuePendingCommand({ laneId, action, side });
  }
  const r = await executeLane(lane, action, null, { side });
  return { ok: r.success, error: r.error };
}

async function runDeviceLocal(laneId, deviceIndex, action) {
  const lane = lanes.find(l => l.id === laneId);
  if (!lane) return { ok: false, error: 'Lane not loaded' };
  const r = await executeDevice(lane, deviceIndex, action);
  return { ok: r.success, error: r.error, latencyMs: r.latencyMs };
}

function getLanes() { return lanes; }
function getRfidTags() { return tagStore.tags(); }
function isOnline() { return status.online !== false; }
function isLicensed() { return !licence.locked; }

module.exports = {
  startBridge, stopBridge, getStatus, isLicensed,
  runCommandLocal, runDeviceLocal, getLanes, getRfidTags, refreshDeviceHealth, isOnline,
};