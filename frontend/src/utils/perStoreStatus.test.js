import { describe, it, expect } from 'vitest';
import {
  storeStatusList,
  storesDisagree,
  fitStoreItems,
  layoutStoreLine,
  STORE_SYMBOLS,
  ITEM_SEPARATOR,
  LINE_BUDGET,
} from './perStoreStatus';

// A stand-in for useCacheStatus().statusFor — keyed `platform:app_id`.
function makeStatusFor(entries) {
  const map = new Map(Object.entries(entries));
  return (platform, appId) => map.get(`${platform}:${appId}`);
}

const BIOSHOCK = {
  id: 1,
  title: 'BioShock Infinite',
  launcher_name: 'steam',
  launcher_game_id: '8870',
  cache_launcher_name: 'steam',
  cache_launcher_game_id: '8870',
  platforms: [
    { launcher_name: 'epic', launcher_display_name: 'Epic Games', launcher_game_id: 'epic-bio' },
    { launcher_name: 'steam', launcher_display_name: 'Steam', launcher_game_id: '8870' },
    { launcher_name: 'gog', launcher_display_name: 'GOG', launcher_game_id: 'gog-bio', download_status: 'not_downloaded' },
  ],
};

const bioshockStatus = makeStatusFor({
  'steam:8870': { status: 'up_to_date', blocked: false },
  'epic:epic-bio': { status: 'not_downloaded', blocked: true },
});

describe('storeStatusList', () => {
  it('resolves each store independently from its own launcher_game_id', () => {
    const list = storeStatusList(BIOSHOCK, { statusFor: bioshockStatus });
    const byName = Object.fromEntries(list.map((s) => [s.launcherName, s]));
    expect(byName.steam.kind).toBe('cached');
    expect(byName.epic.kind).toBe('blocked');
    expect(byName.gog.kind).toBe('not_downloaded');
  });

  it('puts the primary (cache_launcher_name) store first regardless of API order', () => {
    const list = storeStatusList(BIOSHOCK, { statusFor: bioshockStatus });
    expect(list.map((s) => s.launcherName)).toEqual(['steam', 'epic', 'gog']);
  });

  it('gives every status a distinct shape symbol and a full text label', () => {
    const list = storeStatusList(BIOSHOCK, { statusFor: bioshockStatus });
    const byName = Object.fromEntries(list.map((s) => [s.launcherName, s]));
    expect(byName.steam.symbol).toBe(STORE_SYMBOLS.cached);
    expect(byName.steam.label).toBe('Cached');
    expect(byName.epic.symbol).toBe(STORE_SYMBOLS.blocked);
    expect(byName.epic.label).toBe('Blocked');
    expect(byName.gog.symbol).toBe(STORE_SYMBOLS.not_downloaded);
    expect(byName.gog.label).toBe('Not downloaded');
    // Never colour alone: shape + label always travel together.
    for (const s of list) {
      expect(s.symbol).toBeTruthy();
      expect(s.label).toBeTruthy();
      expect(s.text).toContain(s.label);
    }
  });

  it('uses a distinct symbol for every status kind', () => {
    const symbols = Object.values(STORE_SYMBOLS);
    expect(new Set(symbols).size).toBe(symbols.length);
  });

  it('marks a manual store with an unknown download state as a neutral non-status', () => {
    const game = {
      launcher_name: 'gog',
      cache_launcher_name: 'gog',
      platforms: [{ launcher_name: 'gog', launcher_display_name: 'GOG', launcher_game_id: 'g1' }],
    };
    const [gog] = storeStatusList(game, { statusFor: () => undefined });
    expect(gog.kind).toBe('none');
    expect(gog.symbol).toBe(STORE_SYMBOLS.none);
    expect(gog.label).toBe('No status');
  });

  it('a tracked store the orchestrator has never seen is Unknown, not blank', () => {
    const game = {
      launcher_name: 'steam',
      cache_launcher_name: 'steam',
      platforms: [{ launcher_name: 'steam', launcher_display_name: 'Steam', launcher_game_id: '999' }],
    };
    const [steam] = storeStatusList(game, { statusFor: () => undefined });
    expect(steam.kind).toBe('unknown');
    expect(steam.label).toBe('Unknown');
  });

  it('offline collapses every tracked store to the offline marker', () => {
    const list = storeStatusList(BIOSHOCK, { statusFor: bioshockStatus, offline: true });
    expect(list.find((s) => s.launcherName === 'steam').kind).toBe('offline');
  });

  it('returns an empty list when the game has no platforms', () => {
    expect(storeStatusList({}, { statusFor: () => undefined })).toEqual([]);
  });
});

