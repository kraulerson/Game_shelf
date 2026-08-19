const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

describe('encrypt utility', () => {
  const TEST_KEY = 'a]V3$k9Lm!pQ2rZ&wX8yB#dF5gH7jN0s';

  before(() => {
    process.env.GAMESHELF_ENCRYPTION_KEY = TEST_KEY;
  });

  after(() => {
    delete process.env.GAMESHELF_ENCRYPTION_KEY;
  });

  it('should encrypt and decrypt a string round-trip', () => {
    delete require.cache[require.resolve('../../src/utils/encrypt')];
    const { encrypt, decrypt } = require('../../src/utils/encrypt');

    const plaintext = 'hello world';
    const encrypted = encrypt(plaintext);
    const decrypted = decrypt(encrypted);
    assert.equal(decrypted, plaintext);
  });

  it('should produce different ciphertext for the same input (random IV)', () => {
    delete require.cache[require.resolve('../../src/utils/encrypt')];
    const { encrypt } = require('../../src/utils/encrypt');

    const a = encrypt('same input');
    const b = encrypt('same input');
    assert.notEqual(a, b);
  });

  it('should encrypt/decrypt JSON objects', () => {
    delete require.cache[require.resolve('../../src/utils/encrypt')];
    const { encrypt, decrypt } = require('../../src/utils/encrypt');

    const creds = JSON.stringify({ username: 'user', password: 'pass123' });
    const encrypted = encrypt(creds);
    const decrypted = decrypt(encrypted);
    assert.deepEqual(JSON.parse(decrypted), { username: 'user', password: 'pass123' });
  });

  it('should produce base64-encoded output containing iv, tag, data', () => {
    delete require.cache[require.resolve('../../src/utils/encrypt')];
    const { encrypt } = require('../../src/utils/encrypt');

    const encrypted = encrypt('test');
    const parsed = JSON.parse(Buffer.from(encrypted, 'base64').toString('utf8'));
    assert.ok(parsed.iv, 'missing iv');
    assert.ok(parsed.tag, 'missing tag');
    assert.ok(parsed.data, 'missing data');
  });

  it('should throw if encryption key is missing', () => {
    delete process.env.GAMESHELF_ENCRYPTION_KEY;
    delete require.cache[require.resolve('../../src/utils/encrypt')];

    assert.throws(
      () => require('../../src/utils/encrypt'),
      /GAMESHELF_ENCRYPTION_KEY/
    );

    process.env.GAMESHELF_ENCRYPTION_KEY = TEST_KEY;
  });

  it('should throw if encryption key is too short', () => {
    process.env.GAMESHELF_ENCRYPTION_KEY = 'tooshort';
    delete require.cache[require.resolve('../../src/utils/encrypt')];

    assert.throws(
      () => require('../../src/utils/encrypt'),
      /32/
    );

    process.env.GAMESHELF_ENCRYPTION_KEY = TEST_KEY;
  });

  it('should stamp the envelope with a schema version and a key id', () => {
    delete require.cache[require.resolve('../../src/utils/encrypt')];
    const { encrypt } = require('../../src/utils/encrypt');

    const parsed = JSON.parse(Buffer.from(encrypt('test'), 'base64').toString('utf8'));
    assert.equal(parsed.v, 1, 'envelope must declare schema version 1');
    assert.ok(parsed.kid, 'envelope must carry a key id so rotation can tell keys apart');
  });


  it('should re-seal a blob under a new key so the new key can read it', () => {
    const OLD_KEY = 'old]V3$k9Lm!pQ2rZ&wX8yB#dF5gH7jN0s';
    const NEW_KEY = 'new]V3$k9Lm!pQ2rZ&wX8yB#dF5gH7jN0s';

    process.env.GAMESHELF_ENCRYPTION_KEY = OLD_KEY;
    delete require.cache[require.resolve('../../src/utils/encrypt')];
    const oldMod = require('../../src/utils/encrypt');
    const sealedUnderOld = oldMod.encrypt('launcher-password');

    const sealedUnderNew = oldMod.rotate(sealedUnderOld, OLD_KEY, NEW_KEY);

    process.env.GAMESHELF_ENCRYPTION_KEY = NEW_KEY;
    delete require.cache[require.resolve('../../src/utils/encrypt')];
    const newMod = require('../../src/utils/encrypt');
    assert.equal(newMod.decrypt(sealedUnderNew), 'launcher-password');

    process.env.GAMESHELF_ENCRYPTION_KEY = TEST_KEY;
  });


  it('should refuse to rotate onto a key that is too short', () => {
    delete require.cache[require.resolve('../../src/utils/encrypt')];
    const { encrypt, rotate } = require('../../src/utils/encrypt');

    const sealed = encrypt('launcher-password');

    assert.throws(
      () => rotate(sealed, TEST_KEY, 'tooshort'),
      /32/,
      'rotating onto a weak key must fail loud, not silently downgrade the store'
    );
  });
});
