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
  const encrypt = require('../src/utils/encrypt');
  encrypt.assertUsableKey(newKey, 'GAMESHELF_ENCRYPTION_KEY_NEW');
  // Also validate the declared hex:/base64: form. assertUsableKey only checks presence
  // and length, so a malformed declared key passed here and — with no credentials to
  // rotate — was never exercised by rotate() either. The script reported success and
  // the app then refused to boot on the key the operator had just adopted.
  encrypt.parseDeclaredKey(newKey, 'GAMESHELF_ENCRYPTION_KEY_NEW');
} catch (err) {
  console.error(`${err.message}\nNothing has been changed.`);
  process.exit(1);
}

const dbPath = process.env.GAMESHELF_DB_PATH || './data/gameshelf.db';

let db;

try {
  const Database = require('better-sqlite3');
  const { rotateAllCredentials } = require('../src/utils/rotateCredentials');
  const encrypt = require('../src/utils/encrypt');

  // Pin the salt to the database being rewritten, exactly as runMigrations does.
  // Without this the script re-derives the location from the environment while the
  // migration derives it from its argument — the divergence setSaltDirectory exists
  // to close, reintroduced in the one tool that rewrites every credential at once.
  encrypt.setSaltDirectory(path.dirname(dbPath));

  // Only meaningful when a salt will actually be created: a declared hex:/base64: key
  // never touches the salt file. Warn about ownership only in the case that can
  // genuinely leave a file the app cannot read.
  const saltFile = encrypt.saltFilePath();
  if (
    // Gate on the NEW key, which is what will actually be derived. Gating on the key
    // already loaded suppressed this warning when rotating from a declared
    // hex:/base64: key to a passphrase — one of the two cases that creates a salt.
    !encrypt.parseDeclaredKey(newKey) &&
    !require('node:fs').existsSync(saltFile) &&
    typeof process.getuid === 'function'
  ) {
    console.warn(
      `Note: this run will create ${saltFile} as uid ${process.getuid()}. If that is ` +
      'not the uid the app runs as, it will not be able to read it.'
    );
  }

  db = new Database(dbPath, { fileMustExist: true });

  const { rotated, skipped, unreadable: corrupt } = rotateAllCredentials(db, oldKey, newKey);

  // Prove the new key actually opens what was just written, before telling the
  // operator to discard the old one. "We wrote something" is not the same claim as
  // "the new key demonstrably works", and this is the one tool whose entire purpose is
  // making the switch non-destructive.
  const written = db
    .prepare('SELECT name, credentials_json FROM launchers WHERE credentials_json IS NOT NULL')
    .all();

  const unopenable = written.filter((row) => {
    if (encrypt.envelopeVersion(row.credentials_json) === null) return false;
    try {
      encrypt.rotate(row.credentials_json, newKey, newKey);
      return false;
    } catch {
      return true;
    }
  });

  if (unopenable.length > 0) {
    console.error(
      `Rotation wrote ${rotated} credential(s), but ${unopenable.length} cannot be ` +
      `re-opened with the new key: ${unopenable.map((r) => r.name).join(', ')}.`
    );
    console.error(
      'Do NOT change GAMESHELF_ENCRYPTION_KEY yet — the old value is still the one ' +
      'that works for those rows. Investigate before switching over.'
    );
    process.exitCode = 1;
  } else {
    console.log(
      `Rotated ${rotated} credential(s); skipped ${skipped} ` +
      '(no credentials stored, or already sealed under the new key).'
    );
    console.log(
      `Verified: ${written.length - corrupt.length} stored credential(s) re-opened ` +
      'with the new key.'
    );
    if (corrupt.length > 0) {
      console.warn(
        `Warning: ${corrupt.length} launcher(s) hold a value that is not a credential ` +
        `envelope and were left untouched: ${corrupt.join(', ')}. These will fail at ` +
        'sync time; re-enter them through the UI.'
      );
    }
    console.log('Now set GAMESHELF_ENCRYPTION_KEY to the new value and restart Gameshelf.');
  }
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
