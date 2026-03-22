# Gameshelf Phase 5 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the Gameshelf application with a full library UI (game grid/list, filters, game detail), settings page, navigation, and production Docker build.

**Architecture:** Backend games API with SQL-level deduplication via launcher priority. React frontend using @tanstack/react-query for data fetching, URL-based filter state via useSearchParams, filter chips + dropdown panel layout. Nginx serves the built React app and proxies /api/ and /data/images/ to the Express backend.

**Tech Stack:** Node.js 20, Express 5, better-sqlite3, React 18, Vite, TailwindCSS, @tanstack/react-query, lucide-react, fuse.js, Nginx, Docker

**Spec:** `docs/superpowers/specs/2026-03-22-gameshelf-phase5-design.md`

---

## File Structure

### New files
| File | Responsibility |
|------|----------------|
| `frontend/src/components/Nav.jsx` | Top navigation bar |
| `frontend/src/components/FilterPanel.jsx` | Dropdown filter panel with checkboxes and ranges |
| `frontend/src/components/GameCard.jsx` | Grid view game card |
| `frontend/src/components/GameRow.jsx` | List view game row |
| `frontend/src/components/LauncherBadge.jsx` | Launcher icon pill component |
| `frontend/src/utils/launcherIcons.js` | Launcher ID to emoji/icon mapping |
| `frontend/src/pages/GameDetail.jsx` | Game detail page with hero, editions, genres |
| `backend/tests/routes/games.test.js` | Games API tests |

### Modified files
| File | Change |
|------|--------|
| `backend/src/routes/games.js` | Replace 501 stub with full games API |
| `backend/src/routes/auth.js` | Add POST /api/auth/change-password |
| `backend/tests/server.test.js` | Update games 501 test |
| `frontend/src/pages/Library.jsx` | Replace placeholder with full library |
| `frontend/src/pages/Settings.jsx` | Replace placeholder with tabbed settings |
| `frontend/src/App.jsx` | Add GameDetail route, Nav, restructure guards |
| `frontend/src/main.jsx` | Wrap with QueryClientProvider |
| `frontend/nginx.conf` | Add /data/images/ proxy, gzip, caching |
| `docker-compose.yml` | Ensure production env |
| `README.md` | Full setup documentation |

---

### Task 1: Install frontend dependencies

**Files:**
- Modify: `frontend/package.json`

- [ ] **Step 1: Install new frontend dependencies**

Run:
```bash
cd frontend && npm install @tanstack/react-query lucide-react fuse.js
```

- [ ] **Step 2: Commit**

```bash
git add frontend/package.json frontend/package-lock.json
git commit -m "feat: install Phase 5 frontend dependencies"
```

---

### Task 2: Games API backend

**Files:**
- Modify: `backend/src/routes/games.js`
- Modify: `backend/src/routes/auth.js`
- Create: `backend/tests/routes/games.test.js`
- Modify: `backend/tests/server.test.js`

- [ ] **Step 1: Write games API tests**

Create `backend/tests/routes/games.test.js`. The test sets up a DB with launcher, game, game_editions, genres, and game_genres, then tests the three endpoints. Key test cases:

