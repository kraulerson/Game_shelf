class BaseLauncher {
  constructor(launcherId, db) {
    this.launcherId = launcherId;
    this.db = db;
  }

  async authenticate(credentials) {
    throw new Error(`authenticate() not implemented for ${this.launcherId}`);
  }

  async fetchOwnedGames(session) {
    throw new Error(`fetchOwnedGames() not implemented for ${this.launcherId}`);
  }

  async refreshIfNeeded(credentials) {
    return this.authenticate(credentials);
  }
}

module.exports = BaseLauncher;
