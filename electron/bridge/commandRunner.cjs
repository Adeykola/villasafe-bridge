const Store = require('../config/laneStore.cjs');
const { runDriver, probeDriver } = require('../drivers/index.cjs');
const rfid = require('../drivers/rfid.cjs');
const offlineQueue = require('./offlineQueue.cjs');
const diagnostics = require('./diagnostics.cjs');
const signedLog = require('./signedLog.cjs');
const { callWithFallback, pairWithCode, gatewayHealth, BRIDGE_VERSION } = require('./pairing.cjs');
const os = require('os');

let pollTimer = null;
let probeTimer = null;
let status = { online: false, lastError: null, queuedOffline: 0, gateway: 'VillaSafe gateway' };
let onEvent = null;
let lanes = [];
let deviceHealth = []; // [{ lane_id, device_index, device_name, device_kind, driver, status, last_error }]
let pendingEvents = [];
let pendingResults = [];
let pendingRfidReads = [];
let rfidTags = []; // cached from server
let lastCommandAt = {}; // key: laneId:deviceIndex -> ms
const COOLDOWN_MS = 5000;

async function executeLane(lane, action, commandId) {
  const evtBase = { laneId: lane.id, commandId, action };
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
        await runDriver(d, action === 'close' ? 'close' : 'open');
      }
    }
    recordEvent({ ...evtBase, success: true });
    if (action === 'open' && lane.default_open_seconds) {
      setTimeout(async () => {
        for (const d of [...lane.devices].reverse()) {
          try { await runDriver(d, 'close'); } catch {}
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
  const next = [];
  for (const lane of lanes) {
    for (let i = 0; i < (lane.devices || []).length; i++) {
      const d = lane.devices[i];
      const r = d.driver === 'rfid'
        ? await rfid.probe(d)
        : await probeDriver(d);
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

function refreshRfidReaders() {
  rfid.stopAll();
  for (const lane of lanes) {
    for (const d of (lane.devices || []).filter(x => x.driver === 'rfid')) {
      try {
        rfid.startReader(d, async (tagUid, _dev, meta) => {
          if (meta?.blocked) {
            pendingRfidReads.push({ tagUid, laneId: lane.id, authorized: false });
            recordEvent({ laneId: lane.id, action: 'rfid_blocked', source: 'rfid', success: false, error: 'tag blocked by allow-list', details: { tagUid } });
            return;
          }
          const tag = rfidTags.find(t => t.tag_uid?.toUpperCase() === tagUid);
          const authorized = !!tag && (!tag.lane_id || tag.lane_id === lane.id);
          pendingRfidReads.push({ tagUid, laneId: lane.id, label: tag?.label, authorized });
          // Log-only mode: record the read but never auto-open, even for known tags.
          if (meta?.logOnly) {
            recordEvent({ laneId: lane.id, action: 'rfid_read', source: 'rfid', success: true, details: { tagUid, label: tag?.label, logOnly: true } });
            return;
          }
          if (authorized) await executeLane(lane, 'open', null);
          else recordEvent({ laneId: lane.id, action: 'rfid_denied', source: 'rfid', success: false, error: 'unknown tag', details: { tagUid } });
        });
      } catch (e) { diagnostics.log(`RFID start failed: ${e.message}`); }
    }
  }
}

async function syncOnce(cfg) {
  // Drain offline queue (events + results) first
  const buffered = offlineQueue.drain();
  // Drain any pending local commands that were queued while offline
  const queuedCmds = offlineQueue.drainPendingCommands();
  for (const qc of queuedCmds) {
    const lane = lanes.find(l => l.id === qc.laneId);
    if (lane) await executeLane(lane, qc.action, null);
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
  };
  const applySyncData = async (data, gatewayUsed) => {
    status.gateway = /villasafe\.com/i.test(gatewayUsed || '') ? 'VillaSafe gateway' : 'Configured gateway';
    // Honor rotated token
    if (data.rotatedToken) {
      Store.update({ bridgeToken: data.rotatedToken, tokenExpiresAt: data.tokenExpiresAt || cfg.tokenExpiresAt });
      cfg.bridgeToken = data.rotatedToken;
      diagnostics.log('Bridge token refreshed by server');
    }
    lanes = data.lanes || [];
    const newTags = data.rfidTags || [];
    const tagsChanged = JSON.stringify(newTags.map(t => t.tag_uid).sort()) !== JSON.stringify(rfidTags.map(t => t.tag_uid).sort());
    rfidTags = newTags;
    if (tagsChanged || !lanes.length) refreshRfidReaders();
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
        r = await executeLane(lane, cmd.action, cmd.id);
      }
      pendingResults.push({ commandId: cmd.id, success: r.success, result: r });
    }
  };
  try {
    const { data, gatewayUsed } = await callWithFallback(cfg.gatewayUrl, '/bridge-sync', body);
    await applySyncData(data, gatewayUsed);
  } catch (e) {
    // Auto-recover: stale-token or "bridge out of date" → re-pair using the cached code
    const looksAuthFail = /token_expired|Unauthorized bridge|missing bridgeToken|missing bridgeId|Token expired|Bridge token missing|Bridge ID missing|HTTP 401|HTTP 400/i.test(e.message);
    if (looksAuthFail && cfg.pairingCode) {
      try {
        // Keep recovery noise out of the web UI; log locally only.
        status.lastError = null;
        const health = await gatewayHealth(cfg.gatewayUrl);
        if (!health.ok) throw new Error(health.error || 'VillaSafe gateway is not ready');
        diagnostics.log('Heartbeat auth failed — attempting auto re-pair…');
        const r = await pairWithCode(cfg.gatewayUrl, cfg.pairingCode);
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
    status.lastError = /token_expired|missing bridgeId|missing bridgeToken|Token expired/i.test(e.message)
      ? null : e.message;
    // Persist them in the offline queue so they survive restarts too
    offlineQueue.requeue(body.events, body.commandResults);
    status.queuedOffline = offlineQueue.size();
    diagnostics.log(`sync offline: ${e.message} — queued ${status.queuedOffline}`);
  }
}

function startBridge(cfg, eventCb) {
  stopBridge();
  onEvent = eventCb;
  if (!cfg.bridgeId || !cfg.bridgeToken) return;
  // Hydrate cached lanes
  lanes = cfg.lanesCache || [];
  refreshRfidReaders();
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
    queuedOffline: offlineQueue.size(),
    lanes: lanes.map(l => ({ id: l.id, name: l.name, devices: l.devices })),
    deviceHealth,
  };
}

async function runCommandLocal(laneId, action) {
  const lane = lanes.find(l => l.id === laneId);
  if (!lane) return { ok: false, error: 'Lane not loaded' };
  // If we're offline, queue and still execute locally so OPEN/CLOSE never blocks the guard
  if (status.online === false) {
    offlineQueue.enqueuePendingCommand({ laneId, action });
  }
  const r = await executeLane(lane, action, null);
  return { ok: r.success, error: r.error };
}

async function runDeviceLocal(laneId, deviceIndex, action) {
  const lane = lanes.find(l => l.id === laneId);
  if (!lane) return { ok: false, error: 'Lane not loaded' };
  const r = await executeDevice(lane, deviceIndex, action);
  return { ok: r.success, error: r.error, latencyMs: r.latencyMs };
}

function getLanes() { return lanes; }
function getRfidTags() { return rfidTags; }

module.exports = {
  startBridge, stopBridge, getStatus,
  runCommandLocal, runDeviceLocal, getLanes, getRfidTags, refreshDeviceHealth,
};