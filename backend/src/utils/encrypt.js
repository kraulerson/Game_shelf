const crypto = require('node:crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

const rawKey = process.env.GAMESHELF_ENCRYPTION_KEY;

if (!rawKey) {
  throw new Error(
    'GAMESHELF_ENCRYPTION_KEY environment variable is required. ' +
    'Set it to a random string of 32+ characters.'
  );
}

if (rawKey.length < 32) {
  throw new Error(
    'GAMESHELF_ENCRYPTION_KEY must be at least 32 characters long. ' +
    `Current length: ${rawKey.length}`
  );
}

// Derive a fixed 32-byte key from the passphrase using SHA-256
const key = crypto.createHash('sha256').update(rawKey).digest();

function encrypt(plaintext) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const tag = cipher.getAuthTag().toString('hex');

  const payload = JSON.stringify({
    iv: iv.toString('hex'),
    tag,
    data: encrypted,
  });

  return Buffer.from(payload).toString('base64');
}

function decrypt(ciphertext) {
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

module.exports = { encrypt, decrypt };
