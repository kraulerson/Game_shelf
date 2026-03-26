const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('EALauncher', () => {
  it('authenticate() should exchange auth code for tokens', async () => {
    const axios = require('axios');
    const originalPost = axios.post;

    let capturedUrl = null;
    let capturedBody = null;
    axios.post = async (url, body) => {
      capturedUrl = url;
      capturedBody = body;
      return {
        data: {
          access_token: 'ea_test_access',
          refresh_token: 'ea_test_refresh',
          expires_in: 3600,
        },
      };
    };

    try {
      delete require.cache[require.resolve('../../../src/services/launchers/ea')];
      const EALauncher = require('../../../src/services/launchers/ea');
      const launcher = new EALauncher('ea', {});
      const result = await launcher.authenticate({ auth_code: 'test_code_123' });

      // Verify token endpoint called
      assert.equal(capturedUrl, 'https://accounts.ea.com/connect/token');

      // Verify request body
      const params = new URLSearchParams(capturedBody);
      assert.equal(params.get('grant_type'), 'authorization_code');
      assert.equal(params.get('code'), 'test_code_123');
      assert.equal(params.get('client_id'), 'JUNO_PC_CLIENT');

      // Verify returned credentials shape
      assert.equal(result.access_token, 'ea_test_access');
      assert.equal(result.refresh_token, 'ea_test_refresh');
      assert.ok(result.expires_at, 'Should have expires_at timestamp');
    } finally {
      axios.post = originalPost;
    }
  });

  it('refreshIfNeeded() should skip refresh when token is not expired', async () => {
    delete require.cache[require.resolve('../../../src/services/launchers/ea')];
    const EALauncher = require('../../../src/services/launchers/ea');
    const launcher = new EALauncher('ea', {});

    const result = await launcher.refreshIfNeeded({
      access_token: 'valid_token',
      refresh_token: 'refresh_token',
      expires_at: new Date(Date.now() + 3600000).toISOString(),
    });

    assert.equal(result.session, 'valid_token');
    assert.equal(result.updatedCredentials, null, 'Should not refresh when token is valid');
  });

  it('refreshIfNeeded() should refresh when token is expired', async () => {
    const axios = require('axios');
    const originalPost = axios.post;

    axios.post = async () => ({
      data: {
        access_token: 'new_access',
        refresh_token: 'new_refresh',
        expires_in: 3600,
      },
    });

    try {
      delete require.cache[require.resolve('../../../src/services/launchers/ea')];
      const EALauncher = require('../../../src/services/launchers/ea');
      const launcher = new EALauncher('ea', {});

      const result = await launcher.refreshIfNeeded({
        access_token: 'expired_token',
        refresh_token: 'old_refresh',
        expires_at: new Date(Date.now() - 1000).toISOString(),
      });

      assert.equal(result.session, 'new_access');
      assert.equal(result.updatedCredentials.access_token, 'new_access');
      assert.equal(result.updatedCredentials.refresh_token, 'new_refresh');
      assert.ok(result.updatedCredentials.expires_at);
    } finally {
      axios.post = originalPost;
    }
  });
});
