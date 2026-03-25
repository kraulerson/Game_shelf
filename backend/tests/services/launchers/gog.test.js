const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('GOG Launcher', () => {
  it('refreshIfNeeded should throw clear error when no refresh_token exists', async () => {
    // REGRESSION: Old username/password credentials have no refresh_token.
    // refreshIfNeeded must throw a clear re-configure message, not a cryptic error.
    const GOGLauncher = require('../../../src/services/launchers/gog');
    const instance = new GOGLauncher('gog', null);

    await assert.rejects(
      () => instance.refreshIfNeeded({ username: 'old', password: 'creds' }),
      { message: /reconfigured|re-add|Setup/i }
    );
  });

  it('refreshIfNeeded should throw clear error when refresh token is expired', async () => {
    const axios = require('axios');
    const originalGet = axios.get;
    axios.get = async () => { throw new Error('invalid_grant'); };

    try {
      const GOGLauncher = require('../../../src/services/launchers/gog');
      const instance = new GOGLauncher('gog', null);

      await assert.rejects(
        () => instance.refreshIfNeeded({ refresh_token: 'expired_token' }),
        { message: /expired|re-add|Setup/i }
      );
    } finally {
      axios.get = originalGet;
    }
  });
});
