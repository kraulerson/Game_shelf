const BaseLauncher = require('./base');

/**
 * Battle.net integration — STUB
 *
 * TODO: Blizzard has no public game library API. The recommended path forward
 * is Playwright-based headless browser automation to log into Battle.net and
 * scrape the games section.
 *
 * Expected credential shape: { username: string, password: string, totp_secret?: string }
 */
class BattlenetLauncher extends BaseLauncher {
  async authenticate(credentials) {
    return null;
  }

  async refreshIfNeeded(credentials) {
    return null;
  }

  async fetchOwnedGames(session) {
    console.warn('[Battle.net] Battle.net integration not yet implemented. Returning empty game list.');
    return [];
  }
}

module.exports = BattlenetLauncher;
