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

const SALT_BYTES = 32;

function loadOrCreateSalt() {
  const file = saltFilePath();

  if (fs.existsSync(file)) {
    const existing = fs.readFileSync(file);
    if (existing.length !== SALT_BYTES) {
      // scryptSync accepts a short salt happily and derives a key nothing was sealed
      // under, so every credential fails to open while the file sits there looking
      // fine. Refuse rather than derive from it.
      throw new Error(
        `The encryption salt at ${file} is ${existing.length} bytes, expected ` +
        `${SALT_BYTES}. It is truncated or corrupt — restore it from the same backup ` +
        'as the database. Deriving from it would produce the wrong key silently.'
      );
    }
    return existing;
  }

  const salt = crypto.randomBytes(SALT_BYTES);
  fs.mkdirSync(path.dirname(file), { recursive: true });

  try {
    // 'wx' fails if the file appeared since the check above. Without it, two
    // processes racing a first boot each write a different salt and the loser
    // seals everything under a salt that is no longer on disk — permanently
    // unreadable, with no error at the time it happens.
    // Write to a temp file and rename: writeFileSync is not atomic, so a crash or a
    // full disk mid-write leaves a short salt that reads back as valid. 'wx' on the
    // temp keeps the two-process race guard.
    const tmp = `${file}.${process.pid}.tmp`;
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try {
      fs.writeSync(fd, salt);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
    // Say so. Minting is a legitimate first-run event, but it is also what happens
    // when a container starts before its data volume is attached — and then every
    // credential saved in that window is sealed under a salt that disappears on the
    // next restart, with nothing else to indicate it. Refusing instead was tried and
    // deadlocked recovery, so this announces rather than blocks.
    console.warn(`[encrypt] Created a new encryption salt at ${file}.`);
    return salt;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    return fs.readFileSync(file);
  }
}

// Raw key material must be DECLARED, never guessed from shape. Sniffing looked
// convenient and was dangerous: .env.example's own 43-character placeholder matches
// the base64url alphabet and decodes to exactly 32 bytes, so a low-entropy English
// string was used verbatim as the AES-256 key with the KDF skipped — strictly worse
// than the unsalted SHA-256 this module replaced. Any 43-character passphrase an
// operator happened to choose got the same treatment, silently.
const RAW_KEY_PREFIXES = {
  'hex:': 'hex',
  'base64:': 'base64',
};

function asRawKey(value, label = 'GAMESHELF_ENCRYPTION_KEY') {
  for (const [prefix, encoding] of Object.entries(RAW_KEY_PREFIXES)) {
    if (!value.startsWith(prefix)) continue;

    const encoded = value.slice(prefix.length);
    // Decode base64url through the base64url decoder: feeding '-'/'_' to the base64
    // decoder drops them, which is precisely the silent truncation this guards against.
    const decoded = Buffer.from(encoded, encoding === 'base64' && /[-_]/.test(encoded) ? 'base64url' : encoding);

    if (decoded.length !== KEY_BYTES) {
      throw new Error(
        `${label} declared "${prefix}" must decode to exactly ` +
        `${KEY_BYTES} bytes (64 hex characters, or 44 base64). Got ${decoded.length}.`
      );
    }

    // Buffer.from stops at the first invalid character and pads the rest, so a
    // mistyped or truncated key can still yield 32 bytes — different bytes than the
    // operator intended, accepted silently, discovered only when they try to restore
    // from the value they believe they saved. Re-encoding proves nothing was dropped.
    //
    // Both sides are normalised first, or the check rejects legitimate keys: padded
    // base64, unpadded base64 (`openssl rand -base64 32 | tr -d '='`) and base64url
    // all decode to byte-identical material, and re-encoding always produces the
    // padded standard form. Comparing raw made two of those three fail to boot with a
    // "characters were dropped" message describing a corruption that did not exist.
    const normalise = (v) =>
      encoding === 'hex'
        ? v.toLowerCase()
        : v.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');

    const matches = normalise(decoded.toString(encoding)) === normalise(encoded);

    if (!matches) {
      throw new Error(
        `${label} declared "${prefix}" is not valid ${encoding}: ` +
        'characters were dropped when decoding it, so the key in use would not be ' +
        'the one you supplied. Check for a truncated or mistyped value.'
      );
    }

    return decoded;
  }

  return null;
}

// Validate a declared raw key at startup rather than on the first credential save:
// a malformed one is a configuration error, and finding out about it when someone
// tries to store a password is far too late.
asRawKey(rawKey);

/** 'raw' when the key was declared as key material, 'scrypt' when it is stretched. */
function derivationMode() {
  return asRawKey(rawKey) ? 'raw' : 'scrypt';
}

// scrypt is deliberately expensive, and rotation derives keys once per row.
// Cache within the process; nothing is written to disk.
const keyCache = new Map();

function deriveKey(passphrase) {
  // Keyed by digest, never by the passphrase itself: rotation derives under both the
  // old and the new key, so a plaintext-keyed cache left both master passphrases
  // resident in the heap for the life of the process.
  const raw = asRawKey(passphrase);

  // Raw keys never touch the salt; passphrases must be cached against the salt they
  // were actually stretched with, or any change of effective salt leaves a stale key
  // sealing blobs nothing can reopen after a restart.
  const salt = raw ? Buffer.alloc(0) : loadOrCreateSalt();
  const cacheKey = crypto
    .createHash('sha256')
    .update(passphrase)
    .update(salt)
    .digest('hex');

  if (keyCache.has(cacheKey)) return keyCache.get(cacheKey);

  const key = raw || crypto.scryptSync(passphrase, salt, KEY_BYTES, SCRYPT_PARAMS);

  keyCache.set(cacheKey, key);
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
  if (payload === null) return false;

  // Version as well as key id. deriveKey is version-independent, so comparing the key
  // id alone would report every v1 blob as already-sealed after a SCHEMA_VERSION bump,
  // and the v1 -> v2 migration would skip all of them and report success.
  return payload.v === SCHEMA_VERSION && payload.kid === keyIdFor(deriveKey(passphrase));
}

// One table drives reads for every version. The write side stamps SCHEMA_VERSION, so
// a literal on the read side meant bumping the constant produced blobs the same build
// could not open microseconds later — the exact failure explicit versioning exists to
// prevent. Adding a version means adding a row here and nothing else.
const KEY_DERIVERS = {
  0: deriveLegacyKey,
  1: deriveKey,
};

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
  const deriver = KEY_DERIVERS[payload.v === undefined ? 0 : payload.v];

  if (!deriver) {
    throw new Error(
      `Stored credential uses envelope version ${payload.v}, which this build cannot read`
    );
  }

  const key = deriver(passphrase);

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
  isSealedWith,
  setSaltDirectory,
  assertUsableKey,
  parseDeclaredKey: asRawKey,
  activeKey: () => rawKey,
  envelopeVersion,
  derivationMode,
  saltFilePath,
};
