# Phase 7: Tag Editor — Individual & Bulk Tag Management

## Overview

Add tag editing capabilities to Gameshelf:

1. **Tag CRUD API** — create, delete, list tags; bulk assign/unassign games
2. **Bulk tag editor** — Settings tab for managing tags and assigning them to games at scale
3. **Individual game tag editing** — inline tag editor on the GameDetail page
4. **Filter integration** — new tags automatically appear in the Library filter panel
5. **Enrichment fix** — protect user-created tags from being wiped by enrichment

## Design Decisions

- **Genres remain read-only** — genres come from IGDB enrichment and are not user-editable. Tags are the user-editable concept.
- **Tag-centric bulk editor** — select a tag, then check/uncheck games. Optimized for "tag many games at once."
- **Paginated at 200/page with search** — handles 3K+ game libraries without loading everything at once.
- **Bulk editor shows duplicates** — all game_editions across launchers are visible, but tags are applied at the `games` level (not edition level), so checking one edition of a game tags the game itself.
- **Confirmation on tag removal** — removing a tag from a game on the GameDetail page requires confirmation. No confirmation in the bulk editor (would be tedious for bulk operations).
- **PATCH-style bulk updates** — the bulk editor uses `{ add: [], remove: [] }` instead of replace-all, which is safe across pagination boundaries.
- **Genre-mirrored tags are protected** — cannot be deleted by users; enrichment only deletes genre-mirrored `game_tags`, preserving user-created tags.

## Feature 1: Tag CRUD API

### Backend

**New route file:** `backend/src/routes/tags.js`, mounted at `/api/tags` in server.js.

All endpoints require `authMiddleware`.

**`GET /api/tags`** — List all tags with game counts.

Returns: `[{ id, name, gameCount }]`

Query:
```sql
SELECT t.id, t.name, COUNT(gt.game_id) as gameCount
FROM tags t
LEFT JOIN game_tags gt ON gt.tag_id = t.id
GROUP BY t.id
ORDER BY t.name COLLATE NOCASE ASC
```

**`POST /api/tags`** — Create a new tag.

Body: `{ name }`. Validation:
- Non-empty after trimming whitespace
- Max 50 characters
- Case-insensitive uniqueness check via application-level `SELECT ... WHERE name = ? COLLATE NOCASE` before insert (SQLite UNIQUE is case-sensitive by default)

Returns: `{ id, name }`. Returns 400 if validation fails or name already exists.

**`DELETE /api/tags/:id`** — Delete a tag.

First checks if the tag name matches a genre name (`SELECT name FROM genres WHERE name = (SELECT name FROM tags WHERE id = ?)`). If so, returns 400 with error "Cannot delete genre-mirrored tag. This tag is managed by metadata enrichment." This prevents user confusion when enrichment re-creates the tag.

Otherwise, deletes from `tags` table. `game_tags` rows cascade-delete via FK. Returns `{ deleted: true }`. Returns 404 if tag not found.

**`GET /api/tags/:id/games`** — Get all game_editions for the bulk editor, with tag membership indicated.

Query params: `page` (default 1), `limit` (default 200), `search` (optional).

Returns all game_editions (including duplicates across launchers) with a `tagged` boolean indicating whether the parent game has this tag. Paginated. Also returns `taggedCount` (total games tagged with this tag, regardless of pagination).

```sql
SELECT ge.id as edition_id,
       COALESCE(g.title, ge.title) as title,
       COALESCE(g.icon_url, g.cover_url) as icon_url,
       g.id as game_id, ge.launcher_game_id,
       l.name as launcher_name, l.display_name as launcher_display_name,
       CASE WHEN gt.tag_id IS NOT NULL THEN 1 ELSE 0 END as tagged
FROM game_editions ge
JOIN launchers l ON l.id = ge.launcher_id
LEFT JOIN games g ON g.id = ge.game_id
LEFT JOIN game_tags gt ON gt.game_id = g.id AND gt.tag_id = ?
WHERE ge.owned = 1 AND ge.game_id IS NOT NULL
  [AND (g.title LIKE ? OR ge.title LIKE ?)]  -- if search param
ORDER BY COALESCE(g.title, ge.title) COLLATE NOCASE ASC
LIMIT ? OFFSET ?
```

Returns: `{ games: [...], total, taggedCount, page, limit }`

**`PATCH /api/tags/:id/games`** — Bulk add/remove games from a tag.

Body: `{ add: [gameId, ...], remove: [gameId, ...] }` — game IDs to add or remove from this tag. This is safe across pagination boundaries since it doesn't replace the full set.

Implementation: within a transaction, `INSERT OR IGNORE INTO game_tags` for each add, `DELETE FROM game_tags` for each remove.

Returns: `{ updated: true }`

**`PUT /api/games/:id/tags`** — Set user-created tags for a single game (for GameDetail page).

Body: `{ tagIds: [1, 2, 3] }` — the set of user-created tag IDs for this game.

Implementation: within a transaction:
1. Delete `game_tags` rows for this game where the tag is NOT genre-mirrored: `DELETE FROM game_tags WHERE game_id = ? AND tag_id NOT IN (SELECT t.id FROM tags t JOIN genres g ON g.name = t.name)`
2. Insert new rows for each tagId: `INSERT OR IGNORE INTO game_tags (game_id, tag_id) VALUES (?, ?)`

This preserves genre-mirrored tags regardless of what the frontend sends.

