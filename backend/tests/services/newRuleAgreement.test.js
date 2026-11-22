const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { isNewNotCached } = require('../../src/services/cacheRules');

// The 2026-09-10 lesson: the filter must follow the badge. The frontend rule
// (badge) and the backend twin (filter snapshot) must never drift apart.
const TABLE = [
  ['unknown', false, true], ['not_downloaded', false, true],
  ['unknown', false, false], ['not_downloaded', false, false],
  ['unknown', true, true], ['not_downloaded', true, true],
  ['up_to_date', false, true], ['pending_update', false, true],
  ['validation_failed', false, true], ['failed', false, true],
  ['not_downloaded', false, undefined], ['unknown', false, 'true'],
];

describe('New - Not Cached rule: frontend and backend agree', () => {
  it('gives identical results for 12 combinations', async () => {
    const fe = await import(pathToFileURL(path.resolve(__dirname, '../../../frontend/src/utils/cacheBadge.js')).href);
    assert.equal(TABLE.length, 12);
    for (const [status, blocked, isNew] of TABLE) {
      assert.equal(
        isNewNotCached({ status, blocked, isNew }),
        fe.isNewNotCached({ status, blocked, isNew }),
        `${status}/${blocked}/${isNew}`,
      );
    }
  });
});
