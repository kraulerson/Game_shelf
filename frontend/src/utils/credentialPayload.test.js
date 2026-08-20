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

  it('asks the server to REMOVE the secret when the user explicitly turned it off', () => {
    // The server merges, so omitting the field means "unchanged". Removal has to be
    // stated explicitly or unticking the box would silently do nothing — and it is
    // said with a verb, because the server no longer reads any VALUE as destructive.
    const payload = buildCredentialPayload({
      username: 'karl',
      totp_secret: 'JBSWY3DPEHPK3PXP',
      totpEnabled: false,
    });

    expect(payload.remove_totp_secret).toBe(true);
    expect('totp_secret' in payload).toBe(false);
  });

  it('still asks for a removal when the box is off and the field is empty', () => {
    const payload = buildCredentialPayload({ username: 'karl', totpEnabled: false });

    expect(payload.remove_totp_secret).toBe(true);
    expect('totp_secret' in payload).toBe(false);
  });

  it('never sends an empty totp_secret under any form state', () => {
    // The one property worth stating on its own: whatever the user leaves in the box,
    // the request must not carry an empty value for it. This is what makes the
    // client's behaviour independent of how the server chooses to read one.
    for (const creds of [
      { totp_secret: '', totpEnabled: true },
      { totp_secret: '', totpEnabled: false },
      { totp_secret: '  ', totpEnabled: true },
      { totp_secret: '==', totpEnabled: false },
      { totp_secret: '' },
    ]) {
      const payload = buildCredentialPayload(creds);
      expect(payload.totp_secret).not.toBe('');
    }
  });

  it('does not ask for a removal when the box is ticked', () => {
    const payload = buildCredentialPayload({
      username: 'karl',
      totp_secret: 'JBSWY3DPEHPK3PXP',
      totpEnabled: true,
    });

    expect('remove_totp_secret' in payload).toBe(false);
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
      // totp_secret and totpEnabled both absent — exactly what a reloaded form holds
    });

    expect('totp_secret' in payload).toBe(false);
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

  it('treats a whitespace-only secret as nothing entered, not as a request to clear', () => {
    // The normaliser strips whitespace, so '   ' became '' — and the server now reads
    // an explicit '' as a deliberate clear. A stray space in the field would therefore
    // destroy a stored secret the UI can never re-supply, returning 200 and "Saved".
    const payload = buildCredentialPayload({
      username: 'karl',
      password: 'p',
      totp_secret: '   ',
      totpEnabled: true,
    });

    expect('totp_secret' in payload).toBe(false);
  });

  it('treats a padding-only secret the same way', () => {
    const payload = buildCredentialPayload({
      username: 'karl',
      totp_secret: '====',
      totpEnabled: true,
    });

    expect('totp_secret' in payload).toBe(false);
  });

});
