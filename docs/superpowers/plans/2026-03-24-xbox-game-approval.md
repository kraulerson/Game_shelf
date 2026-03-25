# Xbox Game Approval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dedicated approval page where the user can select which Xbox games they actually own, hard-deleting the rest.

**Architecture:** New backend endpoint `GET /api/launchers/:id/editions` provides a lightweight unpaginated list of editions. New endpoint `POST /api/launchers/:id/approve` handles the hard delete logic. New frontend page `XboxApproval.jsx` with route `/settings/xbox/approve` presents an alphabetical checklist of Xbox editions. An "Approve" button on the Xbox launcher row in Settings navigates to this page.

**Tech Stack:** React (frontend), Express/SQLite (backend), React Router, TanStack Query

---

### Task 1: Backend — Editions List and Approve Endpoints

**Files:**
- Modify: `backend/src/routes/launchers.js`

- [ ] **Step 1: Add the editions list endpoint**

Add `GET /api/launchers/:id/editions` to `backend/src/routes/launchers.js`, before the `module.exports` line. This is a dedicated lightweight endpoint that returns all owned editions for a launcher without the 100-row pagination cap of the general games API:

```javascript
// GET /api/launchers/:id/editions — lightweight list for approval page
router.get('/:id/editions', (req, res) => {
  const { id } = req.params;
  const launcher = LAUNCHER_MAP[id];

  if (!launcher) {
    return res.status(400).json({ error: `Unknown launcher: ${id}` });
  }

  const db = req.app.locals.db;
  const launcherRow = db.prepare('SELECT id FROM launchers WHERE name = ?').get(id);

  if (!launcherRow) {
    return res.status(404).json({ error: 'Launcher not configured' });
  }

  const editions = db.prepare(`
    SELECT ge.id as edition_id, ge.title, g.cover_url
    FROM game_editions ge
    LEFT JOIN games g ON g.id = ge.game_id
    WHERE ge.launcher_id = ? AND ge.owned = 1 AND ge.parent_edition_id IS NULL
    ORDER BY ge.title ASC
  `).all(launcherRow.id);

  res.json({ editions });
});
```

- [ ] **Step 2: Add the approve endpoint**

Add `POST /api/launchers/:id/approve` to `backend/src/routes/launchers.js`, after the editions endpoint:

```javascript
// POST /api/launchers/:id/approve
router.post('/:id/approve', (req, res) => {
  const { id } = req.params;
  const launcher = LAUNCHER_MAP[id];

  if (!launcher) {
    return res.status(400).json({ error: `Unknown launcher: ${id}` });
  }

  const { approved_edition_ids } = req.body || {};

  if (!Array.isArray(approved_edition_ids) || approved_edition_ids.length === 0) {
    return res.status(400).json({ error: 'approved_edition_ids must be a non-empty array' });
  }

  const db = req.app.locals.db;
  const launcherRow = db.prepare('SELECT id FROM launchers WHERE name = ?').get(id);

  if (!launcherRow) {
    return res.status(404).json({ error: 'Launcher not configured' });
  }

  const launcherId = launcherRow.id;

  // Find all owned editions for this launcher (excluding DLC children)
  const allEditions = db.prepare(
    'SELECT id, game_id FROM game_editions WHERE launcher_id = ? AND owned = 1 AND parent_edition_id IS NULL'
  ).all(launcherId);

  const approvedSet = new Set(approved_edition_ids.map(Number));
  const toDelete = allEditions.filter(e => !approvedSet.has(e.id));

  if (toDelete.length === 0) {
    return res.json({ deleted_editions: 0, deleted_games: 0 });
  }

  const deleteDlcChildren = db.prepare('DELETE FROM game_editions WHERE parent_edition_id = ?');
  const deleteEdition = db.prepare('DELETE FROM game_editions WHERE id = ?');
  const countRemainingEditions = db.prepare(
    'SELECT COUNT(*) as c FROM game_editions WHERE game_id = ?'
  );
  const deleteGame = db.prepare('DELETE FROM games WHERE id = ?');

  let deletedEditions = 0;
  let deletedGames = 0;

  const runApproval = db.transaction(() => {
    for (const edition of toDelete) {
      // Delete DLC children first (parent_edition_id FK has no CASCADE)
      const dlcResult = deleteDlcChildren.run(edition.id);
      deletedEditions += dlcResult.changes;
      // Delete the edition itself
      deleteEdition.run(edition.id);
      deletedEditions++;

      // If game has no remaining editions, delete the game too
      if (edition.game_id) {
        const remaining = countRemainingEditions.get(edition.game_id);
        if (remaining.c === 0) {
          deleteGame.run(edition.game_id);
          deletedGames++;
        }
      }
    }
  });

  runApproval();

  res.json({ deleted_editions: deletedEditions, deleted_games: deletedGames });
});
```

- [ ] **Step 3: Test the endpoints manually**

