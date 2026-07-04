// Distinguish game EDITIONS (same game — "Darksiders II" + "Darksiders II
// Deathinitive Edition") from SEQUELS (different games — "Portal" + "Portal 2").
// Operates on slugs (see slugify in titleMatcher). A numeric / roman-numeral tail
// after a shared word-boundary prefix marks a sequel => different game.
//
// No top-level require of titleMatcher: titleMatcher requires THIS module, so a
// top-level back-require would be a cycle. This module needs nothing from it.

const MIN_BASE = 4;

const ROMAN = new Set([
  'i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x',
  'xi', 'xii', 'xiii', 'xiv', 'xv', 'xvi', 'xvii', 'xviii', 'xix', 'xx',
]);

// Edition/qualifier tokens stripped from the END of a slug to find the base game.
// slugify already removes trademark symbols, "(2010)", and some trailing edition
// phrases; this closes the gaps (deathinitive, warmastered, director's cut, ...).
const QUALIFIER = new Set([
  'edition', 'editions', 'complete', 'collection', 'pack',
  'goty', 'game', 'of', 'the', 'year',
  'deluxe', 'gold', 'ultimate', 'premium', 'special', 'enhanced',
  'definitive', 'deathinitive', 'remastered', 'remaster', 'warmastered',
  'directors', 'director', 'cut', 'final',
  'collectors', 'collector', 'legendary', 'limited', 'anniversary',
  'standard', 'base', 'digital', 'hd', 'day', 'one', 'launch', 'and',
]);

function isSequelToken(tok) {
  return /^[0-9]+$/.test(tok) || ROMAN.has(tok);
}

// Reduce a slug to its base-game slug by dropping trailing qualifier tokens.
// Stops at the first non-qualifier token from the end. Never strips a number or
// roman numeral — those are part of the base (portal-2 stays portal-2, and an
// annual release like football-manager-2020 keeps its year, not merged with 2019).
function canonicalBaseSlug(slug) {
  const toks = String(slug || '').split('-').filter(Boolean);
  while (toks.length > 1) {
    const last = toks[toks.length - 1];
    if (isSequelToken(last)) break;
    if (QUALIFIER.has(last)) { toks.pop(); continue; }
    break;
  }
  return toks.join('-');
}

function wordBoundaryPrefix(shorter, longer) {
  return longer.startsWith(shorter) &&
    (longer.length === shorter.length || longer[shorter.length] === '-');
}

// True when two slugs are the SAME game: equal base, or one base is an
// edition-qualified extension of the other. A numeric/roman tail => sequel => false.
function sameGameSlug(slugA, slugB) {
  const a = canonicalBaseSlug(slugA);
  const b = canonicalBaseSlug(slugB);
  if (!a || !b) return false;
  if (a === b) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  if (shorter.length < MIN_BASE) return false;
  if (!wordBoundaryPrefix(shorter, longer)) return false;
  const tail = longer.slice(shorter.length + 1);
  return !isSequelToken(tail.split('-')[0]);
}

// True when two slugs are a SEQUEL pair: one base is a word-boundary prefix of the
// other AND the leftover tail starts with a number/roman numeral (portal / portal-2).
// This is the ONLY relationship the Phase 16 repair splits — a non-prefix pair
// (deus-ex-invisible-war / deus-ex-2-invisible-war) is left as grouped, because
// that grouping came from IGDB/manual matching, not the buggy prefix matcher.
function isSequelPair(slugA, slugB) {
  const a = canonicalBaseSlug(slugA);
  const b = canonicalBaseSlug(slugB);
  if (!a || !b || a === b) return false;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  if (shorter.length < MIN_BASE) return false;
  if (!wordBoundaryPrefix(shorter, longer)) return false;
  return isSequelToken(longer.slice(shorter.length + 1).split('-')[0]);
}

module.exports = { canonicalBaseSlug, sameGameSlug, isSequelToken, isSequelPair, ROMAN, MIN_BASE };
