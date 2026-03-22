const BaseLauncher = require('./base');

/**
 * Xbox / Microsoft integration — STUB
 *
 * TODO: Xbox uses Microsoft OAuth. Reference https://xbl.io as a community
 * API option for fetching Xbox game library data.
 *
 * Expected credential shape: { username: string, password: string }
 */
class XboxLauncher extends BaseLauncher {
  async authenticate(credentials) {
    return null;
  }

  async refreshIfNeeded(credentials) {
    return null;
  }

  async fetchOwnedGames(session) {
    console.warn('[Xbox] Xbox integration not yet implemented. Returning empty game list.');
    return [];
  }
}

module.exports = XboxLauncher;
