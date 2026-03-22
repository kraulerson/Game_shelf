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
  });
});
