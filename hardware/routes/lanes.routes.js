const { Router } = require('express');
const { z } = require('zod');
const svc = require('../services/laneManager');

const router = Router();

const upsert = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  controllerId: z.string().min(1),
  doorNo: z.number().int().min(1).max(64),
  barrierEnabled: z.boolean().optional(),
  tyreSpikeEnabled: z.boolean().optional(),
  loopDetectorEnabled: z.boolean().optional(),
  rfidReaderEnabled: z.boolean().optional(),
  turnstileEnabled: z.boolean().optional(),
  entryDoorNo: z.number().int().nullable().optional(),
  exitDoorNo: z.number().int().nullable().optional(),
});

router.get('/', (_req, res) => res.json(svc.list()));
router.post('/', (req, res) => {
  const p = upsert.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: p.error.flatten() });
  res.json(svc.upsert(p.data));
});
router.delete('/:id', (req, res) => { svc.remove(req.params.id); res.json({ ok: true }); });
router.post('/:id/open', async (req, res, next) => {
  const side = req.body && req.body.side === 'exit' ? 'exit' : req.body && req.body.side === 'entry' ? 'entry' : undefined;
  try { await svc.openLane(req.params.id, { side }); res.json({ ok: true }); } catch (e) { next(e); }
});
router.post('/:id/close', async (req, res, next) => { try { await svc.closeLane(req.params.id); res.json({ ok: true }); } catch (e) { next(e); } });

module.exports = router;