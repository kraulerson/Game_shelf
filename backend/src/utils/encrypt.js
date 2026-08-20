const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const SCHEMA_VERSION = 1;

// N=2^15 costs ~100ms and ~33MB per derivation. Node's default maxmem is 32MB,
// just under what this needs, so it must be raised explicitly or scryptSync throws.
const SCRYPT_PARAMS = { N: 2 ** 15, r: 8, p: 1, maxmem: 96 * 1024 * 1024 };
const KEY_BYTES = 32;

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

// The salt is not a secret — its job is to make the derived key unique to this
// install, so a precomputed table built against one Gameshelf cannot be reused
// against another. It lives beside the database because it must survive restarts
// and be backed up alongside the credentials it protects.
// runMigrations() receives the database path as an argument while this module reads
// the environment, so the two can disagree and the salt can land beside a different
// database than the one holding the credentials it protects — unrecoverable if the
// mismatch is only noticed later. setSaltDirectory lets the caller that actually
// knows the path say so.
let saltDirOverride = null;

function setSaltDirectory(dir) {
  if (dir === saltDirOverride) return;

  saltDirOverride = dir;
  // Derived keys are memoised against whatever salt was in force when they were
  // computed. Changing the directory without dropping them means we keep sealing
  // under a salt that is not the one on disk — unreadable after restart, with no
  // error at the moment it happens.
  keyCache.clear();
}

function saltFilePath() {
  if (saltDirOverride) return path.join(saltDirOverride, 'encryption-salt');

  const dbPath = process.env.GAMESHELF_DB_PATH || './data/gameshelf.db';
  return path.join(path.dirname(dbPath), 'encryption-salt');
}

function loadOrCreateSalt() {
  const file = saltFilePath();

  if (fs.existsSync(file)) return fs.readFileSync(file);

  const salt = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(file), { recursive: true });

  try {
    // 'wx' fails if the file appeared since the check above. Without it, two
    // processes racing a first boot each write a different salt and the loser
    // seals everything under a salt that is no longer on disk — permanently
    // unreadable, with no error at the time it happens.
    fs.writeFileSync(file, salt, { flag: 'wx', mode: 0o600 });
    return salt;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    return fs.readFileSync(file);
  }
}

// A 32-byte key supplied directly as hex or base64 skips the KDF entirely, which
// is both stronger and faster than stretching a human-chosen passphrase.
function asRawKey(value) {
  if (/^[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value, 'hex');

  // Padded base64, unpadded base64, and base64url (which `randomBytes(32)
  // .toString('base64url')` produces, using - and _). Accepting only the padded form
  // sent base64url keys down the scrypt path instead — contradicting .env.example's
  // claim that the salt is unused for raw keys, and silently making a database-only
  // backup insufficient.
  if (/^[A-Za-z0-9+/\-_]{43}={0,1}$/.test(value)) {
    const decoded = Buffer.from(value, 'base64url');
    if (decoded.length === KEY_BYTES) return decoded;
  }

  return null;
}

// scrypt is deliberately expensive, and rotation derives keys once per row.
// Cache within the process; nothing is written to disk.
const keyCache = new Map();

function deriveKey(passphrase) {
  if (keyCache.has(passphrase)) return keyCache.get(passphrase);

  const raw = asRawKey(passphrase);
  const key = raw || crypto.scryptSync(passphrase, loadOrCreateSalt(), KEY_BYTES, SCRYPT_PARAMS);

  keyCache.set(passphrase, key);
  return key;
}

// How credentials were sealed before the versioned envelope: unsalted, single-pass
// SHA-256. Retained for reading only, so blobs written by older releases still open.
function deriveLegacyKey(passphrase) {
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

function openWith(payload, key) {
  const iv = Buffer.from(payload.iv, 'hex');
  const tag = Buffer.from(payload.tag, 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  let decrypted = decipher.update(payload.data, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

/**
 * The envelope version of a stored blob: 0 for the pre-versioned form, the number for
 * a versioned one, or null when it is not a readable envelope at all. Pure parsing —
 * no key derivation, so it is safe to call before a key exists.
 */
function envelopeVersion(ciphertext) {
  const payload = parseEnvelope(ciphertext);
  if (payload === null) return null;
  return payload.v === undefined ? 0 : payload.v;
}

/**
 * True when a stored blob predates the versioned envelope and can be upgraded.
 *
 * Anything that is not a readable envelope answers false: there is nothing to
 * upgrade, and this is called during startup migration where throwing would take
 * the whole process down. `WHERE credentials_json IS NOT NULL` admits empty
 * strings and arbitrary junk, so this must tolerate both.
 */
function isLegacyEnvelope(ciphertext) {
  const payload = parseEnvelope(ciphertext);
  return payload !== null && payload.v !== SCHEMA_VERSION;
}

function parseEnvelope(ciphertext) {
  if (typeof ciphertext !== 'string' || ciphertext === '') return null;

  try {
    const payload = JSON.parse(Buffer.from(ciphertext, 'base64').toString('utf8'));
    if (payload === null || typeof payload !== 'object') return null;
    if (
      typeof payload.iv !== 'string' ||
      typeof payload.data !== 'string' ||
      typeof payload.tag !== 'string'
    ) {
      return null;
    }
    // A non-numeric version is a malformed envelope, not a future one. Letting it
    // through produced "uses envelope version 1, which this build cannot read" for
    // `v: '1'` — an error naming the exact version this build does read.
    if (payload.v !== undefined && typeof payload.v !== 'number') return null;
    return payload;
  } catch {
    return null;
  }
}

/** True when this blob is already sealed under the key `passphrase` derives. */
function isSealedWith(ciphertext, passphrase) {
  const payload = parseEnvelope(ciphertext);
  return payload !== null && payload.kid === keyIdFor(deriveKey(passphrase));
}

// The envelope says which derivation sealed it, so old and new blobs coexist and
// a half-finished migration still reads correctly.
function open(ciphertext, passphrase) {
  const payload = parseEnvelope(ciphertext);

  if (payload === null) {
    throw new Error('Stored credential is not a readable envelope');
  }

  // Dispatch on the version explicitly, never on "is it the current one". A binary
  // current-vs-legacy test means the next SCHEMA_VERSION bump silently routes every
  // existing v1 blob to the old weak derivation — the exact failure a versioned
  // envelope exists to prevent.
  let key;
  if (payload.v === undefined || payload.v === 0) {
    key = deriveLegacyKey(passphrase);
  } else if (payload.v === 1) {
    key = deriveKey(passphrase);
  } else {
    throw new Error(
      `Stored credential uses envelope version ${payload.v}, which this build cannot read`
    );
  }

  return openWith(payload, key);
}

function encrypt(plaintext) {
  return sealWith(plaintext, deriveKey(rawKey));
}

function decrypt(ciphertext) {
  return open(ciphertext, rawKey);
}

// Re-seal a blob from one passphrase to another. This is what makes changing
// GAMESHELF_ENCRYPTION_KEY a recoverable operation rather than a destructive one.
// Passing the same passphrase twice upgrades a legacy blob to the current scheme.
function rotate(ciphertext, oldPassphrase, newPassphrase) {
  assertUsableKey(newPassphrase, 'The new encryption key');

  return sealWith(open(ciphertext, oldPassphrase), deriveKey(newPassphrase));
}

module.exports = {
  encrypt,
  decrypt,
  rotate,
  isLegacyEnvelope,
  isSealedWith,
  setSaltDirectory,
  assertUsableKey,
  envelopeVersion,
};
