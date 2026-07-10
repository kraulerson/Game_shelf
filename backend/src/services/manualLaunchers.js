// The manual-download launchers Game_shelf checks against the lancache host, in
// display order. `folder` is the on-disk folder the orchestrator lists; `mode`
// selects dir-scan (folder-per-game: GOG, Amazon) vs file-scan (loose installers:
// Humble, Itch — needs ?include_files=true + filename normalization). (#222)
const MANUAL_LAUNCHERS = [
  { name: 'gog', folder: 'GOG', mode: 'dir' },
  { name: 'amazon', folder: 'Amazon Games', mode: 'dir' },
  { name: 'humble', folder: 'Humble Bundle', mode: 'file' },
  { name: 'itchio', folder: 'Itch.io', mode: 'file' },
];

// Resolve an on-disk folder name (e.g. 'Amazon Games') to its registry entry,
// case-insensitively. Returns undefined for an unregistered folder.
function manualLauncherByFolder(folder) {
  const f = String(folder).toLowerCase();
  return MANUAL_LAUNCHERS.find((l) => l.folder.toLowerCase() === f);
}

module.exports = { MANUAL_LAUNCHERS, manualLauncherByFolder };
