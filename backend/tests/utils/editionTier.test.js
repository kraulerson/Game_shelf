const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { detectEditionTier, getTierLabel } = require('../../src/utils/editionTier');

describe('detectEditionTier', () => {
  it('should return 0 for plain titles', () => {
    assert.equal(detectEditionTier('Half-Life 2'), 0);
    assert.equal(detectEditionTier('Portal'), 0);
  });

  it('should detect launch edition tiers', () => {
    assert.equal(detectEditionTier('Cyberpunk 2077 Deluxe Edition'), 1);
    assert.equal(detectEditionTier('Far Cry 6 Gold Edition'), 2);
    assert.equal(detectEditionTier('Hogwarts Legacy Ultimate Edition'), 3);
    assert.equal(detectEditionTier('Assassins Creed Premium Edition'), 3);
  });

  it('should detect post-launch edition tiers', () => {
    assert.equal(detectEditionTier('The Witcher 3 GOTY'), 4);
    assert.equal(detectEditionTier('The Witcher 3 Game of the Year Edition'), 4);
    assert.equal(detectEditionTier('Batman Arkham City Complete Edition'), 5);
    assert.equal(detectEditionTier('Batman Arkham City Complete Collection'), 5);
    assert.equal(detectEditionTier('Baldurs Gate Enhanced Edition'), 6);
    assert.equal(detectEditionTier('Skyrim Special Edition'), 7);
    assert.equal(detectEditionTier('Death Stranding Definitive Edition'), 8);
    assert.equal(detectEditionTier("Death Stranding Director's Cut"), 9);
    assert.equal(detectEditionTier('Disco Elysium The Final Cut'), 10);
  });

  it('should handle Unicode apostrophes', () => {
    assert.equal(detectEditionTier('Death Stranding Director\u2019s Cut'), 9);
    assert.equal(detectEditionTier("Dragon's Dogma Collector\u2019s Edition"), 3);
  });

  it('should NOT false-positive on titles containing keywords', () => {
    assert.equal(detectEditionTier('Gold Rush'), 0);
    assert.equal(detectEditionTier('Complete Chess'), 0);
    assert.equal(detectEditionTier('Heart of Gold'), 0);
    assert.equal(detectEditionTier('The Complete Journey'), 0);
  });

  it('should pick highest tier when multiple keywords present', () => {
    assert.equal(detectEditionTier('Game Complete Edition Definitive'), 8);
    assert.equal(detectEditionTier('Game Deluxe GOTY Edition'), 4);
  });
});

describe('getTierLabel', () => {
  it('should return correct labels', () => {
    assert.equal(getTierLabel(0), 'Standard');
    assert.equal(getTierLabel(4), 'GOTY');
    assert.equal(getTierLabel(9), "Director's Cut");
    assert.equal(getTierLabel(10), 'Final Cut');
  });

  it('should return Standard for unknown tiers', () => {
    assert.equal(getTierLabel(99), 'Standard');
  });
});
