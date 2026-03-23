# Phase 7: Tag Editor — Individual & Bulk Tag Management

## Overview

Add tag editing capabilities to Gameshelf:

1. **Tag CRUD API** — create, delete, list tags; bulk assign/unassign games
2. **Bulk tag editor** — Settings tab for managing tags and assigning them to games at scale
3. **Individual game tag editing** — inline tag editor on the GameDetail page
4. **Filter integration** — new tags automatically appear in the Library filter panel

## Design Decisions

- **Genres remain read-only** — genres come from IGDB enrichment and are not user-editable. Tags are the user-editable concept.
- **Tag-centric bulk editor** — select a tag, then check/uncheck games. Optimized for "tag many games at once."
- **Paginated at 200/page with search** — handles 3K+ game libraries without loading everything at once.
- **Bulk editor shows duplicates** — all game_editions across launchers are visible, but tags are applied at the `games` level (not edition level), so checking one edition of a game tags the game itself.
- **Confirmation on tag removal** — removing a tag from a game on the GameDetail page requires confirmation.

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

Body: `{ name }`. Validates name is non-empty and unique (case-insensitive). Returns `{ id, name }`.

**`DELETE /api/tags/:id`** — Delete a tag.

Deletes from `tags` table. `game_tags` rows cascade-delete via FK. Returns `{ deleted: true }`. Returns 404 if tag not found.

**`GET /api/tags/:id/games`** — Get all game_editions for the bulk editor, with tag membership indicated.

Query params: `page` (default 1), `limit` (default 200), `search` (optional).

Returns all game_editions (including duplicates across launchers) with a `tagged` boolean indicating whether the parent game has this tag. Paginated.

```sql
SELECT ge.id as edition_id, ge.title as edition_title, ge.launcher_game_id,
       g.id as game_id, g.title, g.cover_url, g.icon_url,
       l.name as launcher_name, l.display_name as launcher_display_name,
       CASE WHEN gt.tag_id IS NOT NULL THEN 1 ELSE 0 END as tagged
FROM game_editions ge
JOIN launchers l ON l.id = ge.launcher_id
LEFT JOIN games g ON g.id = ge.game_id
LEFT JOIN game_tags gt ON gt.game_id = g.id AND gt.tag_id = ?
WHERE ge.owned = 1
  [AND (g.title LIKE ? OR ge.title LIKE ?)]  -- if search param
ORDER BY COALESCE(g.title, ge.title) COLLATE NOCASE ASC
LIMIT ? OFFSET ?
```

Returns: `{ games: [...], total, page, limit }`

**`PUT /api/tags/:id/games`** — Bulk update which games have this tag.

Body: `{ gameIds: [1, 2, 3] }` — the complete set of game IDs that should have this tag (replaces all).

Implementation: within a transaction, delete all `game_tags` for this tag_id, then insert new rows for each gameId.

Returns: `{ updated: true, count: <number of games tagged> }`

**`PUT /api/games/:id/tags`** — Set tags for a single game (for GameDetail page).

Body: `{ tagIds: [1, 2, 3] }` — the complete set of tag IDs for this game.

Implementation: within a transaction, delete all `game_tags` for this game_id where the tag is user-created (not a genre-mirrored tag), then insert new rows. Note: genres are also mirrored as tags during enrichment. To avoid removing genre-sourced tags, only delete `game_tags` rows whose `tag_id` corresponds to tags NOT present in the `genres` table, then re-insert the user-specified tagIds.

Actually, simpler approach: delete ALL `game_tags` for this game, then insert all tagIds. The frontend sends the complete list including genre-mirrored tags, so nothing is lost.

Returns: `{ updated: true }`

## Feature 2: Bulk Tag Editor (Settings Tab)

### Frontend

**New "Tags" tab** in Settings page, between "Metadata" and "Account".

**Tag list view (default):**

- Fetches `GET /api/tags` on mount
- Shows tags in a list: tag name, game count, "Edit" button, "Delete" button
- "Create Tag" button at top: shows a text input + submit. Calls `POST /api/tags`. Invalidates `tags` and `gameFilters` queries.
- "Delete" button shows confirmation dialog ("Delete tag [name]? It will be removed from all games."). Calls `DELETE /api/tags/:id`. Invalidates `tags` and `gameFilters` queries.

**Bulk editor view (entered by clicking Edit on a tag):**

- Header: tag name + "Back to tags" link
- Search box: filters games by title (debounced, triggers re-fetch)
- Game list: 200 items per page, each row shows:
  - Game icon/cover (small thumbnail)
  - Game title
  - Launcher badge
  - Checkbox (checked = game has this tag)
- Data fetched from `GET /api/tags/:id/games?page=X&limit=200&search=Y`
- Checking/unchecking: tracks changes locally, then a "Save" button sends `PUT /api/tags/:id/games` with the full list of tagged gameIds
- Pagination controls at bottom (Previous / Next / page indicator)
- On save: invalidates `tags`, `gameFilters`, and `games` queries

## Feature 3: Individual Game Tag Editing (GameDetail)

### Frontend

On the GameDetail page, the existing tag chip section becomes interactive:

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

## Files Changed

### Backend
- Create: `backend/src/routes/tags.js` — all tag CRUD and bulk editor endpoints
- Modify: `backend/src/server.js` — mount tags router at `/api/tags`
- Modify: `backend/src/routes/games.js` — add `PUT /api/games/:id/tags` endpoint

### Frontend
- Modify: `frontend/src/pages/Settings.jsx` — add TagsTab component with tag list and bulk editor views
- Modify: `frontend/src/pages/GameDetail.jsx` — add inline tag editing with add/remove/create

## Testing Considerations

- Tag CRUD: create, list, delete, uniqueness validation
- Bulk editor: `GET /api/tags/:id/games` returns correct `tagged` boolean, pagination works, search filters
- `PUT /api/tags/:id/games`: replaces all associations correctly, handles empty array (untag all)
- `PUT /api/games/:id/tags`: replaces tags for a game, doesn't affect genres
- Delete cascade: deleting a tag removes all game_tags rows
- Filter integration: new tag with assigned games appears in `GET /api/games/filters`
- Scale: 200/page pagination handles 3K+ games
