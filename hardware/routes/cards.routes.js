const { Router } = require('express');
const { z } = require('zod');
const cardEvents = require('../services/cardEventService');
const provisioning = require('../services/cardProvisioning');

const router = Router();

// Pull buffered card swipes (drains the buffer).
router.get('/events', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  res.json({ events: cardEvents.drain(limit), status: cardEvents.status() });
});

// Non-destructive view for the desktop UI.
router.get('/events/recent', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  res.json({ events: cardEvents.peek(limit) });
});

router.get('/status', (_req, res) => res.json({
  ...cardEvents.status(),
  provisioned: provisioning.state(),
}));

// Arm alarm channels on every controller backing a lane.
router.post('/arm', async (_req, res, next) => {
  try { cardEvents.start(); res.json({ ok: true, controllers: await cardEvents.armAll() }); }
  catch (e) { next(e); }
});

const tagSchema = z.object({
  tagUid: z.string().min(1),
  label: z.string().nullish(),
  laneId: z.string().nullish(),
  paused: z.boolean().optional(),
});

// Cloud pushes the approved tag list here every sync.
router.post('/approved', (req, res) => {
  const p = z.object({ tags: z.array(tagSchema) }).safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: p.error.flatten() });
  res.json({ ok: true, count: cardEvents.setApprovedTags(p.data.tags) });
});

// Write the approved (non-paused) cards down to a controller.
router.post('/provision', async (req, res, next) => {
  const p = z.object({
    controllerId: z.string().min(1),
    cards: z.array(z.object({ cardNo: z.string().min(1), employeeNo: z.string().optional() })),
  }).safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: p.error.flatten() });
  try { res.json(await provisioning.sync(p.data.controllerId, p.data.cards)); }
  catch (e) { next(e); }
});

module.exports = router;
