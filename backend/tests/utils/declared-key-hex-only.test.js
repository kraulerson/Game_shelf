const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

/**
 * Declared raw keys are hex, and only hex.
 *
 * Key-shape handling produced two of this branch's eight regression rounds. Accepting
 * base64 meant supporting padded, unpadded and base64url — three spellings of the same
 * bytes — which needed a round-trip validator to catch truncation, which then rejected
 * two of the three legitimate spellings and stopped the app booting entirely.
 *
 * Hex has one alphabet and one canonical form, so validation is a regex and a length.
 * No normaliser, no round trip, no encoding table. Nothing deployed uses a declared key
 * (this branch is unmerged), and .env.example already recommends `openssl rand -hex 32`.
 */
describe('declared keys are hex-only', () => {
  const testDbPath = path.join(__dirname, '..', 'data', 'hex-only', 'test.db');
  const saltPath = path.join(path.dirname(testDbPath), 'encryption-salt');

  function withKey(key) {
    if (fs.existsSync(saltPath)) fs.unlinkSync(saltPath);
    delete require.cache[require.resolve('../../src/utils/encrypt')];
    process.env.GAMESHELF_ENCRYPTION_KEY = key;
    process.env.GAMESHELF_DB_PATH = testDbPath;
    fs.mkdirSync(path.dirname(testDbPath), { recursive: true });
    return require('../../src/utils/encrypt');
  }

  after(() => {
    if (fs.existsSync(saltPath)) fs.unlinkSync(saltPath);
    delete process.env.GAMESHELF_ENCRYPTION_KEY;
    delete process.env.GAMESHELF_DB_PATH;
  });

  const key = crypto.randomBytes(32);

  it('rejects a base64: key and points at the hex form', () => {
    assert.throws(
      () => withKey('base64:' + key.toString('base64')),
      /hex:/,
      'the error must tell the operator the supported form, not just refuse'
    );
  });

  it('accepts hex in either case', () => {
    assert.doesNotThrow(() => withKey('hex:' + key.toString('hex')));
    assert.doesNotThrow(() => withKey('hex:' + key.toString('hex').toUpperCase()));
  });

  it('derives the same key from upper and lower case hex', () => {
    const sealed = withKey('hex:' + key.toString('hex')).encrypt('secret');
    const upper = withKey('hex:' + key.toString('hex').toUpperCase());
    assert.equal(upper.decrypt(sealed), 'secret', 'case must not change the key');
  });

  it('rejects hex of the wrong length', () => {
    assert.throws(() => withKey('hex:' + 'ab'.repeat(20)), /64 hex|32 bytes/i);
  });

  it('rejects hex containing a non-hex character', () => {
    // Buffer.from stops at the first invalid character and pads, so 'zz' at the end
    // still yields 32 bytes — different bytes than intended, accepted silently.
    assert.throws(() => withKey('hex:' + '00'.repeat(31) + 'zz'), /hex/i);
  });

  it('still treats an unprefixed value as a passphrase', () => {
    const mod = withKey('change_this_to_a_random_32_plus_char_string');
    assert.equal(mod.derivationMode(), 'scrypt');
  });
});