Start the backend and test with curl:

```bash
# List Xbox editions
curl -s -b cookies.txt http://localhost:3001/api/launchers/xbox/editions | jq '.editions | length'

# Test validation - empty array should fail
curl -s -b cookies.txt -X POST http://localhost:3001/api/launchers/xbox/approve \
  -H 'Content-Type: application/json' -d '{"approved_edition_ids":[]}' | jq .

# Test validation - missing field should fail
curl -s -b cookies.txt -X POST http://localhost:3001/api/launchers/xbox/approve \
  -H 'Content-Type: application/json' -d '{}' | jq .
```

Expected: editions list returns all Xbox games; POST returns 400 errors with appropriate messages.

- [ ] **Step 4: Commit**

```bash
git add backend/src/routes/launchers.js
git commit -m "feat: add launcher editions list and approve endpoints"
```

---

### Task 2: Frontend — Approval Page Component

**Files:**
- Create: `frontend/src/pages/XboxApproval.jsx`

- [ ] **Step 1: Create the XboxApproval page component**

Create `frontend/src/pages/XboxApproval.jsx`:

```jsx
import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, CheckSquare, Square } from 'lucide-react';

export default function XboxApproval() {
  const navigate = useNavigate();
  const [selected, setSelected] = useState(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState(null);

  const { data, isLoading } = useQuery({
    queryKey: ['xboxEditions'],
    queryFn: () =>
      fetch('/api/launchers/xbox/editions', {
        credentials: 'same-origin',
      }).then(r => r.json()),
  });

  const editions = data?.editions || [];

  const toggleGame = (editionId) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(editionId)) next.delete(editionId);
      else next.add(editionId);
      return next;
    });
  };

  const selectAll = () => {
    setSelected(new Set(editions.map(e => e.edition_id)));
  };

  const deselectAll = () => {
    setSelected(new Set());
  };

  const deleteCount = editions.length - selected.size;

  const handleSave = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/launchers/xbox/approve', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          approved_edition_ids: [...selected],
        }),
      });
      const result = await res.json();
      if (res.ok) {
        navigate('/settings', {
          state: {
            flash: `Approved ${selected.size} games. Removed ${result.deleted_editions} editions and ${result.deleted_games} games.`,
          },
        });
      } else {
        setError(result.error || 'Approval failed');
      }
    } catch (err) {
      setError('Network error — please try again');
    } finally {
      setSubmitting(false);
      setConfirmDelete(false);
    }
  };

  if (isLoading) {
    return (
      <div className="max-w-3xl mx-auto p-6">
        <p className="text-gray-400">Loading Xbox games...</p>
      </div>
    );
  }

  if (editions.length === 0) {
    return (
      <div className="max-w-3xl mx-auto p-6">
        <button
          onClick={() => navigate('/settings')}
          className="flex items-center gap-1 text-gray-400 hover:text-white mb-4 transition-colors"
        >
          <ArrowLeft size={16} /> Back to Settings
        </button>
        <h1 className="text-xl font-bold text-white mb-4">Xbox Game Approval</h1>
        <p className="text-gray-400">No Xbox games to review.</p>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto p-6">
      <button
        onClick={() => navigate('/settings')}
        className="flex items-center gap-1 text-gray-400 hover:text-white mb-4 transition-colors"
      >
        <ArrowLeft size={16} /> Back to Settings
      </button>

      <h1 className="text-xl font-bold text-white mb-2">Xbox Game Approval</h1>
      <p className="text-sm text-gray-400 mb-4">
        Check the games you own. Unchecked games will be permanently deleted.
      </p>

      {error && (
        <div className="bg-red-900/50 border border-red-700 text-red-300 text-sm rounded-lg p-3 mb-4">
          {error}
        </div>
      )}

      <div className="flex items-center gap-3 mb-4">
        <button
          onClick={selectAll}
          className="flex items-center gap-1 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-sm rounded transition-colors"
        >
          <CheckSquare size={14} /> Select All
        </button>
        <button
          onClick={deselectAll}
          className="flex items-center gap-1 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-sm rounded transition-colors"
        >
          <Square size={14} /> Deselect All
        </button>
        <span className="text-sm text-gray-500">
          {selected.size} of {editions.length} selected
        </span>
      </div>

      <div className="space-y-1 mb-6">
        {editions.map(edition => (
          <label
            key={edition.edition_id}
            className="flex items-center gap-3 p-2 rounded hover:bg-gray-800 cursor-pointer transition-colors"
          >
            <input
              type="checkbox"
              checked={selected.has(edition.edition_id)}
              onChange={() => toggleGame(edition.edition_id)}
              className="w-4 h-4 rounded border-gray-600 text-blue-600 focus:ring-blue-500 bg-gray-700"
            />
            {edition.cover_url && (
              <img
                src={edition.cover_url}
                alt=""
                className="w-8 h-10 object-cover rounded"
              />
            )}
            <span className="text-sm text-white">{edition.title}</span>
          </label>
        ))}
      </div>

      <div className="sticky bottom-0 bg-gray-900 border-t border-gray-700 p-4 -mx-6 px-6">
        <button
          onClick={() => setConfirmDelete(true)}
          disabled={selected.size === 0 || deleteCount === 0 || submitting}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:text-gray-500 text-white text-sm rounded transition-colors"
        >
          {deleteCount === 0
            ? 'Save (all approved)'
            : `Save (${deleteCount} game${deleteCount !== 1 ? 's' : ''} will be deleted)`}
        </button>
      </div>

      {/* Confirmation dialog */}
      {confirmDelete && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-gray-800 rounded-lg p-6 max-w-sm mx-4">
            <h3 className="text-white font-medium mb-2">Confirm Deletion</h3>
            <p className="text-gray-400 text-sm mb-4">
              Delete {deleteCount} Xbox game{deleteCount !== 1 ? 's' : ''}? This cannot be undone (re-sync to recover).
            </p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setConfirmDelete(false)}
                className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-sm rounded transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={submitting}
                className="px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white text-sm rounded transition-colors"
              >
                {submitting ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/pages/XboxApproval.jsx
git commit -m "feat: add XboxApproval page component"
```

