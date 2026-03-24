const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { isLikelyCodename } = require('../../src/utils/codenameDetector');

describe('isLikelyCodename', () => {
  it('should flag "Live" as codename', () => {
    assert.equal(isLikelyCodename('Live'), true);
  });

  it('should flag PascalCase single words with 3+ capitals', () => {
    assert.equal(isLikelyCodename('CadmiumRed'), true);
    assert.equal(isLikelyCodename('CharlestonGreen'), true);
    assert.equal(isLikelyCodename('BrilliantRose'), true);
  });

  it('should flag camelCase-style with 2 capitals', () => {
    assert.equal(isLikelyCodename('MtWilliamson'), true);
  });

  it('should flag lowercase single words', () => {
    assert.equal(isLikelyCodename('lisbon'), true);
  });

  it('should flag hex GUIDs', () => {
    assert.equal(isLikelyCodename('7b8fb449c8d3404ba7eda9cd4da1401b'), true);
    assert.equal(isLikelyCodename('d6407c9e6fd54cb492b8c6635480d792'), true);
  });

  it('should NOT flag ALL-CAPS game titles', () => {
    assert.equal(isLikelyCodename('DEATHLOOP'), false);
    assert.equal(isLikelyCodename('SUPERHOT'), false);
    assert.equal(isLikelyCodename('SOMA'), false);
    assert.equal(isLikelyCodename('ABZU'), false);
    assert.equal(isLikelyCodename('RUINER'), false);
    assert.equal(isLikelyCodename('GNOG'), false);
    assert.equal(isLikelyCodename('INDUSTRIA'), false);
  });

  it('should NOT flag real single-word game titles', () => {
    assert.equal(isLikelyCodename('Celeste'), false);
    assert.equal(isLikelyCodename('Subnautica'), false);
    assert.equal(isLikelyCodename('Fortnite'), false);
    assert.equal(isLikelyCodename('Control'), false);
    assert.equal(isLikelyCodename('Satisfactory'), false);
    assert.equal(isLikelyCodename('Fez'), false);
    assert.equal(isLikelyCodename('Limbo'), false);
    assert.equal(isLikelyCodename('Hue'), false);
    assert.equal(isLikelyCodename('Prey'), false);
  });

  it('should NOT flag multi-word titles', () => {
    assert.equal(isLikelyCodename('Half-Life 2'), false);
    assert.equal(isLikelyCodename('The Witcher 3'), false);
    assert.equal(isLikelyCodename('Fallout New Vegas'), false);
  });

  it('should flag when title equals launcher_game_id', () => {
    assert.equal(isLikelyCodename('Peony', 'Peony'), true);
    assert.equal(isLikelyCodename('Celeste', '12345'), false);
  });

  it('should NOT flag real PascalCase game titles with 2 caps', () => {
    assert.equal(isLikelyCodename('SpongeBob'), false);
    assert.equal(isLikelyCodename('StarCraft'), false);
    assert.equal(isLikelyCodename('MechWarrior'), false);
    assert.equal(isLikelyCodename('PowerWash'), false);
  });
});
