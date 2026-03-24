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
});
