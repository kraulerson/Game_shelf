const { Router } = require('express');
const authMiddleware = require('../middleware/auth');

const router = Router();

router.use(authMiddleware);

// POST /api/sync/all
// TODO: Implement real sync — iterate enabled launchers, create sync_jobs, fetch game lists
router.post('/all', (req, res) => {
  res.json({ status: 'started' });
});

module.exports = router;