- `GET /api/games` returns paginated list with deduplication
- `GET /api/games?search=` filters by title
- `GET /api/games?duplicates=show` returns all editions
- `GET /api/games/:id` returns full detail with editions array
- `GET /api/games/filters` returns genres, tags, launchers with counts
- All routes return 401 without auth

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && node --test tests/routes/games.test.js`

Expected: FAIL — routes return 501

- [ ] **Step 3: Implement games routes**

Replace `backend/src/routes/games.js` with the full implementation:

- `GET /api/games` — Build dynamic SQL with WHERE clauses from query params. For deduplication: use a CTE or subquery to get the min-priority edition per game_id. Join to games, genres, launchers. Build `also_on` array via a separate query per game (or aggregate in SQL). Pagination via `LIMIT/OFFSET` with total count.
- `GET /api/games/:id` — Load game + all editions + genres + tags. Compute `is_primary` per edition.
- `GET /api/games/filters` — Count queries for genres, tags, launchers. Min/max for release_year and playtime.

Key SQL patterns:
```sql
-- Deduplication: get best edition per game
WITH best_editions AS (
  SELECT ge.*, ROW_NUMBER() OVER (
    PARTITION BY COALESCE(ge.game_id, ge.id * -1)
    ORDER BY l.priority ASC
  ) as rn
  FROM game_editions ge
  JOIN launchers l ON l.id = ge.launcher_id
  WHERE ge.owned = 1
)
SELECT ... FROM best_editions be
LEFT JOIN games g ON g.id = be.game_id
WHERE be.rn = 1
```

The `COALESCE(ge.game_id, ge.id * -1)` trick ensures unlinked editions (null game_id) each get their own partition (using negative edition IDs which never collide with real game IDs).

- [ ] **Step 4: Add change-password to auth.js**

Add to `backend/src/routes/auth.js` after the `/me` route:

```javascript
router.post('/change-password', authMiddleware, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current and new password are required' });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }

    const db = req.app.locals.db;
    const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    const valid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const hash = await bcrypt.hash(newPassword, 12);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.user.id);

    const isProduction = process.env.NODE_ENV === 'production';
    res.clearCookie('gameshelf_session', {
      httpOnly: true, secure: isProduction, sameSite: 'Strict', path: '/',
    });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
```

- [ ] **Step 5: Update server.test.js**

Change the test expecting `GET /api/games` to return 501 — it now returns 401 (auth required). Update assertion from `501` to `401`.

- [ ] **Step 6: Run tests**

Run: `cd backend && npm test`

Expected: All tests pass

- [ ] **Step 7: Commit**

```bash
git add backend/src/routes/games.js backend/src/routes/auth.js backend/tests/routes/games.test.js backend/tests/server.test.js
git commit -m "feat: implement games API with deduplication, filtering, and change-password endpoint"
```

---

### Task 3: Launcher icons and badge component

**Files:**
- Create: `frontend/src/utils/launcherIcons.js`
- Create: `frontend/src/components/LauncherBadge.jsx`

- [ ] **Step 1: Create launcher icons mapping**

Create `frontend/src/utils/launcherIcons.js`:

```javascript
// Replace emoji stubs with actual SVG icons — each launcher's press kit provides official assets.
const LAUNCHER_ICONS = {
  steam: '🎮',
  ea: '🎮',
  ubisoft: '🎮',
  epic: '🎮',
  humble: '📦',
  itchio: '🕹️',
  gog: '🎮',
  battlenet: '⚔️',
  xbox: '🎮',
};

export function getLauncherIcon(launcherId) {
  return LAUNCHER_ICONS[launcherId] || '🎮';
}

export default LAUNCHER_ICONS;
```

- [ ] **Step 2: Create LauncherBadge component**

Create `frontend/src/components/LauncherBadge.jsx`:

```jsx
import { getLauncherIcon } from '../utils/launcherIcons';

