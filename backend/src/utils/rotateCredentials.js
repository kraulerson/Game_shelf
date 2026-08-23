const { rotate, isSealedWith, envelopeVersion, SaltMissingError } = require('./encrypt');

/**
 * "Is this row already sealed under the NEW key?" — answered without writing anything.
 *
 * Deriving a passphrase key reads the salt, and when the new key is a passphrase while
 * the current one was declared raw, that salt does not exist yet: a hex: install has
 * never had one. The read path refuses to create it, correctly, so the question itself
 * killed the rotation — quoting an error telling the operator to restore a file that
 * has never been in any backup.
 *
 * Nothing can be sealed under a key that cannot yet be derived, so the honest answer
 * is no, and rotate() then creates the salt on the seal path where creation belongs.
 *
 * Answering instead of propagating is safe in the other direction too. If the salt is
 * genuinely lost on a passphrase install, rotate() evaluates open() with the OLD key
 * first — arguments left to right — and fails there, before anything is asked to
 * create a salt.
 */
function alreadySealedUnder(ciphertext, newPassphrase) {
  try {
    return isSealedWith(ciphertext, newPassphrase);
  } catch (err) {
    if (err instanceof SaltMissingError) return false;
    throw err;
  }
}

/**
 * Re-seal every stored launcher credential from one encryption key to another.
 *
 * This is what makes changing GAMESHELF_ENCRYPTION_KEY a recoverable operation.
 * Without it, changing the key leaves every credential permanently unreadable.
 *
 * All or nothing. A partial rotation would leave credentials split across two keys
 * with nothing recording which is which, so any failure rolls the whole batch back.
 * (There used to be a 'skip' mode for the startup migration, which re-sealed on boot
 * and could not be allowed to throw into a restart loop. Boot no longer writes
 * credentials at all, so the mode had no caller and its `failed` list no reader.)
 *
 * Returns { rotated, skipped, unreadable }. `skipped` counts launchers with no
 * credentials plus those already sealed under the target key; `unreadable` names rows
 * whose stored value is not an envelope at all, which is a real fault and must not be
 * reported as "nothing stored".
 */
function rotateAllCredentials(db, oldPassphrase, newPassphrase) {
  const update = db.prepare('UPDATE launchers SET credentials_json = ? WHERE id = ?');

  let rotated = 0;
  let skipped = 0;
  const unreadable = [];

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
    unreadable.length = 0;

    const rows = db.prepare('SELECT id, name, credentials_json FROM launchers').all();

    for (const row of rows) {
      if (!row.credentials_json) {
        skipped++;
        continue;
      }

      // A value that is not an envelope holds nothing re-sealable. Aborting the
      // operator's whole rotation over one such row would report a decryption error
      // for something that was never a credential — but it must not be silently
      // folded into "no credentials stored" either, because a truncated or corrupted
      // blob looks identical here and is a real fault.
      if (envelopeVersion(row.credentials_json) === null) {
        unreadable.push(row.name);
        continue;
      }

      // Already under the target key — a re-run after an interrupted rotation. Without
      // this, the first such row fails GCM authentication and aborts the batch,
      // reporting a decryption error for work that had already succeeded.
      if (alreadySealedUnder(row.credentials_json, newPassphrase)) {
        skipped++;
        continue;
      }

      update.run(rotate(row.credentials_json, oldPassphrase, newPassphrase), row.id);
      rotated++;
    }
  });

  runAll();

  return { rotated, skipped, unreadable };
}

module.exports = { rotateAllCredentials };
