const BaseLauncher = require('./base');

/**
 * Epic Games integration — STUB
 *
 * TODO: Implement using https://github.com/MixV2/EpicResearch as reference.
 * Epic uses OAuth2 with launcher client credentials.
 *
 * Expected credential shape: { email: string, password: string, totp_secret?: string }
 */
class EpicLauncher extends BaseLauncher {
  async authenticate(credentials) {
    return null;
  }

  async refreshIfNeeded(credentials) {
    return null;
  }

  async fetchOwnedGames(session) {
    console.warn('[Epic Games] Epic Games integration not yet implemented. Returning empty game list.');
    return [];
  }
}

module.exports = EpicLauncher;
