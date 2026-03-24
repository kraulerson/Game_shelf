// Known real single-word game titles that look like codenames but aren't.
// Add to this list as false positives are discovered.
const KNOWN_REAL_TITLES = new Set([
  'celeste', 'subnautica', 'fortnite', 'control', 'satisfactory',
  'fez', 'limbo', 'hue', 'prey', 'steep', 'inside', 'horace',
  'everything', 'minit', 'overcooked', 'torchlight', 'carcassonne',
  'observer', 'maneater', 'faeria', 'gamedec', 'windbound',
  'crashlands', 'frostpunk', 'relicta', 'sheltered', 'dandara',
  'figment', 'tunche', 'pikuniku', 'solitairica', 'levelhead',
  'mutazione', 'tharsis', 'paradigm', 'pathway', 'breathedge',
  'automachef', 'transistor', 'moonlighter', 'vampyr', 'oxenfree',
  'dauntless', 'ghostrunner', 'tannenberg', 'verdun',
  'mothergunship', 'sifu', 'soulstice', 'godfall', 'quake',
  'tyranny', 'mudrunner', 'spongebob', 'starcraft', 'mechwarrior',
  'powerwash',
]);

function isLikelyCodename(title, launcherGameId) {
  if (!title) return false;

  // "Live" is always a codename (sandbox name for live-service DLC)
  if (title === 'Live') return true;

  // Multi-word titles are real games
  if (/\s/.test(title) || /-/.test(title)) return false;

  // Hex GUID pattern
  if (/^[0-9a-f]{20,}$/i.test(title)) return true;

  // Title equals launcher_game_id (no human-readable name was available)
  if (launcherGameId && title === launcherGameId) return true;

  // ALL-CAPS titles are real (DEATHLOOP, SUPERHOT, SOMA, etc.)
  if (title === title.toUpperCase() && title.length >= 3) return false;

  // Known real titles
  if (KNOWN_REAL_TITLES.has(title.toLowerCase())) return false;

  // PascalCase with 3+ capitals (CadmiumRed, CharlestonGreen, BrilliantRose)
  // Requires 3+ to avoid false positives on real titles like SpongeBob, StarCraft
  const caps = (title.match(/[A-Z]/g) || []).length;
  if (caps >= 3 && !/\d/.test(title)) return true;

  // camelCase-style mid-word capital (2 caps, e.g., "MtWilliamson")
  if (caps === 2 && /^[A-Z][a-z]+[A-Z]/.test(title) && !/\d/.test(title)) return true;

  // Single lowercase word (lisbon, corn)
  if (title === title.toLowerCase() && title.length <= 12) return true;

  return false;
}

module.exports = { isLikelyCodename, KNOWN_REAL_TITLES };
