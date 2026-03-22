const { TOTP } = require('otpauth');
const SteamTotp = require('steam-totp');

/**
 * Generate a standard 6-digit TOTP code from a base32-encoded secret.
 * Uses SHA-1 algorithm, 6 digits, 30-second period (RFC 6238 defaults).
 */
function generateTOTPCode(secret) {
  const instance = new TOTP({
    secret,
    digits: 6,
    period: 30,
    algorithm: 'SHA1',
  });
  return instance.generate();
}

/**
 * Generate an otpauth:// URI suitable for QR code rendering.
 * The user can scan this to verify their TOTP secret matches their authenticator app.
 */
function generateQRSetupData(launcherId, username, secret) {
  const instance = new TOTP({
    issuer: 'Gameshelf',
    label: `${launcherId}:${username}`,
    secret,
    digits: 6,
    period: 30,
    algorithm: 'SHA1',
  });
  return instance.toString();
}

/**
 * Generate a Steam Guard authentication code from a shared_secret.
 *
 * Steam uses a non-standard TOTP implementation:
 * - Secret is base64-encoded (not base32)
 * - Produces 5-character codes instead of 6-digit codes
 * - Uses a custom alphabet: 23456789BCDFGHJKMNPQRTVWXY
 * - Follows the Steam Guard Mobile Authenticator protocol
 *
 * The shared_secret must be obtained from an already-linked Steam Mobile
 * Authenticator or exported via Steam Desktop Authenticator.
 */
function generateSteamCode(sharedSecret) {
  return SteamTotp.generateAuthCode(sharedSecret);
}

module.exports = { generateTOTPCode, generateQRSetupData, generateSteamCode };