---

### Task 3: Frontend — Route and Settings Integration

**Files:**
- Modify: `frontend/src/App.jsx` — add import (line 9) and route (after line 30)
- Modify: `frontend/src/pages/Settings.jsx` — add import (line 3), hooks (after line 28), flash message UI (line 118), and Approve button (lines 151-163)

- [ ] **Step 1: Add the route in App.jsx**

In `frontend/src/App.jsx`, add the import at line 9 (after the Settings import):

```javascript
import XboxApproval from './pages/XboxApproval';
```

Add the route inside the `<Route element={<AuthenticatedLayout />}>` block, after the `/settings` route (after line 30):

```jsx
<Route path="/settings/xbox/approve" element={<XboxApproval />} />
```

- [ ] **Step 2: Add flash message support and Approve button in Settings.jsx**

In `frontend/src/pages/Settings.jsx`, in the `LaunchersTab` component:

First, add `useLocation` to the react-router-dom import (line 3):

```javascript
import { useNavigate, useLocation } from 'react-router-dom';
```

Add `useLocation`, flash state, and history cleanup at the top of the `LaunchersTab` function, after the existing hooks (after line 28):

```javascript
const location = useLocation();
const [flash, setFlash] = useState(location.state?.flash || null);

// Clear flash from history state so it doesn't re-show on back/forward nav
useEffect(() => {
  if (location.state?.flash) {
    window.history.replaceState({}, '');
  }
}, []);
```

Note: `useEffect` needs to be added to the existing `import { useState, useEffect } from 'react'` at line 1 (it is already imported).

Add a flash message display at the top of the return JSX (inside `<div className="space-y-3">` on line 118, before the `{hasConfigured && (` block):

```jsx
{flash && (
  <div className="bg-green-900/50 border border-green-700 text-green-300 text-sm rounded-lg p-3 flex items-center justify-between">
    <span>{flash}</span>
    <button onClick={() => setFlash(null)} className="text-green-400 hover:text-white ml-2">&times;</button>
  </div>
)}
```

In the configured launcher buttons block (lines 151-163), add the Approve button conditionally for Xbox. Find the `<div className="flex items-center gap-2">` containing the Sync and Remove buttons. Add the Approve button as the first child inside that div:

```jsx
{l.id === 'xbox' && (
  <button
    onClick={() => navigate('/settings/xbox/approve')}
    className="flex items-center gap-1 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-sm rounded transition-colors"
  >
    Approve
  </button>
)}
```

- [ ] **Step 3: Test in the browser**

1. Navigate to Settings — verify the "Approve" button appears on the Xbox row only
2. Click "Approve" — verify it navigates to the approval page
3. Verify games are listed alphabetically with checkboxes unchecked
4. Check a few games, verify the count updates
5. Click Save, verify confirmation dialog appears with correct count
6. Confirm — verify redirect to Settings with flash message
7. Verify deleted games no longer appear in Library
8. Navigate away and back to Settings — verify flash message does not reappear

- [ ] **Step 4: Commit**

```bash
git add frontend/src/App.jsx frontend/src/pages/Settings.jsx
git commit -m "feat: integrate Xbox approval page with route and Settings button"
```

---

### Task 4: Version Bump and Changelog

**Files:**
- Modify: version file (project-configured location)
- Modify: changelog file (project-configured location)

- [ ] **Step 1: Bump version**

Bump the patch version for this feature addition.

- [ ] **Step 2: Update changelog**

Add an entry for the Xbox game approval feature.

- [ ] **Step 3: Commit**

```bash
git add <version-file> <changelog-file>
git commit -m "chore: bump version for Xbox game approval feature"
```
