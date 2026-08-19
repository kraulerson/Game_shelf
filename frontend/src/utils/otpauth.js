const ISSUER = 'Gameshelf';

/**
 * Build an otpauth:// URI for an authenticator app to scan.
 *
 * Built here, in the browser, from the secret the operator just typed — the
 * server deliberately has no endpoint that reads a stored TOTP secret back out.
 * Parameters match what the server previously emitted (SHA1/6/30) so an entry
 * enrolled before this change and one enrolled after are identical.
 */
export function buildOtpAuthUri(launcherId, username, secret) {
  if (!secret) return '';

  const label = encodeURIComponent(`${ISSUER}:${launcherId}:${username || launcherId}`);

  const params = new URLSearchParams({
    secret,
    issuer: ISSUER,
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  });

  return `otpauth://totp/${label}?${params.toString()}`;
}
