# Gameshelf Phase 4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add metadata enrichment that searches IGDB for game details, downloads/caches cover art locally, creates canonical game records, and links them to launcher-specific game_editions.

**Architecture:** IGDB client handles Twitch OAuth + API calls. Title matcher normalizes names and uses Levenshtein distance to find best match. Image cache downloads and serves images via express.static. Enrichment orchestrator ties it all together — called fire-and-forget after each sync.

**Tech Stack:** Node.js 20, Express 5, better-sqlite3, axios (already installed), IGDB API via Twitch OAuth

**Spec:** `docs/superpowers/specs/2026-03-22-gameshelf-phase4-design.md`

---

## File Structure

### New files
| File | Responsibility |
|------|----------------|
| `backend/src/services/metadata/titleMatcher.js` | Title normalization, slugification, Levenshtein matching |
| `backend/src/services/metadata/igdbClient.js` | Twitch OAuth + IGDB API search/lookup |
| `backend/src/services/metadata/imageCache.js` | Download and cache images locally |
| `backend/src/services/metadata/enrichGame.js` | Orchestrate enrichment: search → match → upsert → images → genres |
| `backend/src/routes/metadata.js` | Metadata API routes |
| `backend/tests/services/metadata/titleMatcher.test.js` | Title matcher unit tests |
| `backend/tests/services/metadata/enrichGame.test.js` | Enrichment integration tests |

### Modified files
| File | Change |
|------|--------|
| `backend/src/server.js` | Add static image serving + mount metadata routes |
| `backend/src/services/syncEngine.js` | Add enrichAll() call after sync success |

---

### Task 1: Title matcher with tests

**Files:**
- Create: `backend/src/services/metadata/titleMatcher.js`
- Create: `backend/tests/services/metadata/titleMatcher.test.js`

- [ ] **Step 1: Write title matcher tests**

Create `backend/tests/services/metadata/titleMatcher.test.js`:

```javascript
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { normalize, slugify, levenshteinSimilarity, findBestMatch } = require('../../../src/services/metadata/titleMatcher');

describe('Title matcher', () => {
  describe('normalize', () => {
    it('should lowercase and strip symbols', () => {
      assert.equal(normalize('Half-Life 2™'), 'half-life 2');
    });

    it('should strip edition suffixes', () => {
      assert.equal(normalize('The Witcher 3 - Game of the Year Edition'), 'the witcher 3');
      assert.equal(normalize('Skyrim GOTY'), 'skyrim');
      assert.equal(normalize('Doom Eternal Deluxe Edition'), 'doom eternal');
    });

    it('should collapse whitespace', () => {
      assert.equal(normalize('  Half   Life  2  '), 'half life 2');
    });

    it('should strip ® symbol', () => {
      assert.equal(normalize('DOOM®'), 'doom');
    });
  });

  describe('slugify', () => {
    it('should normalize and replace spaces with hyphens', () => {
      assert.equal(slugify('Half-Life 2™'), 'half-life-2');
    });

    it('should produce clean slugs from messy titles', () => {
      assert.equal(slugify('The Witcher 3: Wild Hunt - GOTY'), 'the-witcher-3-wild-hunt');
    });
  });

  describe('levenshteinSimilarity', () => {
    it('should return 1.0 for identical strings', () => {
      assert.equal(levenshteinSimilarity('hello', 'hello'), 1.0);
    });

    it('should return 0.0 for completely different strings', () => {
      assert.equal(levenshteinSimilarity('abc', 'xyz'), 0.0);
    });

    it('should return a value between 0 and 1 for similar strings', () => {
      const sim = levenshteinSimilarity('kitten', 'sitting');
      assert.ok(sim > 0.4 && sim < 0.8);
    });
  });

  describe('findBestMatch', () => {
    it('should return the best match above threshold', () => {
      const results = [
        { name: 'Half-Life 2', id: 1 },
        { name: 'Half-Life', id: 2 },
        { name: 'Portal 2', id: 3 },
      ];
      const match = findBestMatch('Half-Life 2', results);
      assert.equal(match.id, 1);
    });

    it('should return null when no match exceeds threshold', () => {
      const results = [
        { name: 'Completely Different Game', id: 1 },
      ];
      const match = findBestMatch('Half-Life 2', results);
      assert.equal(match, null);
    });

    it('should handle empty results', () => {
      assert.equal(findBestMatch('test', []), null);
      assert.equal(findBestMatch('test', null), null);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /development/Claude\ Projects/gamelist_manager/.worktrees/phase4/backend && node --test tests/services/metadata/titleMatcher.test.js`

