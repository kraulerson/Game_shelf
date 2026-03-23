# Phase 8: UI Improvements — Configure Button, Alphabetical Nav, Search Clear

## Overview

Three small UI improvements:

1. **Configure button for unconfigured launchers** — navigate to setup wizard
2. **Alphabetical navigation bar** — A-Z letter bar below filters for quick navigation
3. **Clear button on search** — X icon to clear the search input

## Feature 1: Configure Button on Unconfigured Launchers

### Frontend

In `Settings.jsx` LaunchersTab, unconfigured launchers currently show "Not configured" with no action button. Add a "Configure" button that navigates to `/setup`.

- Add `const navigate = useNavigate()` inside the `LaunchersTab` component (the hook is imported at file level but must be called within the component)
- Button appears only when `!l.configured`
- Styled as a primary action button (same blue as "Sync")
- Navigates to `/setup` on click

## Feature 2: Alphabetical Navigation Bar

### Backend

Add a `starts_with` query parameter to `GET /api/games`. When provided:
- If a letter (A-Z): filter games where title starts with that letter (case-insensitive)
- If `#`: filter games where the title starts with a non-letter character (number or symbol)

Because the games endpoint has two query modes (deduplicated and duplicated) with different column references, the `starts_with` filter must use dual expressions — the same pattern as the existing `search` handling with `searchWhereDup` / `searchWhereDedup`:

Duplicated mode (references `ge.title` and `g.title`):
```sql
-- letter
COALESCE(g.title, ge.title) LIKE 'A%' COLLATE NOCASE
-- #
COALESCE(g.title, ge.title) NOT GLOB '[A-Za-z]*'
```

Deduplicated mode (references `r.edition_title` and `g.title`):
```sql
-- letter
COALESCE(g.title, r.edition_title) LIKE 'A%' COLLATE NOCASE
-- #
COALESCE(g.title, r.edition_title) NOT GLOB '[A-Za-z]*'
```

Note: `r_title` is a SELECT alias and cannot be used in WHERE clauses in SQLite. The actual column `r.edition_title` must be used instead.

Both `starts_with` and `search` can be active simultaneously — they compose as AND conditions.

### Frontend

In `Library.jsx`, add a horizontal letter bar below the filter area (above the game grid):

- Row of buttons: `#`, `A`, `B`, `C`, ... `Z`
- Clicking a letter sets `starts_with` URL search param and resets page to 1
- Active letter is highlighted (blue background)
- Clicking the active letter again clears the filter (removes `starts_with` param)
- Compact styling: small text, tight spacing, wraps on mobile
- Add `starts_with` to the `filterKeys` array so it's included in active filter count and cleared by "Clear all filters"

## Feature 3: Clear Button on Search Input

### Frontend

In `Library.jsx`, the search input container is already `relative`. Add an X icon button (from lucide-react, already imported) that:

- Appears only when the search input has text
- Is positioned inside the input on the right side (absolute positioning)
- Clicking it clears the search input state and removes the `search` URL param
- Add right padding to the input (`pr-8`) to prevent text from going under the X button
- Clearing search does not affect the `starts_with` letter filter (they are independent)

## Files Changed

### Backend
- Modify: `backend/src/routes/games.js` — add `starts_with` query param handling with dual expressions

### Frontend
- Modify: `frontend/src/pages/Settings.jsx` — add Configure button for unconfigured launchers
- Modify: `frontend/src/pages/Library.jsx` — add alphabetical nav bar and search clear button