describe('storesDisagree', () => {
  it('is false for a single store (the 1935-game case)', () => {
    const list = storeStatusList(
      {
        launcher_name: 'steam',
        cache_launcher_name: 'steam',
        platforms: [{ launcher_name: 'steam', launcher_game_id: '730' }],
      },
      { statusFor: makeStatusFor({ 'steam:730': { status: 'up_to_date' } }) }
    );
    expect(storesDisagree(list)).toBe(false);
  });

  it('is false when every store says the same thing', () => {
    const list = storeStatusList(
      {
        launcher_name: 'steam',
        cache_launcher_name: 'steam',
        platforms: [
          { launcher_name: 'steam', launcher_game_id: '730' },
          { launcher_name: 'epic', launcher_game_id: 'e730' },
        ],
      },
      {
        statusFor: makeStatusFor({
          'steam:730': { status: 'up_to_date' },
          'epic:e730': { status: 'up_to_date' },
        }),
      }
    );
    expect(storesDisagree(list)).toBe(false);
  });

  it('is true when the stores differ (BioShock)', () => {
    expect(storesDisagree(storeStatusList(BIOSHOCK, { statusFor: bioshockStatus }))).toBe(true);
  });

  it('ignores stores that carry no applicable status at all', () => {
    // Steam cached + a manual store with no known download state is not a
    // disagreement — there is nothing to disagree with.
    const list = storeStatusList(
      {
        launcher_name: 'steam',
        cache_launcher_name: 'steam',
        platforms: [
          { launcher_name: 'steam', launcher_game_id: '730' },
          { launcher_name: 'humble', launcher_game_id: 'h1' },
        ],
      },
      { statusFor: makeStatusFor({ 'steam:730': { status: 'up_to_date' } }) }
    );
    expect(storesDisagree(list)).toBe(false);
  });
});

describe('fitStoreItems', () => {
  const items = (n) =>
    Array.from({ length: n }, (_, i) => ({ text: `Store${i} X Not downloaded` }));

  it('is deterministic — no measurement, same input same output', () => {
    expect(fitStoreItems(items(4))).toEqual(fitStoreItems(items(4)));
  });

  it('always shows at least one item even when it alone busts the budget', () => {
    const { shown, overflow } = fitStoreItems([{ text: 'x'.repeat(200) }, { text: 'y' }]);
    expect(shown).toHaveLength(1);
    expect(overflow).toBe(1);
  });

  it('never lets the rendered line exceed the budget once it has room to stop', () => {
    const { shown, overflow } = fitStoreItems(items(4));
    const rendered = shown.map((i) => i.text).join(' · ') + (overflow ? ` · +${overflow}` : '');
    expect(rendered.length).toBeLessThanOrEqual(LINE_BUDGET);
    expect(overflow).toBeGreaterThan(0);
  });

  it('reports no overflow when everything fits', () => {
    const { shown, overflow } = fitStoreItems([{ text: 'Steam ✓' }, { text: 'Epic ⊘' }]);
    expect(shown).toHaveLength(2);
    expect(overflow).toBe(0);
  });
});

describe('layoutStoreLine', () => {
  const rendered = ({ shown, overflow }) =>
    shown.map((i) => i.text).join(ITEM_SEPARATOR) + (overflow ? `${ITEM_SEPARATOR}+${overflow}` : '');

  const twoStores = storeStatusList(
    {
      launcher_name: 'steam',
      cache_launcher_name: 'steam',
      platforms: [
        { launcher_name: 'steam', launcher_display_name: 'Steam', launcher_game_id: '1' },
        { launcher_name: 'epic', launcher_display_name: 'Epic', launcher_game_id: '2' },
      ],
    },
    { statusFor: makeStatusFor({ 'steam:1': { status: 'up_to_date' }, 'epic:2': { blocked: true } }) }
  );

  const fourStores = storeStatusList(
    {
      launcher_name: 'steam',
      cache_launcher_name: 'steam',
      platforms: [
        { launcher_name: 'steam', launcher_display_name: 'Steam', launcher_game_id: '1' },
        { launcher_name: 'epic', launcher_display_name: 'Epic', launcher_game_id: '2' },
        { launcher_name: 'gog', launcher_display_name: 'GOG', launcher_game_id: '3', download_status: 'downloaded' },
        { launcher_name: 'amazon', launcher_display_name: 'Amazon', launcher_game_id: '4', download_status: 'not_downloaded' },
      ],
    },
    { statusFor: makeStatusFor({ 'steam:1': { status: 'up_to_date' }, 'epic:2': { blocked: true } }) }
  );

  it('keeps the full wording when two stores fit', () => {
    const out = layoutStoreLine(twoStores);
    expect(out.compact).toBe(false);
    expect(out.overflow).toBe(0);
    expect(rendered(out)).toBe('Steam ✓ Cached · Epic ⊘ Blocked');
  });

  it('drops to symbol-only before it drops a store', () => {
    const three = twoStores.concat(fourStores.filter((s) => s.launcherName === 'gog'));
    const out = layoutStoreLine(three);
    expect(out.compact).toBe(true);
    expect(out.overflow).toBe(0);
    expect(out.shown.map((s) => s.launcherName)).toEqual(['steam', 'epic', 'gog']);
  });

  it('four stores overflow, and the line still fits the budget', () => {
    const out = layoutStoreLine(fourStores);
    expect(out.overflow).toBeGreaterThan(0);
    expect(out.shown.length).toBeGreaterThan(0);
    expect(rendered(out).length).toBeLessThanOrEqual(LINE_BUDGET);
    expect(out.shown[0].launcherName).toBe('steam');
  });
});
