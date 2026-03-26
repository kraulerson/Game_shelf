const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('Amazon parseGamesJson', () => {
  it('should parse a valid JSON array of games', () => {
    const { parseGamesJson } = require('../../../src/services/launchers/amazon');
    const json = JSON.stringify([
      { productId: 'aaa-bbb', title: 'Ghostwire: Tokyo' },
      { productId: 'ccc-ddd', title: 'Fallout 76' },
    ]);
    const games = parseGamesJson(Buffer.from(json));

    assert.ok(Array.isArray(games), 'should return an array');
    assert.equal(games.length, 2);
    assert.equal(games[0].title, 'Fallout 76');  // sorted alphabetically
    assert.equal(games[1].title, 'Ghostwire: Tokyo');
    assert.equal(games[0].launcher_game_id, 'ccc-ddd');
    assert.equal(games[1].launcher_game_id, 'aaa-bbb');
  });

  it('should skip entries without a title', () => {
    const { parseGamesJson } = require('../../../src/services/launchers/amazon');
    const json = JSON.stringify([
      { productId: 'aaa', title: 'Valid Game' },
      { productId: 'bbb' },
      { productId: 'ccc', title: '' },
    ]);
    const games = parseGamesJson(Buffer.from(json));
    assert.equal(games.length, 1);
    assert.equal(games[0].title, 'Valid Game');
  });

  it('should throw on invalid JSON', () => {
    const { parseGamesJson } = require('../../../src/services/launchers/amazon');
    assert.throws(() => parseGamesJson(Buffer.from('not json')), /Failed to parse/);
  });

  it('should throw on non-array JSON', () => {
    const { parseGamesJson } = require('../../../src/services/launchers/amazon');
    assert.throws(() => parseGamesJson(Buffer.from('{"foo":"bar"}')), /Expected a JSON array/);
  });
});
