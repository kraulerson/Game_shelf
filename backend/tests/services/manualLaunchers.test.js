const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { MANUAL_LAUNCHERS, manualLauncherByFolder } = require('../../src/services/manualLaunchers');

// #222: registry of manual-download launchers Game_shelf diffs against the
// lancache host (GOG/Amazon are folder-per-game; Humble/Itch are loose files).

describe('manualLaunchers registry', () => {
  it('lists gog, amazon, humble, itchio with correct folders + modes', () => {
    assert.deepEqual(
      MANUAL_LAUNCHERS.map((l) => [l.name, l.folder, l.mode]),
      [
        ['gog', 'GOG', 'dir'],
        ['amazon', 'Amazon Games', 'dir'],
        ['humble', 'Humble Bundle', 'file'],
        ['itchio', 'Itch.io', 'file'],
      ]
    );
  });

  it('resolves a folder name to its entry (case-insensitive)', () => {
    assert.equal(manualLauncherByFolder('Amazon Games').name, 'amazon');
    assert.equal(manualLauncherByFolder('itch.io').name, 'itchio');
    assert.equal(manualLauncherByFolder('Nope'), undefined);
  });
});
