const ISSUER = 'Gameshelf';

// RFC 4648 base32: A–Z and 2–7, optionally padded with '='. Authenticator apps
// decode the secret as base32; anything else imports cleanly and then generates
// permanently wrong codes.
const BASE32 = /^[A-Z2-7]+=*$/i;

/**
 * Build an otpauth:// URI for an authenticator app to scan.
 *
 * Built here, in the browser, from the secret the operator just typed — the
 * server deliberately has no endpoint that reads a stored TOTP secret back out.
 *
 * Returns '' when there is no secret yet. Throws when the secret is present but
 * unusable: the Setup form tells Steam users to paste their `shared_secret`, which
 * is base64, and the server path this replaced rejected that outright. A scannable
 * QR built from a non-base32 secret is worse than no QR, because the failure only
 * shows up later as codes that never work.
 */
export function buildOtpAuthUri(launcherId, username, secret) {
  if (!secret) return '';

  if (!BASE32.test(secret)) {
    throw new Error(
      'That TOTP secret is not valid base32. Authenticator secrets use only the ' +
      'letters A–Z and digits 2–7. Steam shared_secret values are base64 and will ' +
      'not work here.'
    );
  }

  // Matches the form the server emitted: a literal colon after the issuer, with only
  // the account portion escaped (`Gameshelf:ubisoft%3Akarl`). Escaping the whole
  // label instead would give `Gameshelf%3Aubisoft%3Akarl` — accepted by most apps,
  // but not the same string, so a re-enrolment would not replace the old entry.
  const account = encodeURIComponent(`${launcherId}:${username || launcherId}`);

  const params = new URLSearchParams({
    secret,
    issuer: ISSUER,
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  });

  return `otpauth://totp/${ISSUER}:${account}?${params.toString()}`;
}
