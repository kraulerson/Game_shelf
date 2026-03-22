const jwt = require('jsonwebtoken');

function authMiddleware(req, res, next) {
  const token = req.cookies && req.cookies.gameshelf_session;

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const decoded = jwt.verify(token, process.env.GAMESHELF_JWT_SECRET);
    req.user = { id: decoded.id, username: decoded.username };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
}

module.exports = authMiddleware;
