# Phase 8: UI Improvements — Configure Button, Alphabetical Nav, Search Clear

## Overview

Three small UI improvements:

1. **Configure button for unconfigured launchers** — navigate to setup wizard
2. **Alphabetical navigation bar** — A-Z letter bar below filters for quick navigation
3. **Clear button on search** — X icon to clear the search input

## Feature 1: Configure Button on Unconfigured Launchers

### Frontend

In `Settings.jsx` LaunchersTab, unconfigured launchers currently show "Not configured" with no action button. Add a "Configure" button that navigates to `/setup`.

- Uses `useNavigate()` (already imported in the file)
- Button appears only when `!l.configured`
- Styled as a primary action button (same blue as "Sync")
- Navigates to `/setup` on click

## Feature 2: Alphabetical Navigation Bar

### Backend

Add a `starts_with` query parameter to `GET /api/games`. When provided:
- If a letter (A-Z): filter games where `COALESCE(g.title, r_title)` starts with that letter (case-insensitive)
- If `#`: filter games where the title starts with a non-letter character (number or symbol)
- Applied as an outer condition in both deduplicated and duplicated query modes

SQL condition for a letter:
```sql
COALESCE(g.title, r_title) LIKE 'A%' COLLATE NOCASE
```

SQL condition for `#`:
```sql
COALESCE(g.title, r_title) NOT GLOB '[A-Za-z]*'
```

### Frontend

In `Library.jsx`, add a horizontal letter bar below the filter area (above the game grid):

- Row of buttons: `#`, `A`, `B`, `C`, ... `Z`
- Clicking a letter sets `starts_with` URL search param and resets page to 1
- Active letter is highlighted (blue background)
- Clicking the active letter again clears the filter (removes `starts_with` param)
- Compact styling: small text, tight spacing, wraps on mobile

## Feature 3: Clear Button on Search Input

### Frontend

In `Library.jsx`, wrap the search input in a relative container. Add an X icon button (from lucide-react) that:

- Appears only when the search input has text
- Is positioned inside the input on the right side
- Clicking it clears the search input state and removes the `search` URL param
- Add right padding to the input to prevent text from going under the X button

## Files Changed

### Backend
- Modify: `backend/src/routes/games.js` — add `starts_with` query param handling

### Frontend
- Modify: `frontend/src/pages/Settings.jsx` — add Configure button for unconfigured launchers
- Modify: `frontend/src/pages/Library.jsx` — add alphabetical nav bar and search clear button
