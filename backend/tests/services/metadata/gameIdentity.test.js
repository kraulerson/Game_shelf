const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { canonicalBaseSlug, sameGameSlug, isSequelToken, isSequelPair } = require('../../../src/services/metadata/gameIdentity');

describe('gameIdentity.isSequelToken', () => {
  it('true for arabic and roman numerals', () => {
    for (const t of ['2', '3', '64', 'ii', 'iii', 'x']) assert.equal(isSequelToken(t), true, t);
  });
  it('false for words', () => {
    for (const t of ['deathinitive', 'edition', 'wild', 'deathmatch', '']) assert.equal(isSequelToken(t), false, t);
  });
});

describe('gameIdentity.canonicalBaseSlug', () => {
  it('strips trailing edition qualifiers, keeps sequel number', () => {
    assert.equal(canonicalBaseSlug('darksiders-ii-deathinitive-edition'), 'darksiders-ii');
    assert.equal(canonicalBaseSlug('darksiders-ii'), 'darksiders-ii');
    assert.equal(canonicalBaseSlug('darksiders'), 'darksiders');
    assert.equal(canonicalBaseSlug('portal-2'), 'portal-2');
    assert.equal(canonicalBaseSlug('endless-space-2-definitive-edition'), 'endless-space-2');
    assert.equal(canonicalBaseSlug('darksiders-warmastered-edition'), 'darksiders');
  });
  it('keeps trailing numbers (years and sequel numbers alike) as part of the base', () => {
    // slugify already strips "(2008)"-style parenthesized years from real titles;
    // a bare trailing number is kept so annual releases are not merged together.
    assert.equal(canonicalBaseSlug('dead-space-2008'), 'dead-space-2008');
    assert.equal(canonicalBaseSlug('doom-64'), 'doom-64');
  });
  it('never strips to empty', () => {
    assert.equal(canonicalBaseSlug('edition'), 'edition');
  });
});

describe('gameIdentity.sameGameSlug', () => {
  it('groups true editions (same base, or edition-qualified extension)', () => {
    assert.equal(sameGameSlug('darksiders-ii', 'darksiders-ii-deathinitive-edition'), true);
    assert.equal(sameGameSlug('portal-2', 'portal-2'), true);
    assert.equal(sameGameSlug('the-witcher-3', 'the-witcher-3-wild-hunt'), true); // word tail = same game
    assert.equal(sameGameSlug('dragon-age-inquisition', 'dragon-age-inquisition-game-of-the-year-edition'), true);
  });
  it('splits sequels (numeric/roman tail)', () => {
    assert.equal(sameGameSlug('portal', 'portal-2'), false);
    assert.equal(sameGameSlug('darksiders', 'darksiders-ii-deathinitive-edition'), false);
    assert.equal(sameGameSlug('half-life', 'half-life-2'), false);
    assert.equal(sameGameSlug('nioh', 'nioh-2'), false);
    assert.equal(sameGameSlug('doom', 'doom-64'), false);
    assert.equal(sameGameSlug('cat-quest', 'cat-quest-iii'), false);
  });
  it('leaves unrelated / non-prefix pairs ungrouped', () => {
    assert.equal(sameGameSlug('deus-ex-invisible-war', 'deus-ex-2-invisible-war'), false); // not a prefix pair
    assert.equal(sameGameSlug('gloomhaven', 'darksiders-ii'), false);
  });
  it('is symmetric', () => {
    assert.equal(sameGameSlug('portal-2', 'portal'), false);
    assert.equal(sameGameSlug('darksiders-ii-deathinitive-edition', 'darksiders-ii'), true);
  });
  it('rejects too-short overlaps', () => {
    assert.equal(sameGameSlug('go', 'go-2'), false); // base < MIN_BASE
  });
});

describe('gameIdentity.isSequelPair', () => {
  it('true only for a numeric/roman-tail prefix pair (a wrongly-merged sequel)', () => {
    assert.equal(isSequelPair('portal', 'portal-2'), true);
    assert.equal(isSequelPair('portal-2', 'portal'), true); // symmetric
    assert.equal(isSequelPair('darksiders', 'darksiders-ii-deathinitive-edition'), true);
    assert.equal(isSequelPair('nioh', 'nioh-2'), true);
  });
  it('false for same game, word-tail subtitles, and non-prefix (IGDB-grouped) pairs', () => {
    assert.equal(isSequelPair('portal-2', 'portal-2'), false); // same base
    assert.equal(isSequelPair('the-witcher-3', 'the-witcher-3-wild-hunt'), false); // word tail
    assert.equal(isSequelPair('deus-ex-invisible-war', 'deus-ex-2-invisible-war'), false); // NOT a prefix pair
    assert.equal(isSequelPair('gloomhaven', 'darksiders-ii'), false); // unrelated
  });
});
