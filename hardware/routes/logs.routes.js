const { Router } = require('express');
const log = require('../logger');

const router = Router();
router.get('/', (req, res) => {
  const limit = Math.min(500, Number(req.query.limit) || 200);
  res.json(log.tail(limit, { controllerId: req.query.controllerId, laneId: req.query.laneId }));
});
module.exports = router;