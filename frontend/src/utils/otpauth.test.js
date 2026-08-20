import { describe, it, expect } from 'vitest';
import { buildOtpAuthUri } from './otpauth';

describe('buildOtpAuthUri', () => {
  it('builds a scannable otpauth URI from a secret the user just entered', () => {
    const uri = buildOtpAuthUri('ubisoft', 'karl', 'JBSWY3DPEHPK3PXP');

    expect(uri.startsWith('otpauth://totp/')).toBe(true);
    expect(uri).toContain('secret=JBSWY3DPEHPK3PXP');
    expect(uri).toContain('issuer=Gameshelf');
  });

  it('carries the same TOTP parameters the server used, so existing enrolments match', () => {
    const uri = buildOtpAuthUri('ubisoft', 'karl', 'JBSWY3DPEHPK3PXP');

    expect(uri).toContain('algorithm=SHA1');
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
  });

  it('labels the entry with issuer, launcher and username', () => {
    const uri = buildOtpAuthUri('ubisoft', 'karl', 'JBSWY3DPEHPK3PXP');
    const label = decodeURIComponent(uri.slice('otpauth://totp/'.length).split('?')[0]);

    expect(label).toBe('Gameshelf:ubisoft:karl');
  });

  it('escapes characters that would otherwise break the URI', () => {
    const uri = buildOtpAuthUri('ubisoft', 'a b&c?d', 'JBSWY3DPEHPK3PXP');

    const [labelPart, query] = uri.slice('otpauth://totp/'.length).split('?');
    expect(labelPart).not.toContain(' ');
    expect(labelPart).not.toContain('&');
    expect(labelPart).not.toContain('?');
    expect(decodeURIComponent(labelPart)).toBe('Gameshelf:ubisoft:a b&c?d');
    expect(query).toContain('secret=JBSWY3DPEHPK3PXP');
  });

  it('falls back to the launcher id when no username was entered', () => {
    const uri = buildOtpAuthUri('ubisoft', '', 'JBSWY3DPEHPK3PXP');
    const label = decodeURIComponent(uri.slice('otpauth://totp/'.length).split('?')[0]);

    expect(label).toBe('Gameshelf:ubisoft:ubisoft');
  });

  it('refuses rather than returning an unusable empty string when there is no secret', () => {
    // Returning '' put two owners on this case with different behaviour, and a caller
    // trusting the '' contract renders nothing — a button that silently does nothing.
    expect(() => buildOtpAuthUri('ubisoft', 'karl', '')).toThrow(/secret/i);
    expect(() => buildOtpAuthUri('ubisoft', 'karl', null)).toThrow(/secret/i);
    expect(() => buildOtpAuthUri('ubisoft', 'karl', undefined)).toThrow(/secret/i);
  });

  it('matches the label form the server previously emitted', () => {
    // Old server output, captured by running it:
    //   otpauth://totp/Gameshelf:ubisoft%3Akarl?issuer=Gameshelf&secret=...
    // The issuer separator is a literal colon; only the account part is escaped.
    // Encoding the whole label makes it Gameshelf%3Aubisoft%3Akarl, which is NOT
    // identical however much the comment claims it is.
    const uri = buildOtpAuthUri('ubisoft', 'karl', 'JBSWY3DPEHPK3PXP');

    expect(uri.startsWith('otpauth://totp/Gameshelf:')).toBe(true);
    expect(uri).toContain('Gameshelf:ubisoft%3Akarl');
  });

  it('refuses a secret that is not base32 instead of encoding it anyway', () => {
    // The Setup UI tells Steam users to paste their shared_secret, which is base64.
    // The old server path threw ("Invalid character found"), so no QR appeared. A
    // scannable QR built from a base64 secret enrols permanently-wrong codes, which
    // is worse than no QR at all.
    expect(() => buildOtpAuthUri('steam', 'k', 'abcd1234+/==')).toThrow(/base32/i);
    expect(() => buildOtpAuthUri('steam', 'k', 'not valid!')).toThrow(/base32/i);
  });

  it('normalises the secret the way the server library did', () => {
    // The deleted server path ran the secret through otpauth, which uppercases and
    // strips padding. Emitting it verbatim means a lowercase secret (how most sites
    // display them) or a padded one goes into the QR unnormalised — and the padding
    // gets percent-encoded as %3D, which scanners reject.
    expect(buildOtpAuthUri('ubisoft', 'karl', 'jbswy3dpehpk3pxp')).toContain(
      'secret=JBSWY3DPEHPK3PXP'
    );
    expect(buildOtpAuthUri('ubisoft', 'karl', 'JBSWY3DPEHPK3PX===')).toContain(
      'secret=JBSWY3DPEHPK3PX'
    );
    expect(buildOtpAuthUri('ubisoft', 'karl', 'JBSW Y3DP EHPK 3PXP')).toContain(
      'secret=JBSWY3DPEHPK3PXP'
    );
  });

});
