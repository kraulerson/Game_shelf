const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('EpicLauncher', () => {
  it('authenticate() should use authorization_code grant type with code parameter', async () => {
    const axios = require('axios');
    const originalPost = axios.post;

    let capturedBody = null;
    let capturedHeaders = null;
    axios.post = async (url, body, opts) => {
      capturedBody = body;
      capturedHeaders = opts?.headers;
      return {
        data: {
          access_token: 'test_access',
          token_type: 'eg1',
          refresh_token: 'test_refresh',
          expires_at: '2099-01-01T00:00:00.000Z',
          refresh_expires_at: '2099-01-02T00:00:00.000Z',
          account_id: 'test_account_id',
        }
      };
    };

    try {
      const EpicLauncher = require('../../../src/services/launchers/epic');
      const launcher = new EpicLauncher('epic', {});
      await launcher.authenticate({ auth_code: 'test_auth_code' });

      // Parse the URL-encoded body
      const params = new URLSearchParams(capturedBody);

      // REGRESSION: must be authorization_code, not exchange_code
      assert.equal(params.get('grant_type'), 'authorization_code',
        'grant_type must be authorization_code (not exchange_code)');

      // REGRESSION: parameter must be named "code", not "exchange_code"
      assert.equal(params.get('code'), 'test_auth_code',
        'auth code parameter must be named "code" (not "exchange_code")');
      assert.equal(params.get('exchange_code'), null,
        'exchange_code parameter must not be present');

      // Verify Basic auth header is present
      assert.ok(capturedHeaders?.Authorization?.startsWith('Basic '),
        'Authorization header must use Basic auth');
    } finally {
      axios.post = originalPost;
    }
  });

  it('fetchOwnedGames() should use sandboxName for game titles', async () => {
    const axios = require('axios');
    const originalGet = axios.get;
    axios.get = async (url) => {
      if (url.includes('/playtime/')) {
        return { data: [] };
      }
      return {
        data: {
          records: [
            { appName: 'Peony', catalogItemId: 'abc123', sandboxName: 'The Escapists', namespace: 'ns1' },
            { appName: 'Hoki', catalogItemId: 'def456', namespace: 'ns2' },
          ],
          responseMetadata: {},
        }
      };
    };

    try {
      const EpicLauncher = require('../../../src/services/launchers/epic');
      const launcher = new EpicLauncher('epic', {});
      const games = await launcher.fetchOwnedGames({
        access_token: 'test', token_type: 'bearer', account_id: 'test123'
      });

      // REGRESSION: must use sandboxName for title, not appTitle/catalogItemTitle
      assert.equal(games[0].title, 'The Escapists',
        'Should use sandboxName as title when available');
      assert.equal(games[0].launcher_game_id, 'Peony');
      assert.equal(games[0].epic_namespace, 'ns1');
      assert.equal(games[0].epic_catalog_id, 'abc123');

      // Falls back to appName when sandboxName is missing
      assert.equal(games[1].title, 'Hoki',
        'Should fall back to appName when sandboxName is missing');
    } finally {
      axios.get = originalGet;
    }
  });

  it('fetchOwnedGames() should return ALL items (no namespace dedup)', async () => {
    const axios = require('axios');
    const originalGet = axios.get;
    axios.get = async (url) => {
      if (url.includes('/playtime/')) {
        return { data: [] };
      }
      return {
        data: {
          records: [
            { appName: 'Game1', namespace: 'ns-fortnite', sandboxName: 'Live', sandboxType: 'LIVE' },
            { appName: 'Game2', namespace: 'ns-fortnite', sandboxName: 'Live', sandboxType: 'LIVE' },
            { appName: 'Game3', namespace: 'ns-fortnite', sandboxName: 'Fortnite', sandboxType: 'PUBLIC' },
            { appName: 'Peony', namespace: 'ns-escapists', sandboxName: 'The Escapists', sandboxType: 'PUBLIC' },
          ],
          responseMetadata: {},
        }
      };
    };

    try {
      const EpicLauncher = require('../../../src/services/launchers/epic');
      const launcher = new EpicLauncher('epic', {});
      const games = await launcher.fetchOwnedGames({
        access_token: 'test', token_type: 'bearer', account_id: 'test123'
      });

      // Phase 12: return ALL items, DLC nesting handled post-sync
      assert.equal(games.length, 4, 'Should return all 4 items without dedup');
      assert.equal(games[2].sandbox_type, 'PUBLIC');
      assert.equal(games[0].sandbox_type, 'LIVE');
    } finally {
      axios.get = originalGet;
    }
  });
});
