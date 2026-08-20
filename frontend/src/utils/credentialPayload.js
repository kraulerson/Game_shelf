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

  // The server merges over what is stored, so ABSENCE means "unchanged" — which is
  // what makes a reloaded form safe. Removal therefore has to be said out loud: an
  // explicit empty string clears the field.
  //
  // Only an EXPLICIT false is a removal. After a reload totpEnabled is undefined,
  // which means "the form does not know", not "the user turned it off".
  if (creds.totpEnabled === false) {
    payload.totp_secret = '';
  }

  if (payload.totp_secret && creds.totpEnabled !== false) {
    const normalised = normaliseTotpSecret(payload.totp_secret);

    // An empty normalisation result means the field held only whitespace or padding —
    // nothing was entered. It must NOT become an explicit '', because the server reads
    // that as a deliberate clear and would destroy a stored secret the UI can never
    // re-supply. Omit it instead, so the merge leaves the stored value alone.
    if (normalised) {
      payload.totp_secret = normalised;
    } else {
      delete payload.totp_secret;
    }
  }

  return payload;
}
