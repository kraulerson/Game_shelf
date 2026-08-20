#!/usr/bin/env node
/**
 * Re-seal every stored launcher credential under a new encryption key.
 *
 * Without this, changing GAMESHELF_ENCRYPTION_KEY leaves every stored credential
 * permanently unreadable, with no way back. Run this instead:
 *
 *   docker compose stop backend        # REQUIRED — see below
 *   GAMESHELF_ENCRYPTION_KEY=<current> \
 *   GAMESHELF_ENCRYPTION_KEY_NEW=<new> \
 *   node scripts/rotate-encryption-key.js
 *
 * Stop the app first. A sync in flight decrypts under the OLD key, spends seconds on
 * a network refresh, and writes the credential back AFTER this script commits — under
 * the old key, because that process still holds it. The store then straddles two keys
 * with nothing recording which is which, and that launcher becomes unreadable once
 * you switch over.
 *
 * Then set GAMESHELF_ENCRYPTION_KEY to the new value and restart the app.
 *
 * The rewrite runs as a single transaction: either every credential moves to the
 * new key or none does. A partial rotation would leave credentials split across
 * two keys with nothing recording which is which, so it is made impossible.
 */

const path = require('node:path');

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

// Validate the new key BEFORE touching the database, using the app's own definition
// of a usable key rather than a copy of it. Deferring to rotate() meant a store with
// no credentials never reached the check at all, so the script reported success for a
// key the app then refuses at boot; re-implementing the rule here would let the two
// drift the moment encrypt.js changes what it accepts.
try {
  require('../src/utils/encrypt').assertUsableKey(newKey, 'GAMESHELF_ENCRYPTION_KEY_NEW');
} catch (err) {
  console.error(`${err.message}\nNothing has been changed.`);
  process.exit(1);
}

const dbPath = process.env.GAMESHELF_DB_PATH || './data/gameshelf.db';

let db;

try {
  const Database = require('better-sqlite3');
  const { rotateAllCredentials } = require('../src/utils/rotateCredentials');

  // Pin the salt to the database being rewritten, exactly as runMigrations does.
  // Without this the script re-derives the location from the environment while the
  // migration derives it from its argument — the divergence setSaltDirectory exists
  // to close, reintroduced in the one tool that rewrites every credential at once.
  require('../src/utils/encrypt').setSaltDirectory(path.dirname(dbPath));

  // If this run mints the salt, it is owned by whoever ran the script. Running it as
  // root inside the container leaves a 0600 root:root salt that the app — running as
  // USER node — then cannot read, failing every sync and every credential save with an
  // opaque 500. Warn rather than guess at the right uid.
  const saltFile = require('../src/utils/encrypt').saltFilePath();
  if (!require('node:fs').existsSync(saltFile) && typeof process.getuid === 'function') {
    console.warn(
      `Note: this run will create ${saltFile} owned by uid ${process.getuid()}. ` +
      'If that is not the uid the app runs as, it will not be able to read it. ' +
      'Inside Docker use: docker compose run --rm --user node backend node scripts/rotate-encryption-key.js'
    );
  }

  db = new Database(dbPath, { fileMustExist: true });

  const { rotated, skipped } = rotateAllCredentials(db, oldKey, newKey);

  console.log(
    `Rotated ${rotated} credential(s); skipped ${skipped} ` +
    '(no credentials stored, or already sealed under the new key).'
  );
  console.log('Now set GAMESHELF_ENCRYPTION_KEY to the new value and restart Gameshelf.');
} catch (err) {
  if (err.code === 'SQLITE_CANTOPEN') {
    console.error(
      `Database not found at ${dbPath}. Set GAMESHELF_DB_PATH, or run this from the ` +
      'directory containing ./data/gameshelf.db.\nNothing has been changed.'
    );
  } else {
    console.error(`Rotation failed: ${err.message}`);
    console.error('The database was left unchanged — the rewrite runs in one transaction.');
  }
  process.exitCode = 1;
} finally {
  if (db) db.close();
}
