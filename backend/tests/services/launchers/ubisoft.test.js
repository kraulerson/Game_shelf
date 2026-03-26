const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('UbisoftLauncher', () => {
  it('refreshIfNeeded() should login with Basic Auth when no ticket exists', async () => {
    const axios = require('axios');
    const originalPost = axios.post;

    let capturedHeaders = null;
    axios.post = async (url, body, opts) => {
      capturedHeaders = opts?.headers;
      return {
        data: {
          ticket: 'ubi_ticket_123',
          sessionId: 'sess_123',
          rememberMeTicket: 'rm_ticket_123',
          userId: 'user_123',
          expiration: '2099-01-01T00:00:00.000Z',
        },
      };
    };

    try {
      delete require.cache[require.resolve('../../../src/services/launchers/ubisoft')];
      const UbisoftLauncher = require('../../../src/services/launchers/ubisoft');
      const launcher = new UbisoftLauncher('ubisoft', {});

      const result = await launcher.refreshIfNeeded({
        username: 'user@example.com',
        password: 'mypass',
      });

      // Verify Basic auth header
      assert.ok(capturedHeaders.Authorization.startsWith('Basic '));
      const decoded = Buffer.from(capturedHeaders.Authorization.split(' ')[1], 'base64').toString();
      assert.equal(decoded, 'user@example.com:mypass');

      // Verify session returned
      assert.equal(result.session.ticket, 'ubi_ticket_123');
      assert.equal(result.session.sessionId, 'sess_123');

      // Verify updated credentials include ticket + rememberMeTicket
      assert.equal(result.updatedCredentials.ticket, 'ubi_ticket_123');
      assert.equal(result.updatedCredentials.rememberMeTicket, 'rm_ticket_123');
      assert.equal(result.updatedCredentials.username, 'user@example.com');
      assert.equal(result.updatedCredentials.password, 'mypass');
    } finally {
      axios.post = originalPost;
    }
  });

  it('refreshIfNeeded() should throw OTP_REQUIRED when 2FA is triggered', async () => {
    const axios = require('axios');
    const originalPost = axios.post;

    axios.post = async () => ({
      data: {
        twoFactorAuthenticationTicket: '2fa_ticket_abc',
        maskedPhone: '***1234',
      },
    });

    try {
      delete require.cache[require.resolve('../../../src/services/launchers/ubisoft')];
      const UbisoftLauncher = require('../../../src/services/launchers/ubisoft');
      const launcher = new UbisoftLauncher('ubisoft', {});

      await assert.rejects(
        () => launcher.refreshIfNeeded({
          username: 'user@example.com',
          password: 'mypass',
        }),
        (err) => {
          assert.ok(err.message.startsWith('OTP_REQUIRED:'));
          return true;
        }
      );
    } finally {
      axios.post = originalPost;
    }
  });

  it('refreshIfNeeded() should complete login with OTP code after 2FA', async () => {
    const axios = require('axios');
    const originalPost = axios.post;

    let callCount = 0;
    axios.post = async (url, body, opts) => {
      callCount++;
      if (callCount === 1) {
        return {
          data: {
            twoFactorAuthenticationTicket: '2fa_ticket_abc',
          },
        };
      }
      assert.ok(opts.headers['Ubi-2faCode'], 'Should include 2FA code header');
      assert.ok(opts.headers.Authorization.includes('2fa_ticket_abc'));
      return {
        data: {
          ticket: 'ubi_ticket_after_2fa',
          sessionId: 'sess_456',
          rememberMeTicket: 'rm_ticket_456',
          userId: 'user_123',
          expiration: '2099-01-01T00:00:00.000Z',
        },
      };
    };

    try {
      delete require.cache[require.resolve('../../../src/services/launchers/ubisoft')];
      const UbisoftLauncher = require('../../../src/services/launchers/ubisoft');
      const launcher = new UbisoftLauncher('ubisoft', {});

      const result = await launcher.refreshIfNeeded({
        username: 'user@example.com',
        password: 'mypass',
        otp_code: '123456',
      });

      assert.equal(result.session.ticket, 'ubi_ticket_after_2fa');
      assert.equal(result.updatedCredentials.ticket, 'ubi_ticket_after_2fa');
      assert.equal(callCount, 2, 'Should make two requests (login + 2FA)');
    } finally {
      axios.post = originalPost;
    }
  });

  it('refreshIfNeeded() should skip login when ticket is not expired', async () => {
    delete require.cache[require.resolve('../../../src/services/launchers/ubisoft')];
    const UbisoftLauncher = require('../../../src/services/launchers/ubisoft');
    const launcher = new UbisoftLauncher('ubisoft', {});

    const result = await launcher.refreshIfNeeded({
      username: 'user@example.com',
      password: 'mypass',
      ticket: 'valid_ticket',
      sessionId: 'sess_123',
      rememberMeTicket: 'rm_ticket',
      expiration: new Date(Date.now() + 3600000).toISOString(),
    });

    assert.equal(result.session.ticket, 'valid_ticket');
    assert.equal(result.updatedCredentials, null, 'Should not refresh when ticket is valid');
  });

  it('refreshIfNeeded() should use rememberMeTicket when ticket is expired', async () => {
    const axios = require('axios');
    const originalPost = axios.post;

    let capturedHeaders = null;
    axios.post = async (url, body, opts) => {
      capturedHeaders = opts?.headers;
      return {
        data: {
          ticket: 'new_ticket',
          sessionId: 'new_sess',
          rememberMeTicket: 'new_rm',
          userId: 'user_123',
          expiration: '2099-01-01T00:00:00.000Z',
        },
      };
    };

    try {
      delete require.cache[require.resolve('../../../src/services/launchers/ubisoft')];
      const UbisoftLauncher = require('../../../src/services/launchers/ubisoft');
      const launcher = new UbisoftLauncher('ubisoft', {});

      const result = await launcher.refreshIfNeeded({
        username: 'user@example.com',
        password: 'mypass',
        ticket: 'expired_ticket',
        sessionId: 'old_sess',
        rememberMeTicket: 'old_rm',
        expiration: new Date(Date.now() - 1000).toISOString(),
      });

      assert.ok(capturedHeaders.Authorization.startsWith('rm_v1 t='));
      assert.equal(result.session.ticket, 'new_ticket');
      assert.equal(result.updatedCredentials.rememberMeTicket, 'new_rm');
    } finally {
      axios.post = originalPost;
    }
  });
});
