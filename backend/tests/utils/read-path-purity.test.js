const { describe, it, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

/**
 * Invariant A: the read path is pure.
 *
 * decrypt() must never create, write or repair anything — including the salt. Only
 * encrypt() may mint one.
 *
 * This is the invariant whose absence caused most of this branch's history. Because
 * decrypt() reached loadOrCreateSalt(), every boot-time diagnostic that probed a
 * credential CREATED the salt it was about to report as missing: the operator was told
 * to restore a file that now existed with throwaway contents, and any v0 row re-sealed
 * in that same boot became permanently unreadable once the real salt came back.
 *
 * Enforcing it structurally — two functions, only one of which writes — removes that
 * whole class rather than guarding each caller. It also makes diagnosis honest for
 * free: a missing salt now makes decrypt throw an error that names the missing file,
 * so nothing downstream has to guess between "salt lost" and "key changed".
 */
describe('Invariant A — reading never writes', () => {
  const testDbPath = path.join(__dirname, '..', 'data', 'read-purity', 'test.db');
  const saltPath = path.join(path.dirname(testDbPath), 'encryption-salt');
  const KEY = 'a]V3$k9Lm!pQ2rZ&wX8yB#dF5gH7jN0s';

  function fresh() {
    if (fs.existsSync(saltPath)) fs.unlinkSync(saltPath);
    delete require.cache[require.resolve('../../src/utils/encrypt')];
    return require('../../src/utils/encrypt');
  }

  beforeEach(() => {
    process.env.GAMESHELF_ENCRYPTION_KEY = KEY;
    process.env.GAMESHELF_DB_PATH = testDbPath;
    fs.mkdirSync(path.dirname(testDbPath), { recursive: true });
  });

  after(() => {
    if (fs.existsSync(saltPath)) fs.unlinkSync(saltPath);
    delete process.env.GAMESHELF_ENCRYPTION_KEY;
    delete process.env.GAMESHELF_DB_PATH;
  });

  it('decrypting a v1 blob with the salt absent does not create the salt', () => {
    const sealed = fresh().encrypt('launcher-password');
    assert.ok(fs.existsSync(saltPath), 'sealing should have created the salt');

    // Operator restored the database without the salt beside it.
    fs.unlinkSync(saltPath);
    const mod = fresh();

    assert.throws(() => mod.decrypt(sealed), /salt/i);
    assert.ok(
      !fs.existsSync(saltPath),
      'reading must not create the salt — doing so destroys the evidence and ' +
        'silently re-keys anything written afterwards'
    );
  });

  it('decryptWith is a read too, and the rotation script depends on that', () => {
    // The script proves the NEW key opens what it just wrote before telling the
    // operator to discard the old one. Its only tool for that used to be rotate(),
    // which seals an envelope it discards and whose derivation may create the salt —
    // verifying on the write path, which is what this invariant rules out.
    //
    // The blob must be PRE-VERSIONED for this to discriminate. A v1 blob makes
    // rotate() throw from open() before it ever derives the new key, so the impure
    // implementation looks pure and the test passes either way — which is exactly what
    // the first version of this test did. v0 dispatches to the legacy derivation,
    // which needs no salt, so open() succeeds and the seal that follows is reached.
    // That is also the only case in which the old verifier could really have minted.
    const crypto = require('node:crypto');
    fresh();
    const legacy = crypto.createHash('sha256').update(KEY).digest();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', legacy, iv);
    let data = cipher.update('launcher-password', 'utf8', 'hex');
    data += cipher.final('hex');
    const sealedV0 = Buffer.from(
      JSON.stringify({ iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), data })
    ).toString('base64');

    const mod = fresh();
    assert.ok(!fs.existsSync(saltPath), 'the salt must be absent for the check to mean anything');

    assert.equal(mod.decryptWith(sealedV0, KEY), 'launcher-password');
    assert.ok(
      !fs.existsSync(saltPath),
      'verifying must not mint a salt — rotate() in this position would have'
    );
  });

  it('names the missing salt file, so no caller has to guess the cause', () => {
    const sealed = fresh().encrypt('launcher-password');
    fs.unlinkSync(saltPath);
    const mod = fresh();

    assert.throws(
      () => mod.decrypt(sealed),
      (err) => err.message.includes(saltPath),
      'the error must name the path, so a diagnostic can quote it instead of ' +
        'inferring "salt lost" versus "key changed" from a bare GCM failure'
    );
  });

  it('encrypting with the salt absent DOES create it', () => {
    fresh();
    assert.ok(!fs.existsSync(saltPath));

    const mod = fresh();
    mod.encrypt('x');

    assert.ok(fs.existsSync(saltPath), 'writing is the only path allowed to mint');
    assert.equal(fs.statSync(saltPath).mode & 0o777, 0o600);
  });

  it('a declared raw key never touches the salt on either path', () => {
    const crypto = require('node:crypto');
    process.env.GAMESHELF_ENCRYPTION_KEY = 'hex:' + crypto.randomBytes(32).toString('hex');
    if (fs.existsSync(saltPath)) fs.unlinkSync(saltPath);
    delete require.cache[require.resolve('../../src/utils/encrypt')];
    const mod = require('../../src/utils/encrypt');

    const sealed = mod.encrypt('x');
    assert.equal(mod.decrypt(sealed), 'x');
    assert.ok(!fs.existsSync(saltPath), 'raw keys skip the KDF, so no salt is involved');
  });
});
