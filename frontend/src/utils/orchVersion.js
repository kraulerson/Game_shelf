// Versions of the lancache orchestrator this build of Game_shelf has been
// verified against. Skew detection is ADVISORY and fail-open: an unknown or
// missing version never raises a warning (we'd rather stay quiet than cry wolf).
export const SUPPORTED_ORCH_VERSIONS = ['0.1.0'];

export function isVersionSkewed(version) {
  if (typeof version !== 'string' || version === '') return false; // fail open
  return !SUPPORTED_ORCH_VERSIONS.includes(version);
}
