const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const BaseLauncher = require('../../../src/services/launchers/base');

describe('BaseLauncher', () => {
  it('should store launcherId and db in constructor', () => {
    const fakeDb = { prepare: () => {} };
    const launcher = new BaseLauncher('steam', fakeDb);
    assert.equal(launcher.launcherId, 'steam');
    assert.equal(launcher.db, fakeDb);
  });

  it('authenticate() should throw not implemented', async () => {
    const launcher = new BaseLauncher('test', {});
    await assert.rejects(() => launcher.authenticate({}), { message: /not implemented/i });
  });

  it('fetchOwnedGames() should throw not implemented', async () => {
    const launcher = new BaseLauncher('test', {});
    await assert.rejects(() => launcher.fetchOwnedGames(null), { message: /not implemented/i });
  });

  it('refreshIfNeeded() should call authenticate() by default', async () => {
    let authCalled = false;
    const launcher = new BaseLauncher('test', {});
    launcher.authenticate = async () => { authCalled = true; return 'session-token'; };
    const session = await launcher.refreshIfNeeded({ username: 'u', password: 'p' });
    assert.equal(authCalled, true);
    assert.equal(session, 'session-token');
  });
});
