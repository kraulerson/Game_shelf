const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { makeManualDownloadsSnapshot } = require('../../src/services/manualCoverageSnapshot');

function stubClient(seq) {
  let i = 0;
  return {
    calls: () => i,
    callOrchestrator: async () => {
      const r = seq[Math.min(i, seq.length - 1)];
      i++;
      if (r instanceof Error) throw r;
      return r;
    },
  };
}

describe('manualCoverageSnapshot', () => {
  it('fetches, caches within TTL, refreshes after TTL', async () => {
    let t = 1000;
    const client = stubClient([
      { status: 200, data: { launcher: 'GOG', present: true, entries: ['a', 'b'] } },
      { status: 200, data: { launcher: 'GOG', present: true, entries: ['a', 'b', 'c'] } },
    ]);
    const snap = makeManualDownloadsSnapshot({ client, ttlMs: 60000, now: () => t });
    const r1 = await snap.get('GOG');
    assert.deepEqual(r1.entries, ['a', 'b']);
    t += 1000; // within TTL
    await snap.get('GOG');
    assert.equal(client.calls(), 1); // still cached
    t += 60000; // past TTL
    const r3 = await snap.get('GOG');
    assert.deepEqual(r3.entries, ['a', 'b', 'c']);
  });

  it('serves last-good on error, and empty when never fetched', async () => {
    let t = 0;
    const good = { status: 200, data: { present: true, entries: ['x'] } };
    const client = stubClient([good, new Error('orchestrator offline')]);
    const snap = makeManualDownloadsSnapshot({ client, ttlMs: 10, now: () => t });
    await snap.get('GOG');
    t += 100;
    const r = await snap.get('GOG');
    assert.deepEqual(r.entries, ['x']);
    assert.equal(r.stale, true);

    const empty = makeManualDownloadsSnapshot({ client: stubClient([new Error('down')]), ttlMs: 10, now: () => 0 });
    const e = await empty.get('GOG');
    assert.deepEqual(e.entries, []);
    assert.equal(e.present, false);
    assert.equal(e.stale, true);
  });
});
