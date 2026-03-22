const BaseLauncher = require('./base');

/**
 * EA App integration — STUB
 *
 * TODO: EA App uses EA account OAuth. Implementation requires Playwright-based
 * headless browser login to automate the flow and scrape the game list from
 * https://www.ea.com/games/library
 *
 * Expected credential shape: { username: string, password: string, totp_secret?: string }
 */
class EALauncher extends BaseLauncher {
  async authenticate(credentials) {
    return null;
  }

  async refreshIfNeeded(credentials) {
    return null;
  }

  async fetchOwnedGames(session) {
    console.warn('[EA App] EA App integration not yet implemented. Returning empty game list.');
    return [];
  }
}

module.exports = EALauncher;
