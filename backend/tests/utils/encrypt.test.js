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
});