Expected: FAIL — module not found

- [ ] **Step 3: Implement title matcher**

Create `backend/src/services/metadata/titleMatcher.js`:

```javascript
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
  // Lowercase, strip non-alphanumeric (keep spaces and hyphens), collapse whitespace
  result = result.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s*-\s*$/, '')      // Strip trailing hyphens/separators after suffix removal
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /development/Claude\ Projects/gamelist_manager/.worktrees/phase4/backend && node --test tests/services/metadata/titleMatcher.test.js`

Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/metadata/titleMatcher.js backend/tests/services/metadata/titleMatcher.test.js
git commit -m "feat: add title normalization and Levenshtein matching for IGDB"
```

---

### Task 2: IGDB client

**Files:**
- Create: `backend/src/services/metadata/igdbClient.js`

- [ ] **Step 1: Implement IGDB client**

Create `backend/src/services/metadata/igdbClient.js`:

```javascript
const axios = require('axios');

const IGDB_FIELDS = 'id,name,summary,cover.url,artworks.url,genres.name,involved_companies.company.name,involved_companies.developer,involved_companies.publisher,first_release_date';

let cachedToken = null;
let tokenExpiresAt = 0;

function getCredentials() {
  const clientId = process.env.IGDB_CLIENT_ID;
  const clientSecret = process.env.IGDB_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.warn('[IGDB] IGDB_CLIENT_ID or IGDB_CLIENT_SECRET not set. Metadata enrichment disabled.');
    return null;
  }
  return { clientId, clientSecret };
}

