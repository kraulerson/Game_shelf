const { rotate } = require('./encrypt');

/**
 * Re-seal every stored launcher credential from one encryption key to another.
 *
 * This is what makes changing GAMESHELF_ENCRYPTION_KEY a recoverable operation.
 * Without it, changing the key leaves every credential permanently unreadable.
 *
 * Returns { rotated, skipped } — skipped counts launchers that have no
 * credentials stored, which are left untouched.
 */
function rotateAllCredentials(db, oldPassphrase, newPassphrase) {
  const rows = db.prepare('SELECT id, credentials_json FROM launchers').all();
  const update = db.prepare('UPDATE launchers SET credentials_json = ? WHERE id = ?');

  let rotated = 0;
  let skipped = 0;

  // All-or-nothing. A partial rotation would leave some credentials under the old
  // key and some under the new one, with nothing recording which is which — an
  // unrecoverable state. Any failure rolls the whole batch back.
  const runAll = db.transaction(() => {
    rotated = 0;
    skipped = 0;

    for (const row of rows) {
      if (!row.credentials_json) {
        skipped++;
        continue;
      }

      update.run(rotate(row.credentials_json, oldPassphrase, newPassphrase), row.id);
      rotated++;
    }
  });

  runAll();

  return { rotated, skipped };
}

module.exports = { rotateAllCredentials };
