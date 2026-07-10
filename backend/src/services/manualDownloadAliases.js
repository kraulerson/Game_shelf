// Exact on-disk entry name -> game slug, for downloads whose filename can't be
// auto-normalized to the owned title (abbreviations, opaque builds, accent-mangled
// titles). Each slug is verified against the live owned set at match time; a slug
// that isn't owned on that launcher simply never matches. (#222)
const ALIASES = {
  humble: {
    'atomzombiesmasher-10172016.zip': 'atom-zombie-smasher',
    'neoaquarium_en_setup104.zip': 'neo-aquarium-the-king-of-crustaceans',
    'steelstorm-br-2.00.02818-release.exe': 'steel-storm-burning-retribution',
    'hf-build-1.005.zip': 'hammerfight', // HF=Hammerfight — confirm bundle contents before shipping
  },
  itchio: {
    'Stellaxy.zip': 'stellaxy-classic',
    'Totem 1.06.zip': 'ttem', // owned "Tôtem" — accent stripped by slugify to "ttem"
    'VirtuaWorlds_CthulhuFrozenNightmare.zip': 'cthulhu-frozen-nightmare',
    'anodyne-windowsremasterandclassic.zip': 'anodyne',
    'rumble_v1.0.0_win64.zip': 'rumble-in-the-midwest',
  },
};

function aliasesFor(launcher) {
  return ALIASES[launcher] || {};
}

module.exports = { ALIASES, aliasesFor };
