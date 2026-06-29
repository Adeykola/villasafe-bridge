const http = require('http');
const { runCommandLocal } = require('./commandRunner.cjs');

let server = null;

function startAnprServer(cfg, port, eventCb) {
  if (server) try { server.close(); } catch {}
  server = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/anpr') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', async () => {
        try {
          const { laneId, plate } = JSON.parse(body || '{}');
          if (!laneId) return res.writeHead(400).end('laneId required');
          await runCommandLocal(laneId, 'open');
          eventCb?.({ action: 'open', source: 'anpr', success: true, details: { plate } });
          res.writeHead(200).end('ok');
        } catch (e) {
          res.writeHead(500).end(e.message);
        }
      });
    } else {
      res.writeHead(404).end();
    }
  });
  server.listen(port, () => console.log('ANPR listener on ' + port));
}

module.exports = { startAnprServer };