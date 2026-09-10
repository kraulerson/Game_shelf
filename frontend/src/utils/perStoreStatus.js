// Per-store status for the library card (#31).
//
// A game owned on several stores used to show ONE badge — the highest-priority
// store's (resolveCacheLauncher). Filtering "Blocked" and seeing a card that
// reads "Cached" is correct but useless: the block is on Epic and the cache is
// on Steam. This module derives EACH owned store's own status so the card can
// say so, and decides — deterministically, without measuring anything — how much
// of that fits on one fixed-height line.
//
// Pure: no React, no DOM. Layers on top of cacheBadge.js rather than restating
// its status rules, so the per-store wording can never drift from the badge's.

import { cacheBadgeFor, launcherToPlatform, manualDownloadBadge } from './cacheBadge';

// A distinct SHAPE per status. Karl's standing rule: never colour alone — colour
// may reinforce, but every status must be readable in greyscale, so each kind
// gets its own glyph AND a full text label. The two manual-download states pair
// as square outline/solid (□/■); the lancache states use circles and arrows, so
// "not cached" (○) can never be mistaken for "not downloaded" (□).
export const STORE_SYMBOLS = {
  cached: '✓',
  update_ready: '↑',
  partial: '▲',
  not_cached: '○',
  blocked: '⊘',
  unknown: '?',
  downloaded: '■',
  not_downloaded: '□',
  offline: '☁',
  none: '–',
};

// cacheBadgeFor()'s icon name -> our status kind. Keyed off the icon (not the raw
// orchestrator status) so a change to the badge's status rules carries here too.
const LANCACHE_ICON_KIND = {
  CheckCircle: 'cached',
  ArrowUpCircle: 'update_ready',
  AlertTriangle: 'partial',
  Circle: 'not_cached',
  HelpCircle: 'unknown',
  Ban: 'blocked',
  Minus: 'none',
  CloudOff: 'offline',
};

const MANUAL_ICON_KIND = {
  CheckCircle: 'downloaded',
  Circle: 'not_downloaded',
};

// A store with nothing to say — a manual store whose download state is unknown.
// Rendered as a neutral marker that is clearly NOT a status, never as a blank.
const NONE = { kind: 'none', label: 'No status', tone: 'neutral' };

function storeStatus(platform, { statusFor, offline }) {
  const tracked = launcherToPlatform(platform.launcher_name);
  if (tracked) {
    const cache = statusFor(tracked, platform.launcher_game_id);
    const badge = cacheBadgeFor({
      status: cache?.status,
      blocked: cache?.blocked,
      tracked: true,
      offline,
      chunksCached: cache?.chunks_cached,
      chunksTotal: cache?.chunks_total,
    });
    return { kind: LANCACHE_ICON_KIND[badge.icon] || 'unknown', label: badge.label, tone: badge.tone };
  }
  const badge = manualDownloadBadge(platform.download_status);
  if (!badge) return NONE;
  return { kind: MANUAL_ICON_KIND[badge.icon] || 'none', label: badge.label, tone: badge.tone };
}

// The store whose status the primary CacheBadge shows (#223/#224), so the
// per-store line leads with the same store the badge would.
function primaryLauncher(game) {
  return game.cache_launcher_name || game.launcher_name || null;
}

/**
 * Every owned store's own status, primary store first.
 * @param {object} game a /api/games row (platforms[] carrying launcher_game_id)
 * @param {{statusFor: Function, offline?: boolean}} ctx useCacheStatus()
 * @returns {Array<{launcherName, displayName, kind, symbol, label, tone, text, accessibleText}>}
 */
export function storeStatusList(game, { statusFor, offline = false } = {}) {
  const platforms = Array.isArray(game?.platforms) ? game.platforms : [];
  const primary = primaryLauncher(game);
  const ordered = [
    ...platforms.filter((p) => p.launcher_name === primary),
    ...platforms.filter((p) => p.launcher_name !== primary),
  ];
  return ordered.map((p) => {
    const { kind, label, tone } = storeStatus(p, { statusFor, offline });
    const name = p.launcher_display_name || p.launcher_name;
    const symbol = STORE_SYMBOLS[kind];
    return {
      launcherName: p.launcher_name,
      displayName: name,
      kind,
      symbol,
      label,
      tone,
      // On-card wording (compact) and screen-reader wording (spelled out).
      text: `${name} ${symbol} ${label}`,
      accessibleText: `${name} — ${label}`,
    };
  });
}

/**
 * Do the owned stores actually say different things? Stores with no applicable
 * status ('none') are ignored — a Steam-cached game whose Humble download state
 * is simply unknown is not a disagreement, and must stay visually clean.
 */
export function storesDisagree(list = []) {
  const kinds = new Set(list.filter((s) => s.kind !== 'none').map((s) => s.kind));
  return kinds.size > 1;
}

export const ITEM_SEPARATOR = ' · ';
// Characters that fit on one line of the card's status section at text-[10px].
// A deterministic budget, NOT a runtime measurement: it gives the same answer in
// jsdom, in SSR and in the browser, and it cannot leave the section half-rendered.
export const LINE_BUDGET = 34;
// The status section's reserved height — the natural height of the small
// CacheBadge (text-xs + py-0.5 = 20px). Every card reserves it whether or not it
// has anything to show, so a row of cards is never ragged.
export const STATUS_SECTION_HEIGHT_CLASS = 'h-5';

/**
 * Fit per-store items onto one line: take them in order while the rendered line
 * (including the trailing "+N") stays inside the budget. Always shows at least
 * one item — a single over-long item is truncated by CSS rather than dropped.
 * @returns {{shown: Array, overflow: number}}
 */
export function fitStoreItems(items = [], budget = LINE_BUDGET) {
  const shown = [];
  let len = 0;
  for (let i = 0; i < items.length; i++) {
    const cost = (shown.length > 0 ? ITEM_SEPARATOR.length : 0) + items[i].text.length;
    const remaining = items.length - i - 1;
    const suffix = remaining > 0 ? ITEM_SEPARATOR.length + `+${remaining}`.length : 0;
    if (shown.length > 0 && len + cost + suffix > budget) break;
    shown.push(items[i]);
    len += cost;
  }
  return { shown, overflow: items.length - shown.length };
}

function lineLength(items, overflow) {
  const body = items.reduce((n, i, idx) => n + i.text.length + (idx ? ITEM_SEPARATOR.length : 0), 0);
  return overflow > 0 ? body + ITEM_SEPARATOR.length + `+${overflow}`.length : body;
}

/**
 * Lay the per-store items onto the single fixed-height line, degrading in a
 * fixed order so the card loses detail in the least useful place first:
 *   1. full wording  — "Steam ✓ Cached · Epic ⊘ Blocked"
 *   2. symbol only   — "Steam ✓ · Epic ⊘ · GOG □"  (wording moves to the title)
 *   3. drop the tail — "Steam ✓ · Epic ⊘ · GOG □ · +1"
 * A store is only ever dropped once BOTH stores' wording has already gone, so
 * the 3-store case (43 games) keeps every store visible. Entirely deterministic:
 * no DOM measurement, identical in jsdom, SSR and the browser.
 * @returns {{shown: Array, overflow: number, compact: boolean}}
 */
export function layoutStoreLine(stores = [], budget = LINE_BUDGET) {
  if (lineLength(stores, 0) <= budget) return { shown: stores, overflow: 0, compact: false };
  const compact = stores.map((s) => ({ ...s, text: `${s.displayName} ${s.symbol}` }));
  return { ...fitStoreItems(compact, budget), compact: true };
}
