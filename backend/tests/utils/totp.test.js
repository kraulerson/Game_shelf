const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

describe('TOTP utility', () => {
  let totp;

  before(() => {
    process.env.GAMESHELF_ENCRYPTION_KEY = 'a]V3$k9Lm!pQ2rZ&wX8yB#dF5gH7jN0s';
    totp = require('../../src/utils/totp');
  });

  describe('generateTOTPCode', () => {
    it('should return a 6-digit string', () => {
      const secret = 'JBSWY3DPEHPK3PXP';
      const code = totp.generateTOTPCode(secret);
      assert.match(code, /^\d{6}$/, 'Should be exactly 6 digits');
    });

    it('should return consistent codes for same secret within same time window', () => {
      const secret = 'JBSWY3DPEHPK3PXP';
      const code1 = totp.generateTOTPCode(secret);
      const code2 = totp.generateTOTPCode(secret);
      assert.equal(code1, code2);
    });
  });

  describe('generateQRSetupData', () => {
    it('should return a valid otpauth URI', () => {
      const uri = totp.generateQRSetupData('steam', 'testuser', 'JBSWY3DPEHPK3PXP');
      assert.ok(uri.startsWith('otpauth://totp/'), 'Should start with otpauth://totp/');
      assert.ok(uri.includes('Gameshelf'), 'Should include issuer');
      assert.ok(uri.includes('secret='), 'Should include secret parameter');
    });

    it('should include launcher and username in the label', () => {
      const uri = totp.generateQRSetupData('epic', 'myuser', 'JBSWY3DPEHPK3PXP');
      assert.ok(uri.includes('epic'), 'Should include launcher id');
      assert.ok(uri.includes('myuser'), 'Should include username');
    });
  });

  describe('generateSteamCode', () => {
    it('should return a 5-character alphanumeric code', () => {
      const sharedSecret = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
      const code = totp.generateSteamCode(sharedSecret);
      assert.equal(typeof code, 'string');
      assert.equal(code.length, 5, 'Steam codes are 5 characters');
      assert.match(code, /^[23456789BCDFGHJKMNPQRTVWXY]{5}$/);
    });
  });
});
