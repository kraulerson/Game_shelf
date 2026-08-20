/**
 * Build the request body for POST /api/launchers/:id/credentials from form state.
 *
 * Strips UI-only keys rather than enumerating the server's field list, which would be
 * a second copy of its contract: any credential field added to the form later would
 * otherwise be silently dropped while the user saw "Saved".
 */
const UI_ONLY = new Set([
  'qrUri',
  'qrError',
  'saved',
  'error',
  'testing',
  'testResult',
  'totpEnabled',
]);

/** Match the QR builder exactly, so the stored secret and the scanned one agree. */
export function normaliseTotpSecret(secret) {
  return String(secret)
    .replace(/\s+/g, '')
    .toUpperCase()
    .replace(/=+$/, '');
}

export function buildCredentialPayload(creds = {}) {
  const payload = {};

  for (const [field, value] of Object.entries(creds)) {
    if (!UI_ONLY.has(field)) payload[field] = value;
  }

  // Only an EXPLICIT false means the user turned TOTP off. After a page reload the
  // form state is empty, so totpEnabled is undefined — treating that as "off" deleted
  // the stored secret whenever someone reopened Setup to fix an unrelated field,
  // because the route replaces credentials_json wholesale and the UI still said
  // "Saved".
  if (creds.totpEnabled === false) {
    delete payload.totp_secret;
  }

  if (payload.totp_secret) {
    payload.totp_secret = normaliseTotpSecret(payload.totp_secret);
  }

  return payload;
}
