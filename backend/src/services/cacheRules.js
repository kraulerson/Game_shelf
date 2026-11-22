// Backend twin of frontend/src/utils/cacheBadge.js isNewNotCached. The library
// filter must follow the displayed badge (2026-09-10 rule); the agreement test
// in tests/services/newRuleAgreement.test.js keeps the two from drifting.
function isNewNotCached({ status, blocked, isNew } = {}) {
  return isNew === true && !blocked && (status === 'unknown' || status === 'not_downloaded');
}

module.exports = { isNewNotCached };
