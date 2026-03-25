const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('GOG URL parsing', () => {
  // REGRESSION: GOG may return relative redirect URLs (e.g., /on_login_success?code=XXX)
  // which caused "Invalid URL" when parsed with new URL() without a base.

  it('should parse OAuth code from relative redirect URL', () => {
    const relativeUrl = '/on_login_success?origin=client&code=ABC123';
    const code = new URL(relativeUrl, 'https://auth.gog.com').searchParams.get('code');
    assert.equal(code, 'ABC123');
  });

  it('should parse OAuth code from absolute redirect URL', () => {
    const absoluteUrl = 'https://embed.gog.com/on_login_success?origin=client&code=DEF456';
    const code = new URL(absoluteUrl, 'https://auth.gog.com').searchParams.get('code');
    assert.equal(code, 'DEF456');
  });

  it('should throw without base URL on relative path (pre-fix behavior)', () => {
    const relativeUrl = '/on_login_success?origin=client&code=ABC123';
    assert.throws(() => new URL(relativeUrl), { code: 'ERR_INVALID_URL' });
  });
});
