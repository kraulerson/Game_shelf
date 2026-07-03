const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { makeCacheSnapshot } = require('../../src/services/cacheSnapshot');

function stubClient(pages) {
  let calls = 0;
  return {
    calls: () => calls,
    fetchAllGames: async () => { calls += 1; const games = pages(calls); if (games instanceof Error) throw games; return { games, meta: { total: games.length } }; },
  };
}

describe('cacheSnapshot', () => {
  it('builds a platform:app_id -> status map from the client', async () => {
    const client = stubClient(() => [{ platform: 'steam', app_id: '730', status: 'up_to_date' }]);
    const snap = makeCacheSnapshot({ client, ttlMs: 1000, now: () => 0 });
    const { map, stale } = await snap.get();
    assert.equal(stale, false);
    assert.equal(map.get('steam:730'), 'up_to_date');
  });

  it('a blocked game reports "blocked", overriding its underlying status', async () => {
    const client = stubClient(() => [
      { platform: 'epic', app_id: '60', status: 'failed', blocked: true },
      { platform: 'steam', app_id: '50', status: 'failed', blocked: false },
    ]);
    const snap = makeCacheSnapshot({ client, ttlMs: 1000, now: () => 0 });
    const { map } = await snap.get();
    assert.equal(map.get('epic:60'), 'blocked'); // blocked overrides 'failed'
    assert.equal(map.get('steam:50'), 'failed'); // not blocked -> real status
  });

  it('serves cached within TTL without refetching', async () => {
    let t = 0;
    const client = stubClient(() => [{ platform: 'steam', app_id: '1', status: 'up_to_date' }]);
    const snap = makeCacheSnapshot({ client, ttlMs: 1000, now: () => t });
    await snap.get();
    t = 500;
    await snap.get();
    assert.equal(client.calls(), 1);
  });

  it('refetches after the TTL expires', async () => {
    let t = 0;
    const client = stubClient(() => [{ platform: 'steam', app_id: '1', status: 'up_to_date' }]);
    const snap = makeCacheSnapshot({ client, ttlMs: 1000, now: () => t });
    await snap.get();
    t = 1500;
    await snap.get();
    assert.equal(client.calls(), 2);
  });

  it('refetches exactly at the TTL boundary (strict <)', async () => {
    let t = 0;
    const client = stubClient(() => [{ platform: 'steam', app_id: '1', status: 'up_to_date' }]);
    const snap = makeCacheSnapshot({ client, ttlMs: 1000, now: () => t });
    await snap.get();
    t = 1000; // delta === ttlMs is NOT fresh
    await snap.get();
    assert.equal(client.calls(), 2);
  });

  it('coalesces concurrent refreshes into a single fetch', async () => {
    const client = stubClient(() => [{ platform: 'steam', app_id: '1', status: 'up_to_date' }]);
    const snap = makeCacheSnapshot({ client, ttlMs: 1000, now: () => 0 });
    const [a, b] = await Promise.all([snap.get(), snap.get()]);
    assert.equal(client.calls(), 1);
    assert.equal(a.map.get('steam:1'), 'up_to_date');
    assert.equal(b.map.get('steam:1'), 'up_to_date');
  });

  it('returns last-good map with stale=true when the client throws', async () => {
    let t = 0, fail = false;
    const client = stubClient(() => (fail ? new Error('offline') : [{ platform: 'steam', app_id: '1', status: 'up_to_date' }]));
    const snap = makeCacheSnapshot({ client, ttlMs: 1000, now: () => t });
    await snap.get();
    t = 2000; fail = true;
    const { map, stale } = await snap.get();
    assert.equal(stale, true);
    assert.equal(map.get('steam:1'), 'up_to_date');
  });

  it('returns {map:null, stale:true} when the client throws and there is no prior snapshot', async () => {
    const client = stubClient(() => new Error('offline'));
    const snap = makeCacheSnapshot({ client, ttlMs: 1000, now: () => 0 });
    const { map, stale } = await snap.get();
    assert.equal(map, null);
    assert.equal(stale, true);
  });
});
