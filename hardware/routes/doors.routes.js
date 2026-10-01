const { Router } = require('express');
const { z } = require('zod');
const lane = require('../services/laneManager');

const router = Router();
const body = z.object({ controllerId: z.string().min(1), doorNo: z.number().int().min(1).max(64) });

router.post('/open', async (req, res, next) => {
  const p = body.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: p.error.flatten() });
  try { await lane.openDoor(p.data.controllerId, p.data.doorNo); res.json({ ok: true }); } catch (e) { next(e); }
});
router.post('/close', async (req, res, next) => {
  const p = body.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: p.error.flatten() });
  try { await lane.closeDoor(p.data.controllerId, p.data.doorNo); res.json({ ok: true }); } catch (e) { next(e); }
});

module.exports = router;