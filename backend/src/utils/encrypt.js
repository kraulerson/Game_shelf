const crypto = require('node:crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const SCHEMA_VERSION = 1;

// Every path that accepts key material runs this — module load and rotation
// alike. Rotation onto a weak key would silently downgrade the whole store, so
// it fails loud instead.
function assertUsableKey(passphrase, label) {
  if (!passphrase) {
    throw new Error(
      `${label} is required. Set it to a random string of 32+ characters.`
    );
  }

  if (passphrase.length < 32) {
    throw new Error(
      `${label} must be at least 32 characters long. ` +
      `Current length: ${passphrase.length}`
    );
  }
}

const rawKey = process.env.GAMESHELF_ENCRYPTION_KEY;

assertUsableKey(rawKey, 'GAMESHELF_ENCRYPTION_KEY environment variable');

// Derive a fixed 32-byte key from the passphrase using SHA-256
function deriveKey(passphrase) {
  return crypto.createHash('sha256').update(passphrase).digest();
}

// Short, domain-separated fingerprint of a key. Stamped into every envelope so
// rotation can tell which key sealed a given blob without trial decryption. Not
// secret: the envelope already carries ciphertext under this key, which is a far
// stronger oracle than an 8-hex digest.
function keyIdFor(key) {
  return crypto
    .createHash('sha256')
    .update('gameshelf-kid-v1')
    .update(key)
    .digest('hex')
    .slice(0, 8);
}

function sealWith(plaintext, key) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const tag = cipher.getAuthTag().toString('hex');

  const payload = JSON.stringify({
    v: SCHEMA_VERSION,
    kid: keyIdFor(key),
    iv: iv.toString('hex'),
    tag,
    data: encrypted,
  });

  return Buffer.from(payload).toString('base64');
}

function openWith(ciphertext, key) {
  const payload = JSON.parse(Buffer.from(ciphertext, 'base64').toString('utf8'));

  const iv = Buffer.from(payload.iv, 'hex');
  const tag = Buffer.from(payload.tag, 'hex');
  const encrypted = payload.data;

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

const key = deriveKey(rawKey);

function encrypt(plaintext) {
  return sealWith(plaintext, key);
}

function decrypt(ciphertext) {
  return openWith(ciphertext, key);
}

// Re-seal a blob from one passphrase to another. This is what makes changing
// GAMESHELF_ENCRYPTION_KEY a recoverable operation rather than a destructive one.
function rotate(ciphertext, oldPassphrase, newPassphrase) {
  assertUsableKey(newPassphrase, 'The new encryption key');

  const plaintext = openWith(ciphertext, deriveKey(oldPassphrase));
  return sealWith(plaintext, deriveKey(newPassphrase));
}

module.exports = { encrypt, decrypt, rotate };
