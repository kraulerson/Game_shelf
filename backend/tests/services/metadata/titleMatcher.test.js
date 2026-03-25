const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { normalize, slugify, levenshteinSimilarity, findBestMatch } = require('../../../src/services/metadata/titleMatcher');

describe('Title matcher', () => {
  describe('normalize', () => {
    it('should lowercase and strip symbols', () => {
      assert.equal(normalize('Half-Life 2™'), 'half-life 2');
    });

    it('should strip edition suffixes', () => {
      assert.equal(normalize('The Witcher 3 - Game of the Year Edition'), 'the witcher 3');
      assert.equal(normalize('Skyrim GOTY'), 'skyrim');
      assert.equal(normalize('Doom Eternal Deluxe Edition'), 'doom eternal');
    });

    it('should collapse whitespace', () => {
      assert.equal(normalize('  Half   Life  2  '), 'half life 2');
    });

    it('should strip ® symbol', () => {
      assert.equal(normalize('DOOM®'), 'doom');
    });
  });

  describe('slugify', () => {
    it('should normalize and replace spaces with hyphens', () => {
      assert.equal(slugify('Half-Life 2™'), 'half-life-2');
    });

    it('should produce clean slugs from messy titles', () => {
      assert.equal(slugify('The Witcher 3: Wild Hunt - GOTY'), 'the-witcher-3-wild-hunt');
    });
  });

  describe('levenshteinSimilarity', () => {
    it('should return 1.0 for identical strings', () => {
      assert.equal(levenshteinSimilarity('hello', 'hello'), 1.0);
    });

    it('should return 0.0 for completely different strings', () => {
      assert.equal(levenshteinSimilarity('abc', 'xyz'), 0.0);
    });

    it('should return a value between 0 and 1 for similar strings', () => {
      const sim = levenshteinSimilarity('kitten', 'sitting');
      assert.ok(sim > 0.4 && sim < 0.8);
    });
  });

  describe('findBestMatch', () => {
    it('should return the best match above threshold', () => {
      const results = [
        { name: 'Half-Life 2', id: 1 },
        { name: 'Half-Life', id: 2 },
        { name: 'Portal 2', id: 3 },
      ];
      const match = findBestMatch('Half-Life 2', results);
      assert.equal(match.id, 1);
    });

    it('should return null when no match exceeds threshold', () => {
      const results = [
        { name: 'Completely Different Game', id: 1 },
      ];
      const match = findBestMatch('Half-Life 2', results);
      assert.equal(match, null);
    });

    it('should handle empty results', () => {
      assert.equal(findBestMatch('test', []), null);
      assert.equal(findBestMatch('test', null), null);
    });

    it('should match when search title is a prefix of IGDB title (word boundary)', () => {
      const results = [
        { name: 'MechWarrior 5: Mercenaries', id: 1 },
        { name: 'MechWarrior Online', id: 2 },
      ];
      // REGRESSION: "MechWarrior 5" has 0.52 Levenshtein similarity to
      // "MechWarrior 5: Mercenaries" — below 0.75 threshold without prefix boost
      const match = findBestMatch('MechWarrior 5', results);
      assert.ok(match, 'Should match via prefix boost');
      assert.equal(match.id, 1);
    });

    it('should match when IGDB title is a prefix of search title', () => {
      const results = [
        { name: 'The Witcher 3', id: 1 },
      ];
      const match = findBestMatch('The Witcher 3: Wild Hunt', results);
      assert.ok(match, 'Should match when IGDB title is shorter');
      assert.equal(match.id, 1);
    });

    // REGRESSION: GOG uses short names like "Heroes of the Lance" but IGDB
    // has the full franchise title "Advanced Dungeons & Dragons: Heroes of the Lance".
    // The suffix boost matches when the search slug appears at the END of the IGDB slug.
    it('should match when search title is a suffix of IGDB title (franchise prefix)', () => {
      const results = [
        { name: 'Advanced Dungeons & Dragons: Heroes of the Lance', id: 1 },
        { name: 'Some Other Game', id: 2 },
      ];
      const match = findBestMatch('Heroes of the Lance', results);
      assert.ok(match, 'Should match via suffix boost');
      assert.equal(match.id, 1);
    });

    it('should match Hillsfar with AD&D prefix', () => {
      const results = [
        { name: 'Advanced Dungeons & Dragons: Hillsfar', id: 1 },
      ];
      const match = findBestMatch('Hillsfar', results);
      assert.ok(match, 'Should match via suffix boost');
      assert.equal(match.id, 1);
    });

    it('should not suffix-boost without word boundary', () => {
      const results = [
        { name: 'SuperHillsfar', id: 1 },
      ];
      const match = findBestMatch('Hillsfar', results);
      assert.equal(match, null, 'Should not boost without word boundary');
    });

    it('should not prefix-boost without word boundary', () => {
      const results = [
        { name: 'MechWarrior 50: Future Edition', id: 1 },
      ];
      // "mechwarrior-5" is NOT a valid prefix of "mechwarrior-50-future-edition"
      // because the char after "mechwarrior-5" is "0", not "-"
      const match = findBestMatch('MechWarrior 5', results);
      assert.equal(match, null, 'Should not boost without word boundary');
    });
  });
});
