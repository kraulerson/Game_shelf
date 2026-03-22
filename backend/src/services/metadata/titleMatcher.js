const EDITION_SUFFIXES = [
  /\s*[™®]/g,
  /\s*-?\s*complete edition\s*$/i,
  /\s*-?\s*game of the year edition\s*$/i,
  /\s*-?\s*game of the year\s*$/i,
  /\s*\bGOTY\b\s*$/i,
  /\s*-?\s*deluxe edition\s*$/i,
  /\s*-?\s*gold edition\s*$/i,
  /\s*-?\s*ultimate edition\s*$/i,
];

function normalize(title) {
  let result = title;
  for (const suffix of EDITION_SUFFIXES) {
    result = result.replace(suffix, '');
  }
  result = result.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s*-\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return result;
}

function slugify(title) {
  return normalize(title).replace(/\s+/g, '-');
}

function levenshteinDistance(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }

  return dp[m][n];
}

function levenshteinSimilarity(a, b) {
  if (a.length === 0 && b.length === 0) return 1.0;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1.0;
  return 1 - levenshteinDistance(a, b) / maxLen;
}

function findBestMatch(searchTitle, igdbResults) {
  if (!igdbResults || igdbResults.length === 0) return null;

  const searchSlug = slugify(searchTitle);
  let bestMatch = null;
  let bestSimilarity = 0;

  for (const result of igdbResults) {
    const resultSlug = slugify(result.name);
    const similarity = levenshteinSimilarity(searchSlug, resultSlug);
    if (similarity > bestSimilarity) {
      bestSimilarity = similarity;
      bestMatch = result;
    }
  }

  return bestSimilarity >= 0.8 ? bestMatch : null;
}

module.exports = { normalize, slugify, levenshteinDistance, levenshteinSimilarity, findBestMatch };
