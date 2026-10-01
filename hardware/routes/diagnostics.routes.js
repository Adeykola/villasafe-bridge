const { Router } = require('express');
const { z } = require('zod');
const diag = require('../services/diagnosticsService');

const router = Router();
const q = z.object({ controllerId: z.string().min(1), testDoorNo: z.coerce.number().int().min(1).max(64).optional() });

router.get('/run', async (req, res, next) => {
  const p = q.safeParse(req.query);
  if (!p.success) return res.status(400).json({ error: p.error.flatten() });
  try { res.json(await diag.run(p.data)); } catch (e) { next(e); }
});

module.exports = router;