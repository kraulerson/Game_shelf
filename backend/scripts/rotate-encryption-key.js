#!/usr/bin/env node
/**
 * Re-seal every stored launcher credential under a new encryption key.
 *
 * Without this, changing GAMESHELF_ENCRYPTION_KEY leaves every stored credential
 * permanently unreadable, with no way back. Run this instead:
 *
 *   GAMESHELF_ENCRYPTION_KEY=<current> \
 *   GAMESHELF_ENCRYPTION_KEY_NEW=<new> \
 *   node scripts/rotate-encryption-key.js
 *
 * Then set GAMESHELF_ENCRYPTION_KEY to the new value and restart the app.
 *
 * The rewrite runs as a single transaction: either every credential moves to the
 * new key or none does. A partial rotation would leave credentials split across
 * two keys with nothing recording which is which, so it is made impossible.
 */

const newKey = process.env.GAMESHELF_ENCRYPTION_KEY_NEW;

if (!newKey) {
  console.error(
    'GAMESHELF_ENCRYPTION_KEY_NEW is required. Set it to the new key and re-run.\n' +
    'Nothing has been changed.'
  );
  process.exit(1);
}

const oldKey = process.env.GAMESHELF_ENCRYPTION_KEY;

if (!oldKey) {
  console.error(
    'GAMESHELF_ENCRYPTION_KEY is required — it is the key the stored credentials ' +
    'are currently sealed under.\nNothing has been changed.'
  );
  process.exit(1);
}

const dbPath = process.env.GAMESHELF_DB_PATH || './data/gameshelf.db';

let db;

try {
  const Database = require('better-sqlite3');
  const { rotateAllCredentials } = require('../src/utils/rotateCredentials');

  db = new Database(dbPath);

  const { rotated, skipped } = rotateAllCredentials(db, oldKey, newKey);

  console.log(`Rotated ${rotated} credential(s); skipped ${skipped} unconfigured launcher(s).`);
  console.log('Now set GAMESHELF_ENCRYPTION_KEY to the new value and restart Gameshelf.');
} catch (err) {
  console.error(`Rotation failed: ${err.message}`);
  console.error('The database was left unchanged — the rewrite runs in one transaction.');
  process.exitCode = 1;
} finally {
  if (db) db.close();
}
