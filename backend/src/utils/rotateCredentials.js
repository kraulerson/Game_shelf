const { rotate, isSealedWith, envelopeVersion } = require('./encrypt');

/**
 * Re-seal every stored launcher credential from one encryption key to another.
 *
 * This is what makes changing GAMESHELF_ENCRYPTION_KEY a recoverable operation.
 * Without it, changing the key leaves every credential permanently unreadable.
 *
 * `onError` selects the two callers' genuinely different needs:
 *
 *   'abort' (default) — the operator-run rotation script. A partial rotation would
 *     leave credentials split across two keys with nothing recording which is which,
 *     so any failure rolls the whole batch back.
 *
 *   'skip' — the startup migration. Throwing there is uncaught at server.js and,
 *     with docker-compose's `restart: unless-stopped`, becomes an endless crash loop
 *     with no in-app recovery. Reads dispatch on the envelope version, so leaving an
 *     un-re-sealable blob alone is safe; it is reported instead.
 *
 * Returns { rotated, skipped, failed } — `skipped` counts launchers with no
 * credentials plus those already sealed under the target key.
 */
function rotateAllCredentials(db, oldPassphrase, newPassphrase, { onError = 'abort' } = {}) {
  const update = db.prepare('UPDATE launchers SET credentials_json = ? WHERE id = ?');

  let rotated = 0;
  let skipped = 0;
  const failed = [];

  // All-or-nothing under 'abort'. The SELECT lives inside the transaction so the rows
  // read and the rows written come from one snapshot.
  //
  // What this does NOT do, despite an earlier version of this comment claiming it:
  // protect against a running app. A deferred BEGIN takes its WAL read snapshot at the
  // first statement, so a concurrent commit makes the UPDATE fail rather than
  // serialise — and the race the script header describes is worse than that anyway. A
  // sync that decrypted under the old key before this ran will write its refreshed
  // token back AFTER this commits, under the key its process still holds, leaving the
  // store straddling two keys. Transaction scope cannot prevent that. Stopping the
  // backend first is the only protection, which is why the script and .env.example
  // both say to.
  const runAll = db.transaction(() => {
    rotated = 0;
    skipped = 0;
    failed.length = 0;

    const rows = db.prepare('SELECT id, name, credentials_json FROM launchers').all();

    for (const row of rows) {
      if (!row.credentials_json) {
        skipped++;
        continue;
      }

      // A value that is not an envelope at all holds no credential, so there is
      // nothing to re-seal. Aborting the operator's whole rotation because one row
      // contains a placeholder — which this repo's own tests write — would be a
      // decryption error reported for something that was never a credential.
      if (envelopeVersion(row.credentials_json) === null) {
        skipped++;
        continue;
      }

      try {
        // Already under the target key — a re-run after an interrupted rotation.
        // Without this, the first such row fails GCM authentication and aborts the
        // batch, reporting a decryption error for work that had already succeeded.
        //
        // Inside the try because it derives a key, which reads (or creates) the salt
        // file: a disk-full or permission error here would otherwise escape the loop,
        // the transaction and runMigrations, crash-looping the container.
        if (isSealedWith(row.credentials_json, newPassphrase)) {
          skipped++;
          continue;
        }

        update.run(rotate(row.credentials_json, oldPassphrase, newPassphrase), row.id);
        rotated++;
      } catch (err) {
        if (onError === 'abort') throw err;
        failed.push({ name: row.name, reason: err.message });
      }
    }
  });

  runAll();

  return { rotated, skipped, failed };
}

module.exports = { rotateAllCredentials };
