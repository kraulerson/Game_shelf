import { describe, it, expect } from 'vitest';
import { isVersionSkewed, SUPPORTED_ORCH_VERSIONS } from './orchVersion';

describe('isVersionSkewed', () => {
  it('a supported version is not skewed', () => {
    expect(isVersionSkewed(SUPPORTED_ORCH_VERSIONS[0])).toBe(false);
  });

  it('an unsupported version is skewed', () => {
    expect(isVersionSkewed('9.9.9')).toBe(true);
  });

  it('fails open when the version is absent (null/undefined/empty)', () => {
    expect(isVersionSkewed(null)).toBe(false);
    expect(isVersionSkewed(undefined)).toBe(false);
    expect(isVersionSkewed('')).toBe(false);
  });

  it('a non-string version fails open (advisory only, never crashes)', () => {
    expect(isVersionSkewed(123)).toBe(false);
    expect(isVersionSkewed({})).toBe(false);
  });
});
