const BaseLauncher = require('./base');

/**
 * Ubisoft Connect integration — STUB
 *
 * TODO: Implement using https://github.com/Hachi1/ubisoft-api-node as reference.
 * Ubisoft Connect has an unofficial API used by community tools.
 *
 * Expected credential shape: { email: string, password: string, totp_secret?: string }
 */
class UbisoftLauncher extends BaseLauncher {
  async authenticate(credentials) {
    return null;
  }

  async refreshIfNeeded(credentials) {
    return null;
  }

  async fetchOwnedGames(session) {
    console.warn('[Ubisoft Connect] Ubisoft Connect integration not yet implemented. Returning empty game list.');
    return [];
  }
}

module.exports = UbisoftLauncher;
