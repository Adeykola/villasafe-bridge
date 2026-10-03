const { Router } = require('express');
const { z } = require('zod');
const svc = require('../services/controllerManager');

const router = Router();

const upsertSchema = z.object({
  // Accept UUIDs and slug IDs (e.g. "hik-192-168-1-64" sent by the desktop driver).
  id: z.string().min(1).max(128).regex(/^[a-zA-Z0-9._-]+$/).optional(),
  name: z.string().min(1),
  ip: z.string().min(1),
  sdkPort: z.number().int().min(1).max(65535).default(8000),
  username: z.string().min(1).default('admin'),
  password: z.string().optional(),
});

router.get('/', async (_req, res, next) => { try { res.json(await svc.list()); } catch (e) { next(e); } });
router.post('/', async (req, res, next) => {
  const parsed = upsertSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      error: parsed.error.flatten()
    });
  }

  try {
    const controller = await svc.upsert(parsed.data);

    let connection = null;

    // The Gate Bridge registers the controller before every command and
    // connects in its next request, so it passes connect: false — one login
    // per command instead of two.
    if (req.body.connect !== false) {
      try {
        connection = await svc.connect(controller.id);
      } catch (err) {
        connection = {
          online: false,
          ...err.toJSON?.()
        };
      }
    }

    res.json({
      controller,
      connection
    });

  } catch (e) {
    next(e);
  }
});
router.delete('/:id', async (req, res, next) => { try { await svc.remove(req.params.id); res.json({ ok: true }); } catch (e) { next(e); } });
router.post('/:id/connect', async (req, res, next) => {
  try { res.json(await svc.connect(req.params.id, { background: req.body?.background === true })); } catch (e) { next(e); }
});
router.post('/:id/disconnect', async (req, res, next) => { try { res.json(await svc.disconnect(req.params.id)); } catch (e) { next(e); } });
router.post('/:id/restart', async (req, res, next) => { try { res.json(await svc.restart(req.params.id)); } catch (e) { next(e); } });
router.get('/status', async (_req, res, next) => { try { res.json(await svc.status()); } catch (e) { next(e); } });
router.get('/:id/deviceInfo', async (req, res, next) => { try { res.json(await svc.info(req.params.id)); } catch (e) { next(e); } });

module.exports = router;