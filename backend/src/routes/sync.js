const { Router } = require('express');
const router = Router();

// TODO: Implement sync trigger/status routes
router.use((req, res) => {
  res.status(501).json({ message: 'Not implemented' });
});

module.exports = router;