export default function LauncherBadge({ launcherName, displayName, compact = false, primary = false }) {
  const icon = getLauncherIcon(launcherName);
  const baseClasses = 'inline-flex items-center gap-1 rounded-full text-xs font-medium';
  const colorClasses = primary
    ? 'bg-blue-600 text-white px-2 py-0.5'
    : 'bg-gray-700 text-gray-300 px-2 py-0.5 opacity-70';

  return (
    <span className={`${baseClasses} ${colorClasses}`}>
      <span>{icon}</span>
      {!compact && <span>{displayName}</span>}
    </span>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/utils/launcherIcons.js frontend/src/components/LauncherBadge.jsx
git commit -m "feat: add launcher icons mapping and LauncherBadge component"
```

---

### Task 4: Navigation component

**Files:**
- Create: `frontend/src/components/Nav.jsx`

- [ ] **Step 1: Create Nav component**

Create `frontend/src/components/Nav.jsx` with:
- Gameshelf wordmark (left)
- Library link, Settings link (right)
- Sync status indicator: fetches `GET /api/sync/status` via react-query (refetch every 30s). Shows spinner (lucide `Loader2` with `animate-spin`) if any job has `status === 'running'`, green dot if most recent jobs are all success and within 1h, yellow dot if >24h.
- Logout button: calls `POST /api/auth/logout`, invalidates react-query cache, navigates to `/login`
- Mobile: hamburger toggle for links using `useState`
- Use lucide-react icons: `Library`, `Settings`, `LogOut`, `Menu`, `X`

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/Nav.jsx
git commit -m "feat: add Nav component with sync status indicator"
```

---

### Task 5: App.jsx routing + QueryClientProvider

**Files:**
- Modify: `frontend/src/App.jsx`
- Modify: `frontend/src/main.jsx`

- [ ] **Step 1: Update main.jsx with QueryClientProvider**

```jsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import './index.css';
import App from './App';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30000, retry: 1 },
  },
});

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>
);
```

- [ ] **Step 2: Update App.jsx with new routes and Nav**

```jsx
import { BrowserRouter, Routes, Route, Navigate, Outlet } from 'react-router-dom';
import RequireAuth from './components/RequireAuth';
import RequireSetup from './components/RequireSetup';
import Nav from './components/Nav';
import Login from './pages/Login';
import Setup from './pages/Setup';
import Library from './pages/Library';
import GameDetail from './pages/GameDetail';
import Settings from './pages/Settings';

function AuthenticatedLayout() {
  return (
    <>
      <Nav />
      <Outlet />
    </>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />

        <Route element={<RequireAuth />}>
          <Route path="/setup" element={<Setup />} />

          <Route element={<AuthenticatedLayout />}>
            <Route path="/settings" element={<Settings />} />

            <Route element={<RequireSetup />}>
              <Route path="/library" element={<Library />} />
              <Route path="/library/game/:id" element={<GameDetail />} />
            </Route>
          </Route>
        </Route>

        <Route path="*" element={<Navigate to="/library" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
```

- [ ] **Step 3: Verify frontend builds**

Run: `cd frontend && npx vite build`

Expected: Build succeeds (GameDetail is a new import — create a minimal placeholder if needed)

- [ ] **Step 4: Commit**

```bash
git add frontend/src/main.jsx frontend/src/App.jsx
git commit -m "feat: add routing with Nav, GameDetail, and QueryClientProvider"
```

---

### Task 6: Game card and row components

**Files:**
- Create: `frontend/src/components/GameCard.jsx`
- Create: `frontend/src/components/GameRow.jsx`

- [ ] **Step 1: Create GameCard component**

Create `frontend/src/components/GameCard.jsx`:
- Cover image with `cover_url`, fallback placeholder (gray bg + initials)
- Title with `line-clamp-2`
- LauncherBadge row: primary prominent, secondaries muted
- "Also on" popover (absolute positioned, toggle via state)
- Playtime chip if > 0
- Hover: `hover:scale-105 transition-transform`, description overlay
- Click: `useNavigate` to `/library/game/${game.id}`

- [ ] **Step 2: Create GameRow component**

Create `frontend/src/components/GameRow.jsx`:
- Compact row with icon, title, genre chips (slice 0-3), launcher badges, playtime, year
- Same popover for "Also on"
- Click navigates to detail

- [ ] **Step 3: Verify frontend builds**

Run: `cd frontend && npx vite build`

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/GameCard.jsx frontend/src/components/GameRow.jsx
git commit -m "feat: add GameCard and GameRow components with launcher badges and popovers"
```

---

### Task 7: Filter panel

**Files:**
- Create: `frontend/src/components/FilterPanel.jsx`

- [ ] **Step 1: Create FilterPanel component**

Create `frontend/src/components/FilterPanel.jsx`:
- Dropdown panel triggered by parent. Closes on outside click (useEffect with document click listener) or "Apply" button.
- Fetches filter options via `GET /api/games/filters` with react-query
- Sections: Launchers (checkboxes), Genres (checkboxes, top 20 + "Show more"), Tags (same), Release Year (min/max inputs), Playtime (min/max in hours), Ownership toggle, Duplicates toggle
- Genre/tag search: use `fuse.js` for instant filter-as-you-type within the checkbox lists
- All state managed via `useSearchParams` — reads from URL params, updates them on change
- Returns active filter count via callback or computed from searchParams

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/FilterPanel.jsx
git commit -m "feat: add FilterPanel dropdown with genre/tag/launcher checkboxes and range filters"
```

---

### Task 8: Library page

**Files:**
- Modify: `frontend/src/pages/Library.jsx`

- [ ] **Step 1: Implement Library page**

Replace `frontend/src/pages/Library.jsx` with full implementation:
- Header bar: search input (debounced 300ms), view toggle (grid/list with lucide `Grid3X3`/`List` icons), sort dropdown, "Sync Now" button
- Sync Now: calls `POST /api/sync/all`, then polls `GET /api/sync/status` every 3s via `useQuery` with `refetchInterval`. Stops when no jobs are `running`.
- Filter chips row: "Filters (N)" button toggles FilterPanel. Active filters as removable chips. "Clear all" resets searchParams.
- Content: `useQuery(['games', searchParams.toString()])` fetching `GET /api/games?${searchParams}`. Renders GameCard grid or GameRow list based on view state.
- Grid: `grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4`
- Pagination: simple prev/next with page numbers
- Empty state: "No games found" message
- Loading: skeleton placeholders or simple spinner

- [ ] **Step 2: Verify frontend builds**

Run: `cd frontend && npx vite build`

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/Library.jsx
git commit -m "feat: implement Library page with search, filters, grid/list view, and sync"
```

---

### Task 9: Game detail page

**Files:**
- Create: `frontend/src/pages/GameDetail.jsx`

- [ ] **Step 1: Implement GameDetail page**

Create `frontend/src/pages/GameDetail.jsx`:
- Fetches `GET /api/games/:id` via `useQuery(['game', id])`
- Hero banner: `hero_url` or fallback (cover with CSS `blur(20px)` + dark overlay)
- Cover art: overlapping hero with negative top margin
- Info: title h1, developer/publisher/year
- Genre + tag chips as small pills
- Description: `line-clamp-4` with "Read more" toggle state
- "Owned On" section: map `editions` array to cards. Primary edition (is_primary=true) is full opacity. Non-primary dimmed with "Secondary copy" label.
- Back button with lucide `ArrowLeft` + `useNavigate(-1)`
- Loading state, 404 state

- [ ] **Step 2: Commit**

```bash
git add frontend/src/pages/GameDetail.jsx
git commit -m "feat: add GameDetail page with hero banner, editions, and genre chips"
```

---

### Task 10: Settings page

**Files:**
- Modify: `frontend/src/pages/Settings.jsx`

- [ ] **Step 1: Implement Settings page with tabs**

Replace `frontend/src/pages/Settings.jsx`:
- Tab state: `launchers` | `metadata` | `account` (default: `launchers`)
- **Launchers tab**: fetches `GET /api/launchers/available` + `GET /api/sync/status`. Per launcher card: display name, status badge, last synced time, "Sync Now" button (calls `POST /api/sync/:launcherName`), enable/disable toggle. "Edit credentials" button opens a modal with credential fields (reuse pattern from Setup wizard Step 3 — not the exact component, but same field logic: username/password or api_key based on auth_type).
- **Metadata tab**: fetches `GET /api/metadata/status`. Shows unenriched count + total. "Re-enrich all" button. IGDB setup instructions text.
- **Account tab**: current password + new password + confirm new password form. Submits to `POST /api/auth/change-password`. On success shows message "Password changed. Please log in again." then redirects to /login after 2s.

- [ ] **Step 2: Verify frontend builds**

Run: `cd frontend && npx vite build`

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/Settings.jsx
git commit -m "feat: implement Settings page with launcher management, metadata, and account tabs"
```

---

### Task 11: Docker production build

**Files:**
- Modify: `frontend/nginx.conf`
- Modify: `docker-compose.yml`
- Modify: `README.md`

- [ ] **Step 1: Update nginx.conf**

Replace `frontend/nginx.conf`:

```nginx
server {
    listen 80;
    server_name _;
    root /usr/share/nginx/html;
    index index.html;

    # Enable gzip
    gzip on;
    gzip_types text/html application/javascript text/css application/json;
    gzip_min_length 1000;

    # SPA routing — serve index.html for all non-file requests
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Proxy API requests to backend
    location /api/ {
        proxy_pass http://backend:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Proxy image requests to backend (images served by Express static)
    location /data/images/ {
        proxy_pass http://backend:3001;
        proxy_set_header Host $host;
        # Cache images for 7 days
        add_header Cache-Control "public, max-age=604800";
    }
}
```

- [ ] **Step 2: Ensure docker-compose.yml has production settings**

The current `docker-compose.yml` already has `restart: unless-stopped`. Verify `NODE_ENV=production` is set in `.env.example` (it already is at line 3). No changes needed to `docker-compose.yml`.

- [ ] **Step 3: Update README.md**

Replace `README.md` with comprehensive documentation:
- Prerequisites, first-run setup, default credentials warning
- `docker compose up -d` start command
- Local network / Cloudflare Tunnel access
- API key setup instructions (Steam, itch.io, GOG)
- Known limitations (5 stub launchers)

- [ ] **Step 4: Verify frontend builds for Docker**

Run: `cd frontend && npx vite build`

Expected: Build succeeds, `dist/` directory created

- [ ] **Step 5: Commit**

```bash
git add frontend/nginx.conf docker-compose.yml README.md
git commit -m "feat: update nginx config for image proxy/caching and update README"
```

---

### Task 12: Final verification

- [ ] **Step 1: Run full backend test suite**

Run: `cd backend && npm test`

Expected: All tests PASS

- [ ] **Step 2: Verify frontend builds**

Run: `cd frontend && npx vite build`

Expected: Build succeeds

- [ ] **Step 3: Verify all new files exist**

```bash
for f in \
  frontend/src/components/Nav.jsx \
  frontend/src/components/FilterPanel.jsx \
  frontend/src/components/GameCard.jsx \
  frontend/src/components/GameRow.jsx \
  frontend/src/components/LauncherBadge.jsx \
  frontend/src/utils/launcherIcons.js \
  frontend/src/pages/GameDetail.jsx \
  backend/tests/routes/games.test.js; do
  [ -f "$f" ] && echo "OK $f" || echo "MISSING $f"
done
```

Expected: All 8 files OK

- [ ] **Step 4: Confirm task completion**

- Spec Task 1 (Games API) → Plan Task 2 ✓
- Spec Task 2 (Library page) → Plan Task 8 ✓
- Spec Task 3 (Filter panel) → Plan Task 7 ✓
- Spec Task 4 (Game card/row) → Plan Task 6 ✓
- Spec Task 5 (Game detail) → Plan Task 9 ✓
- Spec Task 6 (Launcher icons) → Plan Task 3 ✓
- Spec Task 7 (Settings page) → Plan Task 10 ✓
- Spec Task 8 (Navigation) → Plan Tasks 4-5 ✓
- Spec Task 9 (Docker build) → Plan Task 11 ✓
