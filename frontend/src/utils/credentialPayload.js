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
  'priorUnreadable',
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
  // what makes a reloaded form safe. An empty VALUE means the same thing there, by
  // design: too many ordinary things produce a blank field for one to be read as a
  // decision to destroy a secret. Removal is therefore a verb, not a value.
  //
  // Only an EXPLICIT false is a removal. After a reload totpEnabled is undefined,
  // which means "the form does not know", not "the user turned it off".
  if (creds.totpEnabled === false) {
    delete payload.totp_secret;
    payload.remove_totp_secret = true;
    return payload;
  }

  if ('totp_secret' in payload) {
    // Match the QR builder, so the stored secret and the scanned one agree. An empty
    // result means the field held only whitespace or padding — nothing was entered —
    // so omit it and leave whatever is stored alone.
    const normalised = normaliseTotpSecret(payload.totp_secret ?? '');

    if (normalised) payload.totp_secret = normalised;
    else delete payload.totp_secret;
  }

  return payload;
}