async function authenticate() {
  const creds = getCredentials();
  if (!creds) return null;

  // Return cached token if still valid (with 60s buffer)
  if (cachedToken && Date.now() < tokenExpiresAt - 60000) {
    return cachedToken;
  }

  const res = await axios.post('https://id.twitch.tv/oauth2/token', null, {
    params: {
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      grant_type: 'client_credentials',
    },
  });

  cachedToken = res.data.access_token;
  tokenExpiresAt = Date.now() + res.data.expires_in * 1000;
  return cachedToken;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function igdbRequest(body) {
  const creds = getCredentials();
  if (!creds) return null;

  const token = await authenticate();
  if (!token) return null;

  const config = {
    method: 'post',
    url: 'https://api.igdb.com/v4/games',
    headers: {
      'Client-ID': creds.clientId,
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'text/plain',
    },
    data: body,
  };

  try {
    const res = await axios(config);
    return res.data;
  } catch (err) {
    if (err.response && err.response.status === 429) {
      // Rate limited — wait 500ms and retry once
      await sleep(500);
      try {
        const retryRes = await axios(config);
        return retryRes.data;
      } catch (retryErr) {
        console.error('[IGDB] Rate limit retry failed:', retryErr.message);
        return null;
      }
    }
    console.error('[IGDB] Request failed:', err.message);
    return null;
  }
}

async function search(title) {
  const escapedTitle = title.replace(/"/g, '\\"');
  const body = `search "${escapedTitle}"; fields ${IGDB_FIELDS}; limit 5;`;
  return igdbRequest(body);
}

async function getById(igdbId) {
  const body = `where id = ${igdbId}; fields ${IGDB_FIELDS}; limit 1;`;
  const results = await igdbRequest(body);
  return results && results.length > 0 ? results[0] : null;
}

module.exports = { search, getById };
```

- [ ] **Step 2: Commit**

```bash
git add backend/src/services/metadata/igdbClient.js
git commit -m "feat: add IGDB client with Twitch OAuth and rate limit retry"
```

---

### Task 3: Image cache

**Files:**
- Create: `backend/src/services/metadata/imageCache.js`

- [ ] **Step 1: Implement image cache**

Create `backend/src/services/metadata/imageCache.js`:

```javascript
const axios = require('axios');
const fs = require('node:fs');
const path = require('node:path');

const dataDir = path.resolve(path.dirname(process.env.GAMESHELF_DB_PATH || './data/gameshelf.db'));
const imagesDir = path.join(dataDir, 'images');

/**
 * Transform IGDB image URLs to full-size versions.
 * IGDB returns: //images.igdb.com/igdb/image/upload/t_thumb/{hash}.jpg
 * We want: https://images.igdb.com/igdb/image/upload/t_cover_big/{hash}.jpg
 */
function transformIgdbUrl(url, type) {
  if (!url) return null;
  let transformed = url;

  // Prepend https: if needed
  if (transformed.startsWith('//')) {
    transformed = 'https:' + transformed;
  }

  // Replace thumbnail size with full size
  if (type === 'cover' || type === 'icon') {
    transformed = transformed.replace('/t_thumb/', '/t_cover_big/');
  } else if (type === 'hero') {
    transformed = transformed.replace('/t_thumb/', '/t_screenshot_big/');
  }

  return transformed;
}

async function cacheImage(url, gameId, type) {
  if (!url) return null;

  const fullUrl = transformIgdbUrl(url, type);
  if (!fullUrl) return null;

  // Derive extension from URL
  const urlPath = new URL(fullUrl).pathname;
  const ext = path.extname(urlPath) || '.jpg';

  const gameDir = path.join(imagesDir, String(gameId));
  fs.mkdirSync(gameDir, { recursive: true });

  const filename = `${type}${ext}`;
  const filePath = path.join(gameDir, filename);

  const res = await axios.get(fullUrl, { responseType: 'arraybuffer' });
  fs.writeFileSync(filePath, res.data);

  // Return the URL path the frontend will use
  return `/data/images/${gameId}/${filename}`;
}

function getLocalPath(gameId, type) {
  const gameDir = path.join(imagesDir, String(gameId));
  if (!fs.existsSync(gameDir)) return null;

  const files = fs.readdirSync(gameDir);
  const match = files.find(f => f.startsWith(type + '.'));
  return match ? `/data/images/${gameId}/${match}` : null;
}

module.exports = { cacheImage, getLocalPath, transformIgdbUrl };
```

- [ ] **Step 2: Commit**

```bash
git add backend/src/services/metadata/imageCache.js
git commit -m "feat: add image cache with IGDB URL transformation"
```

---

### Task 4: Enrichment orchestrator with tests

**Files:**
- Create: `backend/src/services/metadata/enrichGame.js`
- Create: `backend/tests/services/metadata/enrichGame.test.js`

- [ ] **Step 1: Write enrichment tests**

Create `backend/tests/services/metadata/enrichGame.test.js`:

```javascript
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

describe('Enrichment orchestrator', () => {
  const testDbPath = path.join(__dirname, '..', '..', 'data', 'test-enrich.db');
  let db;
  let enrichGame, enrichAll;

  before(() => {
    for (const suffix of ['', '-wal', '-shm']) {
      const f = testDbPath + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    process.env.GAMESHELF_ENCRYPTION_KEY = 'a]V3$k9Lm!pQ2rZ&wX8yB#dF5gH7jN0s';
    process.env.GAMESHELF_JWT_SECRET = 'test-jwt';
    process.env.GAMESHELF_DB_PATH = testDbPath;
    // No IGDB credentials — tests will exercise the no-match / fallback path

    delete require.cache[require.resolve('../../src/db/migrate')];
    const { runMigrations } = require('../../src/db/migrate');
    db = runMigrations(testDbPath);

    // Insert a launcher and game_edition with null game_id
    db.prepare('INSERT INTO launchers (name, display_name, enabled) VALUES (?, ?, 1)').run('steam', 'Steam');
    const launcher = db.prepare('SELECT id FROM launchers WHERE name = ?').get('steam');
    db.prepare(
      'INSERT INTO game_editions (launcher_id, launcher_game_id, title) VALUES (?, ?, ?)'
    ).run(launcher.id, '440', 'Team Fortress 2');

    ({ enrichGame, enrichAll } = require('../../src/services/metadata/enrichGame'));
  });

  after(() => {
    if (db) db.close();
    for (const suffix of ['', '-wal', '-shm']) {
      const f = testDbPath + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  it('enrichGame should create a minimal games row when IGDB is unavailable', async () => {
    const edition = db.prepare('SELECT id FROM game_editions WHERE launcher_game_id = ?').get('440');

    await enrichGame(edition.id, db);

    // game_edition should now have a game_id
    const updated = db.prepare('SELECT game_id FROM game_editions WHERE id = ?').get(edition.id);
    assert.ok(updated.game_id, 'game_id should be set');

    // games row should exist with title and slug
    const game = db.prepare('SELECT * FROM games WHERE id = ?').get(updated.game_id);
    assert.ok(game, 'games row should exist');
    assert.equal(game.title, 'Team Fortress 2');
    assert.ok(game.slug, 'slug should be set');
  });

  it('enrichAll should process unlinked editions', async () => {
    // Insert another unlinked edition
    const launcher = db.prepare('SELECT id FROM launchers WHERE name = ?').get('steam');
    db.prepare(
      'INSERT INTO game_editions (launcher_id, launcher_game_id, title) VALUES (?, ?, ?)'
    ).run(launcher.id, '570', 'Dota 2');

    const result = await enrichAll(db);
    assert.ok(result.enriched >= 0 || result.skipped >= 0, 'Should return counts');

    // Dota 2 should now have a game_id
    const edition = db.prepare('SELECT game_id FROM game_editions WHERE launcher_game_id = ?').get('570');
    assert.ok(edition.game_id, 'Dota 2 should have game_id');
  });

  it('enrichGame should handle already-linked editions gracefully', async () => {
    const edition = db.prepare('SELECT id, game_id FROM game_editions WHERE launcher_game_id = ?').get('440');
    const originalGameId = edition.game_id;

    // Re-enriching should not throw
    await enrichGame(edition.id, db);

    const updated = db.prepare('SELECT game_id FROM game_editions WHERE id = ?').get(edition.id);
    assert.equal(updated.game_id, originalGameId, 'game_id should remain the same');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /development/Claude\ Projects/gamelist_manager/.worktrees/phase4/backend && node --test tests/services/metadata/enrichGame.test.js`

Expected: FAIL — module not found

- [ ] **Step 3: Implement enrichment orchestrator**

Create `backend/src/services/metadata/enrichGame.js`:

```javascript
const igdbClient = require('./igdbClient');
const { normalize, slugify, findBestMatch } = require('./titleMatcher');
const { cacheImage } = require('./imageCache');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function enrichGame(gameEditionId, db) {
  const edition = db.prepare('SELECT * FROM game_editions WHERE id = ?').get(gameEditionId);
  if (!edition) {
    throw new Error(`game_edition not found: ${gameEditionId}`);
  }

  const title = edition.title;
  if (!title) {
    console.warn(`[Gameshelf Metadata] game_edition ${gameEditionId} has no title, skipping`);
    return { status: 'skipped', reason: 'no title' };
  }

  const normalizedTitle = normalize(title);
  const slug = slugify(title);

  // Search IGDB
  const igdbResults = await igdbClient.search(normalizedTitle);
  const match = igdbResults ? findBestMatch(title, igdbResults) : null;

  // TODO: RAWG.io fallback would slot in here if match is null
  // e.g., if (!match) match = await rawgClient.search(normalizedTitle);

  if (!match) {
    console.log(`[Gameshelf Metadata] No IGDB match for: ${title}`);
    // Create minimal games row
    const gameResult = db.prepare(`
      INSERT INTO games (title, slug) VALUES (?, ?)
      ON CONFLICT(slug) DO UPDATE SET updated_at = datetime('now')
    `).run(title, slug);

    const game = db.prepare('SELECT id FROM games WHERE slug = ?').get(slug);
    db.prepare('UPDATE game_editions SET game_id = ? WHERE id = ?').run(game.id, gameEditionId);

    return { status: 'minimal', gameId: game.id };
  }

  // Extract metadata from IGDB match
  const gameTitle = match.name || title;
  const gameSlug = slugify(gameTitle);
  const description = match.summary || null;
  const releaseYear = match.first_release_date
    ? new Date(match.first_release_date * 1000).getFullYear()
    : null;

  // Extract developer and publisher from involved_companies
  const companies = match.involved_companies || [];
  const developer = companies.find(c => c.developer)?.company?.name || null;
  const publisher = companies.find(c => c.publisher)?.company?.name || null;

  // Upsert games row
  db.prepare(`
    INSERT INTO games (title, slug, description, release_year, developer, publisher, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(slug) DO UPDATE SET
      title = excluded.title,
      description = excluded.description,
      release_year = excluded.release_year,
      developer = excluded.developer,
      publisher = excluded.publisher,
      updated_at = datetime('now')
  `).run(gameTitle, gameSlug, description, releaseYear, developer, publisher);

  const game = db.prepare('SELECT id FROM games WHERE slug = ?').get(gameSlug);
  const gameId = game.id;

  // Download and cache images (only if URLs exist)
  try {
    const coverUrl = match.cover?.url || null;
    const artworkUrl = match.artworks?.[0]?.url || null;

    if (coverUrl) {
      const coverPath = await cacheImage(coverUrl, gameId, 'cover');
      if (coverPath) {
        db.prepare('UPDATE games SET cover_url = ? WHERE id = ?').run(coverPath, gameId);
        // Copy cover as icon
        const iconPath = await cacheImage(coverUrl, gameId, 'icon');
        if (iconPath) {
          db.prepare('UPDATE games SET icon_url = ? WHERE id = ?').run(iconPath, gameId);
        }
      }
    }

    if (artworkUrl) {
      const heroPath = await cacheImage(artworkUrl, gameId, 'hero');
      if (heroPath) {
        db.prepare('UPDATE games SET hero_url = ? WHERE id = ?').run(heroPath, gameId);
      }
    }
  } catch (err) {
    console.warn(`[Gameshelf Metadata] Image download failed for ${gameTitle}: ${err.message}`);
  }

  // Clear stale genre/tag associations before re-inserting
  db.prepare('DELETE FROM game_genres WHERE game_id = ?').run(gameId);
  db.prepare('DELETE FROM game_tags WHERE game_id = ?').run(gameId);

  // Upsert genres and mirror as tags
  const genres = match.genres || [];
  const insertGenre = db.prepare('INSERT OR IGNORE INTO genres (name) VALUES (?)');
  const insertGameGenre = db.prepare('INSERT OR IGNORE INTO game_genres (game_id, genre_id) VALUES (?, ?)');
  const insertTag = db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)');
  const insertGameTag = db.prepare('INSERT OR IGNORE INTO game_tags (game_id, tag_id) VALUES (?, ?)');

  const upsertGenres = db.transaction((genreList) => {
    for (const genre of genreList) {
      const genreName = genre.name || genre;
      if (!genreName) continue;

      insertGenre.run(genreName);
      const genreRow = db.prepare('SELECT id FROM genres WHERE name = ?').get(genreName);
      insertGameGenre.run(gameId, genreRow.id);

      // Mirror as tag
      insertTag.run(genreName);
      const tagRow = db.prepare('SELECT id FROM tags WHERE name = ?').get(genreName);
      insertGameTag.run(gameId, tagRow.id);
    }
  });
  upsertGenres(genres);

  // Link game_edition to games row
  db.prepare('UPDATE game_editions SET game_id = ? WHERE id = ?').run(gameId, gameEditionId);

  return { status: 'enriched', gameId };
}

async function enrichAll(db) {
  const editions = db.prepare('SELECT id, title FROM game_editions WHERE game_id IS NULL').all();

  let enriched = 0;
  let failed = 0;
  let skipped = 0;

  for (const edition of editions) {
    try {
      const result = await enrichGame(edition.id, db);
      if (result.status === 'enriched') enriched++;
      else if (result.status === 'minimal') enriched++;
      else skipped++;
    } catch (err) {
      console.error(`[Gameshelf Metadata] Failed to enrich "${edition.title}": ${err.message}`);
      failed++;
    }

    // 500ms delay between calls to avoid rate limiting
    await sleep(500);
  }

  return { enriched, failed, skipped };
}

module.exports = { enrichGame, enrichAll };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /development/Claude\ Projects/gamelist_manager/.worktrees/phase4/backend && node --test tests/services/metadata/enrichGame.test.js`

Expected: All 3 tests PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/metadata/enrichGame.js backend/tests/services/metadata/enrichGame.test.js
git commit -m "feat: add enrichment orchestrator with IGDB search, image caching, and genre upsert"
```

---

### Task 5: Metadata routes

**Files:**
- Create: `backend/src/routes/metadata.js`

- [ ] **Step 1: Implement metadata routes**

Create `backend/src/routes/metadata.js`:

```javascript
const { Router } = require('express');
const authMiddleware = require('../middleware/auth');
const { enrichGame, enrichAll } = require('../services/metadata/enrichGame');

const router = Router();

router.use(authMiddleware);

// POST /api/metadata/enrich/:gameEditionId
router.post('/enrich/:gameEditionId', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { gameEditionId } = req.params;
    const result = await enrichGame(Number(gameEditionId), db);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/metadata/enrich-all
router.post('/enrich-all', (req, res) => {
  const db = req.app.locals.db;
  // Fire and forget
  enrichAll(db).catch(err => console.error('[Metadata] enrichAll error:', err.message));
  res.json({ message: 'Gameshelf enrichment started' });
});

// GET /api/metadata/status
router.get('/status', (req, res) => {
  const db = req.app.locals.db;

  const total = db.prepare('SELECT COUNT(*) as count FROM games').get().count;
  const unenriched = db.prepare('SELECT COUNT(*) as count FROM games WHERE cover_url IS NULL').get().count;

  res.json({ unenriched, total });
});

module.exports = router;
```

- [ ] **Step 2: Commit**

```bash
git add backend/src/routes/metadata.js
git commit -m "feat: add metadata enrichment API routes"
```

---

### Task 6: Server.js updates (static serving + route mount)

**Files:**
- Modify: `backend/src/server.js`

- [ ] **Step 1: Add static image serving and metadata routes to server.js**

In `backend/src/server.js`, add `path` require at the top (after line 23):

```javascript
const path = require('node:path');
```

Add metadata router import (after line 35):

```javascript
const metadataRouter = require('./routes/metadata');
```

Add static image serving after the health check (after line 54), before API routes:

```javascript
// Static image serving for cached game artwork
const dataDir = path.resolve(path.dirname(dbPath));
app.use('/data/images', express.static(path.join(dataDir, 'images')));
```

Add metadata route mount (after line 61, with other API routes):

```javascript
app.use('/api/metadata', metadataRouter);
```

- [ ] **Step 2: Run full backend test suite**

Run: `cd /development/Claude\ Projects/gamelist_manager/.worktrees/phase4/backend && npm test`

Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add backend/src/server.js
git commit -m "feat: add static image serving and mount metadata routes"
```

---

### Task 7: Sync engine integration

**Files:**
- Modify: `backend/src/services/syncEngine.js`

- [ ] **Step 1: Add enrichAll call after sync success**

In `backend/src/services/syncEngine.js`, add the import at the top (after line 2):

```javascript
const { enrichAll } = require('./metadata/enrichGame');
```

After line 95 (`db.prepare('UPDATE launchers SET last_sync_at = ? WHERE id = ?').run(completedAt, launcher.id);`), add:

```javascript
    // Fire-and-forget enrichment pass
    console.log(`[Gameshelf Metadata] Starting enrichment pass after sync for ${launcherName}`);
    enrichAll(db).catch(err => console.error('[Metadata] enrichAll error:', err.message));
```

- [ ] **Step 2: Update syncEngine test to handle enrichAll side effect**

The existing `backend/tests/services/syncEngine.test.js` asserts `game_id === null` after sync. After this change, `enrichAll()` fires in the background and may set `game_id` before the assertion runs. Update the test that checks `edition.game_id === null` to instead verify the sync job succeeded (which is the sync engine's actual responsibility). The enrichment behavior is tested separately in the enrichGame tests.

If the test still asserts `game_id === null`, it's acceptable because IGDB credentials are not set in tests, so `enrichAll` will create minimal games rows via the no-match path — but the timing is non-deterministic. The safest fix: change the assertion to simply verify the `game_edition` row exists with the correct `title` and `playtime_minutes`, without asserting `game_id`.

- [ ] **Step 3: Run full backend test suite**

Run: `cd /development/Claude\ Projects/gamelist_manager/.worktrees/phase4/backend && npm test`

Expected: All tests pass

- [ ] **Step 4: Verify frontend builds**

Run: `cd /development/Claude\ Projects/gamelist_manager/.worktrees/phase4/frontend && npx vite build`

Expected: Build succeeds

- [ ] **Step 4: Commit**

```bash
git add backend/src/services/syncEngine.js
git commit -m "feat: trigger metadata enrichment after launcher sync"
```

---

### Task 8: Final verification

- [ ] **Step 1: Run full backend test suite**

Run: `cd /development/Claude\ Projects/gamelist_manager/.worktrees/phase4/backend && npm test`

Expected: All tests PASS

- [ ] **Step 2: Verify all files exist**

```bash
for f in \
  backend/src/services/metadata/igdbClient.js \
  backend/src/services/metadata/titleMatcher.js \
  backend/src/services/metadata/imageCache.js \
  backend/src/services/metadata/enrichGame.js \
  backend/src/routes/metadata.js; do
  [ -f "$f" ] && echo "OK $f" || echo "MISSING $f"
done
```

Expected: All 5 files OK

- [ ] **Step 3: Confirm task completion**

- Spec Task 1 (IGDB client) → Plan Task 2 ✓
- Spec Task 2 (Title matching) → Plan Task 1 ✓
- Spec Task 3 (Image cache) → Plan Task 3 ✓
- Spec Task 4 (Enrichment orchestrator) → Plan Task 4 ✓
- Spec Task 5 (Metadata routes) → Plan Tasks 5-6 ✓
- Spec Task 6 (Sync engine update) → Plan Task 7 ✓