Returns: `{ updated: true }`

## Feature 2: Bulk Tag Editor (Settings Tab)

### Frontend

**New "Tags" tab** in Settings page, between "Metadata" and "Account".

**Tag list view (default):**

- Fetches `GET /api/tags` on mount
- Shows tags in a list: tag name, game count, "Edit" button, "Delete" button
- "Create Tag" button at top: shows a text input + submit. Calls `POST /api/tags`. Invalidates `tags` and `gameFilters` queries.
- "Delete" button shows confirmation dialog ("Delete tag [name]? It will be removed from all games."). Calls `DELETE /api/tags/:id`. Invalidates `tags` and `gameFilters` queries.
- Genre-mirrored tags are visually distinguished (e.g. grayed-out delete button or label) to indicate they can't be deleted.

**Bulk editor view (entered by clicking Edit on a tag):**

- Header: tag name + "Back to tags" link + "X of Y games tagged" count
- Search box: filters games by title (debounced, triggers re-fetch)
- Game list: 200 items per page, each row shows:
  - Game icon/cover (small thumbnail)
  - Game title
  - Launcher badge
  - Checkbox (checked = game has this tag)
- Data fetched from `GET /api/tags/:id/games?page=X&limit=200&search=Y`
- Checking/unchecking immediately sends `PATCH /api/tags/:id/games` with `{ add: [gameId] }` or `{ remove: [gameId] }`. This avoids tracking local state and ensures changes persist across page navigation.
- Pagination controls at bottom (Previous / Next / page indicator)
- After each change: invalidates `tagGames` (current page data), `tags` (for count updates), and `gameFilters` queries

## Feature 3: Individual Game Tag Editing (GameDetail)

### Frontend

**Update `GET /api/games/:id` response:** Tags must return `[{ id, name }]` instead of just names, so the frontend has tag IDs for the PUT body. Genres continue to return as name strings (they are read-only display).

On the GameDetail page, the existing tag chip section becomes interactive:

- Only user-created tags are shown as editable chips. Genre-mirrored tags (where `tag.name` matches a genre name) are excluded from the editable section — they continue to display as read-only blue genre chips. The frontend filters using `game.tags.filter(t => !game.genres?.includes(t.name))` to get only user-created tags.
- Tags display as removable chips with an "X" button
- Clicking X shows confirmation ("Remove tag [name] from this game?"). On confirm: removes the tag and calls `PUT /api/games/:id/tags` with updated list.
- "Add tag" button/input at the end of the tag chips
- Clicking shows a dropdown listing all tags from `GET /api/tags`, filtered by typing
- If typed text doesn't match any tag, show "Create [name]" option. Creates via `POST /api/tags`, then assigns.
- Selecting a tag adds it immediately and calls `PUT /api/games/:id/tags`
- Genres remain read-only (displayed as blue chips without X button, same as current)
- After any tag change: invalidates `game` (current game detail), `gameFilters`, and `tags` queries

## Feature 4: Filter Panel Integration

No code changes needed. The existing `GET /api/games/filters` endpoint already aggregates tags with counts from `game_tags`. New tags appear automatically once games are assigned. The frontend just needs to invalidate `gameFilters` after tag mutations.

## Feature 5: Protect User-Created Tags During Enrichment

### Backend

**Modify `enrichGame.js`:** Both `enrichGame()` and `enrichUnderEnriched()` currently run `DELETE FROM game_tags WHERE game_id = ?` before re-inserting genre-mirrored tags. This wipes user-created tags.

Change both functions to only delete genre-mirrored `game_tags`:

```sql
DELETE FROM game_tags WHERE game_id = ? AND tag_id IN (
  SELECT t.id FROM tags t JOIN genres g ON g.name = t.name
)
```

This preserves any user-created `game_tags` rows while still allowing enrichment to refresh genre associations.

## Files Changed

### Backend
- Create: `backend/src/routes/tags.js` — all tag CRUD and bulk editor endpoints
- Modify: `backend/src/server.js` — mount tags router at `/api/tags`
- Modify: `backend/src/routes/games.js` — add `PUT /api/games/:id/tags` endpoint, update `GET /api/games/:id` to return tag objects `[{ id, name }]`
- Modify: `backend/src/services/metadata/enrichGame.js` — protect user-created tags during enrichment (both `enrichGame` and `enrichUnderEnriched`)

### Frontend
- Modify: `frontend/src/pages/Settings.jsx` — add TagsTab component with tag list and bulk editor views
- Modify: `frontend/src/pages/GameDetail.jsx` — add inline tag editing with add/remove/create

## Testing Considerations

- Tag CRUD: create, list, delete, uniqueness validation (case-insensitive), name length limit
- Genre-mirrored tag deletion: returns 400 error
- Bulk editor: `GET /api/tags/:id/games` returns correct `tagged` boolean, pagination works, search filters, `taggedCount` is accurate
- `PATCH /api/tags/:id/games`: add/remove work correctly, idempotent (adding already-tagged game is no-op)
- `PUT /api/games/:id/tags`: replaces user-created tags only, preserves genre-mirrored tags
- Enrichment protection: enrichment does not delete user-created tags (regression test)
- Delete cascade: deleting a user-created tag removes all game_tags rows
- Filter integration: new tag with assigned games appears in `GET /api/games/filters`
- Scale: 200/page pagination handles 3K+ games
- GameDetail: `GET /api/games/:id` returns tag objects with id and name
