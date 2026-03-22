const { Router } = require('express');
const router = Router();

// TODO: Implement auth routes (login, logout, me)
router.use((req, res) => {
  res.status(501).json({ message: 'Not implemented' });
});

module.exports = router;
