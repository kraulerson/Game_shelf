import { describe, it, expect } from 'vitest';
import { buildCredentialPayload } from './credentialPayload';

describe('buildCredentialPayload', () => {
  it('drops UI-only state so it never reaches the server', () => {
    const payload = buildCredentialPayload({
      username: 'karl',
      password: 'hunter2',
      qrUri: 'otpauth://totp/x?secret=JBSWY3DPEHPK3PXP',
      qrError: '',
      saved: true,
      error: '',
      testing: false,
      testResult: { success: true },
      totpEnabled: true,
    });

    expect(payload).toEqual({ username: 'karl', password: 'hunter2' });
  });

  it('keeps the TOTP secret when the checkbox is ticked', () => {
    const payload = buildCredentialPayload({
      username: 'karl',
      totp_secret: 'JBSWY3DPEHPK3PXP',
      totpEnabled: true,
    });

    expect(payload.totp_secret).toBe('JBSWY3DPEHPK3PXP');
  });

  it('drops the TOTP secret only when the user explicitly turned it off', () => {
    const payload = buildCredentialPayload({
      username: 'karl',
      totp_secret: 'JBSWY3DPEHPK3PXP',
      totpEnabled: false,
    });

    expect(payload.totp_secret).toBeUndefined();
  });

  it('never sends a secret it was not given', () => {
    const payload = buildCredentialPayload({ username: 'karl', totpEnabled: false });

    expect('totp_secret' in payload).toBe(false);
  });

  it('does NOT drop a secret merely because the page was reloaded', () => {
    // After a reload the form state is empty, so totpEnabled is undefined — which is
    // not the same as the user unticking the box. Treating the two alike deleted a
    // stored TOTP secret whenever someone reopened Setup to fix an unrelated typo:
    // the route replaces credentials_json wholesale, so the secret was gone with no
    // warning while the UI said "Saved".
    const payload = buildCredentialPayload({
      username: 'karl',
      password: 'corrected',
      totp_secret: 'JBSWY3DPEHPK3PXP',
      // totpEnabled deliberately absent
    });

    expect(payload.totp_secret).toBe('JBSWY3DPEHPK3PXP');
  });

  it('normalises the TOTP secret so the stored value matches the QR', () => {
    // The QR builder strips whitespace, uppercases and drops padding. Storing the raw
    // string meant the server held characters the QR did not encode.
    const payload = buildCredentialPayload({
      totp_secret: ' jbsw y3dp\tehpk 3pxp== ',
      totpEnabled: true,
    });

    expect(payload.totp_secret).toBe('JBSWY3DPEHPK3PXP');
  });
});
