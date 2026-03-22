const { Router } = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const authMiddleware = require('../middleware/auth');

const router = Router();

// Dummy hash for timing-safe comparison when user is not found
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', 12);

router.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body || {};

    if (!username || !password) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const db = req.app.locals.db;
    const user = db.prepare('SELECT id, username, password_hash FROM users WHERE username = ?').get(username);

    // Compare against real hash or dummy hash (prevents timing-based enumeration)
    const hashToCompare = user ? user.password_hash : DUMMY_HASH;
    const valid = await bcrypt.compare(password, hashToCompare);

    if (!user || !valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { id: user.id, username: user.username },
      process.env.GAMESHELF_JWT_SECRET,
      { expiresIn: '24h' }
    );

    const isProduction = process.env.NODE_ENV === 'production';

    res.cookie('gameshelf_session', token, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'Strict',
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
      path: '/',
    });

    res.json({ username: user.username });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', (req, res) => {
  const isProduction = process.env.NODE_ENV === 'production';

  res.clearCookie('gameshelf_session', {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'Strict',
    path: '/',
  });

  res.json({ ok: true });
});

router.get('/me', authMiddleware, (req, res) => {
  res.json({ username: req.user.username });
});

module.exports = router;
