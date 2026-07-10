const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { ALIASES, aliasesFor } = require('../../src/services/manualDownloadAliases');

// #222: exact on-disk entry name -> game slug, for downloads whose filename can't
// be auto-normalized (abbreviations, opaque builds, accent-mangled titles).

describe('manualDownloadAliases', () => {
  it('maps opaque humble/itch filenames to owned slugs', () => {
    assert.equal(
      ALIASES.humble['steelstorm-br-2.00.02818-release.exe'],
      'steel-storm-burning-retribution'
    );
    assert.equal(ALIASES.itchio['Totem 1.06.zip'], 'ttem');
    assert.equal(ALIASES.itchio['VirtuaWorlds_CthulhuFrozenNightmare.zip'], 'cthulhu-frozen-nightmare');
  });
  it('aliasesFor returns {} for a launcher with no aliases', () => {
    assert.deepEqual(aliasesFor('gog'), {});
    assert.deepEqual(aliasesFor('amazon'), {});
  });
});
