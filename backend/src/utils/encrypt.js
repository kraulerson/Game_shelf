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

/**
 * Raised when a passphrase-derived key is needed but the salt file is absent.
 *
 * A distinct type so callers can report the real cause instead of inferring it from a
 * bare GCM authentication failure — which cannot distinguish "the salt was lost" from
 * "the key was changed", and which earlier revisions of this module guessed at wrongly
 * in both directions.
 */
class SaltMissingError extends Error {
  constructor(file) {
    super(
      `The encryption salt at ${file} does not exist, but stored credentials were ` +
      'sealed with one. Restore that file from the same backup as the database. ' +
      'Nothing has been created in its place.'
    );
    this.name = 'SaltMissingError';
    this.saltPath = file;
  }
}

/**
 * Read the salt. NEVER creates it — this is the read path (Invariant A).
 *
 * Reading used to be able to mint, which meant every boot-time probe created the salt
 * it was about to report as missing: the operator was told to restore a file that now
 * existed with throwaway contents, and anything re-sealed during that same boot became
 * unreadable the moment the real salt came back.
 */
function loadSalt() {
  const file = saltFilePath();

  if (!fs.existsSync(file)) throw new SaltMissingError(file);

  const existing = fs.readFileSync(file);

  if (existing.length !== SALT_BYTES) {
    // scryptSync accepts a short salt happily and derives a key nothing was sealed
    // under, so every credential fails to open while the file sits there looking fine.
    throw new Error(
      `The encryption salt at ${file} is ${existing.length} bytes, expected ` +
      `${SALT_BYTES}. It is truncated or corrupt. If credentials were already stored, ` +
      'restore it from the same backup as the database; if this was a failed first ' +
      'creation, deleting the file is safe because nothing was sealed with it.'
    );
  }

  return existing;
}

/** Create the salt if absent. The ONLY function permitted to write it. */
function createSaltIfMissing() {
  const file = saltFilePath();

  if (fs.existsSync(file)) return loadSalt();

  const salt = crypto.randomBytes(SALT_BYTES);
  fs.mkdirSync(path.dirname(file), { recursive: true });

  try {
    // 'wx' on the REAL path, deliberately not a temp file plus rename: rename
    // overwrites unconditionally and per-pid temp names never collide, so a
    // temp-and-rename version let two processes racing a first boot both "win", and
    // one then sealed credentials under a salt no longer on disk. A single small write
    // is not formally atomic, but loadSalt's length check refuses a torn salt loudly
    // rather than deriving a wrong key from it, which is the property that matters.
    fs.writeFileSync(file, salt, { flag: 'wx', mode: 0o600 });

    // Minting is a legitimate first-run event, but it is also what happens when a
    // container starts before its data volume is attached.
    console.warn(`[encrypt] Created a new encryption salt at ${file}.`);
    return salt;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    // Another process won the race. Re-read through the same validation.
    return loadSalt();
  }
}

// Raw key material must be DECLARED, never guessed from shape. Sniffing looked
// convenient and was dangerous: .env.example's own 43-character placeholder matches
// the base64url alphabet and decodes to exactly 32 bytes, so a low-entropy English
// string was used verbatim as the AES-256 key with the KDF skipped — strictly worse
// than the unsalted SHA-256 this module replaced.
//
// Hex, and only hex. Accepting base64 meant supporting padded, unpadded and base64url
// — three spellings of the same bytes — which needed a round-trip validator to catch
// truncation, which then rejected two of those three spellings and stopped the app
// booting. Hex has one alphabet and one canonical form, so validation is a regex and
// nothing else. That is the whole point: this module's key handling produced two of
// the eight regression rounds, and every one of them came from having more than one
// way to write the same key.
const HEX_PREFIX = 'hex:';
const HEX_KEY = /^[0-9a-f]{64}$/i;

function asRawKey(value, label = 'GAMESHELF_ENCRYPTION_KEY') {
  if (value.startsWith('base64:')) {
    throw new Error(
      `${label} uses the removed "base64:" form. Declare the key as hex instead: ` +
      'echo "hex:$(openssl rand -hex 32)"'
    );
  }

  if (!value.startsWith(HEX_PREFIX)) return null;

  const encoded = value.slice(HEX_PREFIX.length);

  if (!HEX_KEY.test(encoded)) {
    throw new Error(
      `${label} declared "hex:" must be exactly 64 hex characters (32 bytes). ` +
      `Got ${encoded.length} character(s)` +
      (/[^0-9a-f]/i.test(encoded) ? ', including a non-hex character.' : '.')
    );
  }

  return Buffer.from(encoded, 'hex');
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

function deriveKey(passphrase, { create = false } = {}) {
  // Keyed by digest, never by the passphrase itself: rotation derives under both the
  // old and the new key, so a plaintext-keyed cache left both master passphrases
  // resident in the heap for the life of the process.
  const raw = asRawKey(passphrase);

  // Raw keys never touch the salt; passphrases must be cached against the salt they
  // were actually stretched with, or any change of effective salt leaves a stale key
  // sealing blobs nothing can reopen after a restart.
  // Reading never mints (Invariant A); only sealing may. Defaulting to read means a
  // new call site is safe unless it deliberately opts into writing.
  const salt = raw ? Buffer.alloc(0) : create ? createSaltIfMissing() : loadSalt();
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
  return sealWith(plaintext, deriveKey(rawKey, { create: true }));
}

function decrypt(ciphertext) {
  return open(ciphertext, rawKey);
}

// Re-seal a blob from one passphrase to another. This is what makes changing
// GAMESHELF_ENCRYPTION_KEY a recoverable operation rather than a destructive one.
// Passing the same passphrase twice upgrades a legacy blob to the current scheme.
function rotate(ciphertext, oldPassphrase, newPassphrase) {
  assertUsableKey(newPassphrase, 'The new encryption key');

  return sealWith(open(ciphertext, oldPassphrase), deriveKey(newPassphrase, { create: true }));
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
  SaltMissingError,
  saltExists: () => fs.existsSync(saltFilePath()),
};
