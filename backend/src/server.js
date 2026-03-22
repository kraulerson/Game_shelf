require('dotenv').config();

// Validate required env vars before anything else
const requiredEnv = [
  { name: 'GAMESHELF_ENCRYPTION_KEY', minLength: 32 },
  { name: 'GAMESHELF_JWT_SECRET', minLength: 1 },
];

for (const { name, minLength } of requiredEnv) {
  const val = process.env[name];
  if (!val) {
    console.error(`FATAL: ${name} environment variable is required.`);
    process.exit(1);
  }
  if (val.length < minLength) {
    console.error(
      `FATAL: ${name} must be at least ${minLength} characters. Current: ${val.length}`
    );
    process.exit(1);
  }
}

const express = require('express');
const cookieParser = require('cookie-parser');
const cron = require('node-cron');
const { runMigrations } = require('./db/migrate');
const errorHandler = require('./middleware/errorHandler');
const { syncAll } = require('./services/syncEngine');

// Routes
const authRouter = require('./routes/auth');
const setupRouter = require('./routes/setup');
const launchersRouter = require('./routes/launchers');
const gamesRouter = require('./routes/games');
const syncRouter = require('./routes/sync');

// Run migrations
const dbPath = process.env.GAMESHELF_DB_PATH || './data/gameshelf.db';
const db = runMigrations(dbPath);

// Create app
const app = express();

// Make db available to route handlers
app.locals.db = db;

// Middleware
app.use(express.json());
app.use(cookieParser());

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '1.0.0', app: 'Gameshelf' });
});

// API routes
app.use('/api/auth', authRouter);
app.use('/api/setup', setupRouter);
app.use('/api/launchers', launchersRouter);
app.use('/api/games', gamesRouter);
app.use('/api/sync', syncRouter);

// Global error handler
app.use(errorHandler);

// Start server (only if not imported for testing)
const PORT = process.env.PORT || 3001;

if (require.main === module) {
  cron.schedule('0 */6 * * *', () => {
    console.log('[Gameshelf Scheduler] Starting 6-hour library sync');
    syncAll(db).catch(err => console.error('[Scheduler] syncAll error:', err.message));
  });

  app.listen(PORT, () => {
    console.log(`Gameshelf server running on port ${PORT}`);
  });
}

module.exports = { app, db };
