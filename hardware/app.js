// VillaSafe Hikvision service — Express app that owns every HCNetSDK session.
//
// It runs inside the Gate Bridge desktop app (electron/main.cjs calls start()),
// listening on loopback only with a per-launch token, so there is no second
// program to install. `node hardware/app.js` still runs it on its own for
// debugging on a PC without the desktop app.
const express = require('express');
const log = require('./logger');
const { normalize } = require('./utils/errorMap');
const sdkLoader = require('./drivers/hikvision/sdkLoader');

const controllersRoutes = require('./routes/controllers.routes');
const doorsRoutes = require('./routes/doors.routes');
const lanesRoutes = require('./routes/lanes.routes');
const diagnosticsRoutes = require('./routes/diagnostics.routes');
const logsRoutes = require('./routes/logs.routes');
const cardsRoutes = require('./routes/cards.routes');
const cardEvents = require('./services/cardEventService');

const VERSION = require('../package.json').version;

function createApp({ token } = {}) {
  const app = express();
  app.use(express.json({ limit: '256kb' }));

  // Loopback only, plus the token when one is set.
  app.use((req, res, next) => {
    if (token && req.get('X-Bridge-Token') !== token) return res.status(401).json({ error: 'unauthorized' });
    next();
  });

  app.get('/api/health', (_req, res) => res.json({
    ok: true,
    version: VERSION,
    sdk: sdkLoader.status(),
    uptime: process.uptime(),
  }));

  // Try the SDK again after someone copies it in, without restarting the app.
  app.post('/api/sdk/reload', (_req, res) => {
    try { sdkLoader.load(); } catch { /* reported through status() */ }
    res.json({ sdk: sdkLoader.status() });
  });

  app.use('/api/controller', controllersRoutes);
  app.use('/api/door', doorsRoutes);
  app.use('/api/lane', lanesRoutes);
  app.use('/api/diagnostics', diagnosticsRoutes);
  app.use('/api/logs', logsRoutes);
  app.use('/api/cards', cardsRoutes);

  // Central error middleware.
  app.use((err, _req, res, _next) => {
    const be = normalize(err);
    log.error('Request failed', { code: be.code, message: be.message });
    res.status(be.code === 'LANE_NOT_FOUND' ? 404 : 500).json(be.toJSON());
  });

  return app;
}

/**
 * Load the SDK (degraded mode when it's missing), start buffering card swipes
 * and listen. Resolves once the port is bound; rejects if it can't be.
 */
function start({ port = 8788, host = '127.0.0.1', token = '' } = {}) {
  try { sdkLoader.load(); } catch (e) { log.warn('SDK preload skipped', { error: e.message }); }

  cardEvents.start();
  cardEvents.armAll()
    .then((r) => log.info('Card event channels armed', { controllers: r }))
    .catch((e) => log.warn('Could not arm card channels yet', { error: e.message }));

  const app = createApp({ token });
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => {
      log.info('Hikvision service listening', { host, port });
      resolve(server);
    });
    server.once('error', reject);
  });
}

function stop(server) {
  try { server?.close(); } catch { /* noop */ }
  sdkLoader.shutdown();
}

if (require.main === module) {
  const port = Number(process.env.BRIDGE_PORT || 8788);
  const host = process.env.BRIDGE_HOST || '127.0.0.1';
  start({ port, host, token: process.env.BRIDGE_TOKEN || '' }).then((server) => {
    process.on('SIGTERM', () => { stop(server); process.exit(0); });
    process.on('SIGINT', () => { stop(server); process.exit(0); });
  }).catch((e) => {
    log.error('Could not start the Hikvision service', { error: e.message });
    process.exit(1);
  });
}

module.exports = { createApp, start, stop };
