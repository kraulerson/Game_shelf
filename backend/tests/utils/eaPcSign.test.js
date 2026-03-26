const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { generatePcSign, generateEaAuthUrl, fnv1aHash } = require('../../src/utils/eaPcSign');

describe('EA pc_sign', () => {
  it('fnv1aHash should produce consistent decimal string output', () => {
    const result = fnv1aHash('test');
    assert.equal(typeof result, 'string');
    assert.ok(/^\d+$/.test(result), 'Should be a decimal number string');
  });

  it('generatePcSign should produce payload.signature format', () => {
    const sign = generatePcSign();
    const parts = sign.split('.');
    assert.equal(parts.length, 2, 'Should have payload.signature format');

    // Decode payload and verify structure
    const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    assert.equal(payload.av, 'v1');
    assert.equal(payload.sv, 'v1');
    assert.ok(payload.mid, 'Should have mid');
    assert.ok(payload.ts, 'Should have timestamp');
    assert.equal(payload.bsn, 'SystemSerialNumber');
  });

  it('generatePcSign payload should have correct JSON spacing', () => {
    const sign = generatePcSign();
    const payloadStr = Buffer.from(sign.split('.')[0], 'base64url').toString();
    // Must have space after colon and comma
    assert.ok(payloadStr.includes(': '), 'Should have space after colons');
    assert.ok(payloadStr.includes(', '), 'Should have space after commas');
  });

  it('generateEaAuthUrl should include pc_sign parameter', () => {
    const url = generateEaAuthUrl();
    assert.ok(url.startsWith('https://accounts.ea.com/connect/auth?'));
    assert.ok(url.includes('pc_sign='), 'Should include pc_sign parameter');
    assert.ok(url.includes('client_id=JUNO_PC_CLIENT'));
    assert.ok(url.includes('response_type=code'));
  });
});
