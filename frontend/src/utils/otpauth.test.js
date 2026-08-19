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

  it('returns empty string when there is no secret to encode', () => {
    expect(buildOtpAuthUri('ubisoft', 'karl', '')).toBe('');
    expect(buildOtpAuthUri('ubisoft', 'karl', null)).toBe('');
    expect(buildOtpAuthUri('ubisoft', 'karl', undefined)).toBe('');
  });
});
