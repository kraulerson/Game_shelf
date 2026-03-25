# Xbox Sync Lock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent Xbox games from reappearing after approval by locking the launcher's sync capability post-approval.

**Architecture:** Add a `sync_locked` column to the `launchers` table. The approve endpoint sets it to 1 after processing. The sync engine and sync routes check it before syncing. A new unlock endpoint allows the user to re-enable sync. The frontend reflects lock state with a lock indicator and unlock button.

**Tech Stack:** Node.js, Express, better-sqlite3, React, TanStack Query

---

### Task 1: Database Migration — Add `sync_locked` Column

**Files:**
- Modify: `backend/src/db/migrate.js` (append after Phase 12b block, ~line 217)
- Test: `backend/tests/db/migrate.test.js`

- [ ] **Step 1: Write the failing test**

In `backend/tests/db/migrate.test.js`, add a test that verifies the `sync_locked` column exists on the `launchers` table after migration. Note: each test in this file manages its own `runMigrations` call and `db.close()`:

```javascript
it('should add sync_locked column to launchers table', () => {
  delete require.cache[require.resolve('../../src/db/migrate')];
  const { runMigrations } = require('../../src/db/migrate');
  const testDb = runMigrations(testDbPath);
  const cols = testDb.pragma('table_info(launchers)');
  const syncLockedCol = cols.find(c => c.name === 'sync_locked');
  assert.ok(syncLockedCol, 'sync_locked column should exist');
  assert.equal(syncLockedCol.dflt_value, '0', 'default should be 0');
  testDb.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/db/migrate.test.js`
Expected: FAIL — `sync_locked column should exist`

- [ ] **Step 3: Write the migration**

In `backend/src/db/migrate.js`, after the Phase 12b block (after `db.pragma('foreign_keys = ON');` around line 214), add:

```javascript
// Sync lock migration: add sync_locked to launchers
const launcherCols = db.pragma('table_info(launchers)');
if (!launcherCols.some(c => c.name === 'sync_locked')) {
  db.exec('ALTER TABLE launchers ADD COLUMN sync_locked INTEGER NOT NULL DEFAULT 0');
  console.log('[Migration] Added sync_locked column to launchers');
}
```

Also update `backend/src/db/schema.sql` — add `sync_locked INTEGER NOT NULL DEFAULT 0` to the `launchers` CREATE TABLE statement (after `last_sync_at TEXT`).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && node --test tests/db/migrate.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/db/migrate.js backend/src/db/schema.sql backend/tests/db/migrate.test.js
git commit -m "feat: add sync_locked column to launchers table"
```

---

### Task 2: Sync Engine Guard — `syncLauncher()` Rejects Locked Launchers

**Files:**
- Modify: `backend/src/services/syncEngine.js:5-10` (add lock check after launcher lookup)
- Test: `backend/tests/services/syncEngine.test.js`

- [ ] **Step 1: Write the failing test**

In `backend/tests/services/syncEngine.test.js`, add a test after the existing tests:

```javascript
it('syncLauncher should fail when launcher is sync-locked', async () => {
  // Lock the launcher
  db.prepare('UPDATE launchers SET sync_locked = 1 WHERE name = ?').run('steam');

  try {
    const jobId = await syncLauncher('steam', db);
    const job = db.prepare('SELECT * FROM sync_jobs WHERE id = ?').get(jobId);
    assert.equal(job.status, 'failed');
    assert.ok(job.error_message.includes('sync-locked'), 'Error should mention sync-locked');
  } finally {
    // Unlock for subsequent tests
    db.prepare('UPDATE launchers SET sync_locked = 0 WHERE name = ?').run('steam');
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/services/syncEngine.test.js`
Expected: FAIL — the sync succeeds instead of failing

- [ ] **Step 3: Add lock check to syncLauncher()**

In `backend/src/services/syncEngine.js`, add the lock check *inside* the try block (after line 23, before the credentials decryption at line 25). This placement is critical — it must be inside the try/catch so the error is caught and recorded as a failed sync job with the error message:

```javascript
// Check sync lock
if (launcher.sync_locked) {
  throw new Error('Launcher is sync-locked. Unlock it in Settings before syncing.');
}
```

The existing catch block at line 159 will handle this error and record it as a failed sync job.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && node --test tests/services/syncEngine.test.js`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/syncEngine.js backend/tests/services/syncEngine.test.js
git commit -m "feat: syncLauncher rejects sync-locked launchers"
```

---

### Task 3: `syncAll()` Skips Locked Launchers

**Files:**
- Modify: `backend/src/services/syncEngine.js:179-205` (update syncAll function)
- Test: `backend/tests/services/syncEngine.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
it('syncAll should skip sync-locked launchers and report them', async () => {
  // Lock steam
  db.prepare('UPDATE launchers SET sync_locked = 1 WHERE name = ?').run('steam');

  try {
    const result = await syncAll(db);
    assert.ok(Array.isArray(result.locked), 'Should have a locked array');
    assert.ok(result.locked.includes('steam'), 'steam should be in locked list');
    assert.ok(!result.succeeded.includes('steam'), 'steam should not be in succeeded');
    assert.ok(!result.failed.includes('steam'), 'steam should not be in failed');
  } finally {
    db.prepare('UPDATE launchers SET sync_locked = 0 WHERE name = ?').run('steam');
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/services/syncEngine.test.js`
Expected: FAIL — `result.locked` is undefined

- [ ] **Step 3: Update syncAll() to skip locked launchers**

In `backend/src/services/syncEngine.js`, modify the `syncAll` function:

1. Change the launcher query (line 181) to also select `sync_locked`:
```javascript
const launchers = db.prepare(
  'SELECT name, sync_locked FROM launchers WHERE enabled = 1 AND credentials_json IS NOT NULL'
).all();
```

2. Add `locked` to the return arrays (line 186):
```javascript
const locked = [];
```

3. Add a lock check at the top of the for loop (after line 188):
```javascript
if (launcher.sync_locked) {
  locked.push(launcher.name);
  continue;
}
```

4. Update the return statement (line 204):
```javascript
return { succeeded, failed, skipped, locked };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && node --test tests/services/syncEngine.test.js`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/syncEngine.js backend/tests/services/syncEngine.test.js
git commit -m "feat: syncAll skips sync-locked launchers"
```

---

### Task 4: Sync Route Guard — Return 409 for Locked Launchers

**Files:**
- Modify: `backend/src/routes/sync.js:78-88` (add lock check before syncLauncher call)
- Test: `backend/tests/routes/launchers.test.js` (add route-level test)

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/routes/launchers.test.js` (reuses existing test setup with `makeFetch` and `authCookie`). First, copy the `makeFetch` helper from `server.test.js` into the test file (or extract to a shared helper). Then add:

```javascript
it('POST /api/sync/:launcherName should return 409 when sync-locked', async () => {
  // Lock the steam launcher
  const db = app.locals.db;
  db.prepare('UPDATE launchers SET sync_locked = 1 WHERE name = ?').run('steam');

  try {
    const res = await makeFetch(app, '/api/sync/steam', {
      method: 'POST',
      headers: { Cookie: authCookie() },
    });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.ok(body.error.includes('locked'), 'Error should mention locked');
  } finally {
    db.prepare('UPDATE launchers SET sync_locked = 0 WHERE name = ?').run('steam');
  }
});
```

Note: The test file already has a `makeFetch` helper pattern. If it's not defined in this file, copy it from `backend/tests/server.test.js` (lines 53-64).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/routes/launchers.test.js`
Expected: FAIL — returns 200 instead of 409

- [ ] **Step 3: Add lock check to sync route**

In `backend/src/routes/sync.js`, modify the `POST /:launcherName` handler (line 79). Add the lock check before the `syncLauncher` call:

```javascript
router.post('/:launcherName', (req, res) => {
  const db = req.app.locals.db;
  const { launcherName } = req.params;

  // Check sync lock before firing sync
  const launcher = db.prepare('SELECT sync_locked, display_name FROM launchers WHERE name = ?').get(launcherName);
  if (launcher && launcher.sync_locked) {
    return res.status(409).json({
      error: `${launcher.display_name || launcherName} is locked. Unlock it in Settings before syncing.`
    });
  }

  const { otp_code } = req.body || {};
  // Fire and forget
  syncLauncher(launcherName, db, otp_code).catch(err =>
    console.error(`[Sync] ${launcherName} sync error:`, err.message)
  );
  res.json({ message: `Sync started for ${launcherName}` });
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && node --test tests/routes/launchers.test.js`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/sync.js backend/tests/routes/launchers.test.js
git commit -m "feat: sync route returns 409 for locked launchers"
```

---

### Task 5: Approve Endpoint Sets `sync_locked = 1`

**Files:**
- Modify: `backend/src/routes/launchers.js:214-283` (add lock after approval)
- Test: `backend/tests/routes/launchers.test.js`

- [ ] **Step 1: Write the failing test — approval with deletions**

```javascript
it('POST /api/launchers/:id/approve should set sync_locked on the launcher', async () => {
  const db = app.locals.db;

  // Setup: ensure xbox launcher exists with credentials and editions
  const { encrypt } = require('../../src/utils/encrypt');
  const creds = encrypt(JSON.stringify({ api_key: 'test-xbox-key' }));
  db.prepare(
    'INSERT OR REPLACE INTO launchers (name, display_name, enabled, credentials_json) VALUES (?, ?, 1, ?)'
  ).run('xbox', 'Xbox / Microsoft', creds);

  const launcher = db.prepare('SELECT id FROM launchers WHERE name = ?').get('xbox');
  // Insert two editions
  const ins = db.prepare(
    'INSERT INTO game_editions (launcher_id, launcher_game_id, title, owned) VALUES (?, ?, ?, 1)'
  );
  ins.run(launcher.id, 'xbox-game-1', 'Halo Infinite');
  ins.run(launcher.id, 'xbox-game-2', 'Forza Horizon 5');

  const editions = db.prepare(
    'SELECT id FROM game_editions WHERE launcher_id = ? AND owned = 1'
  ).all(launcher.id);

  // Approve only the first edition
  const res = await makeFetch(app, '/api/launchers/xbox/approve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: authCookie() },
    body: JSON.stringify({ approved_edition_ids: [editions[0].id] }),
  });

  assert.equal(res.status, 200);

  // Verify sync_locked is set
  const updated = db.prepare('SELECT sync_locked FROM launchers WHERE name = ?').get('xbox');
  assert.equal(updated.sync_locked, 1, 'sync_locked should be 1 after approval');
});
```

- [ ] **Step 2: Write the failing test — approve-all (no deletions) still locks**

```javascript
it('POST /api/launchers/:id/approve should lock even when all games approved', async () => {
  const db = app.locals.db;

  // Unlock from previous test
  db.prepare('UPDATE launchers SET sync_locked = 0 WHERE name = ?').run('xbox');

  // Re-add an edition since previous test deleted some
  const launcher = db.prepare('SELECT id FROM launchers WHERE name = ?').get('xbox');
  db.prepare(
    'INSERT OR IGNORE INTO game_editions (launcher_id, launcher_game_id, title, owned) VALUES (?, ?, ?, 1)'
  ).run(launcher.id, 'xbox-game-3', 'Sea of Thieves');

  const editions = db.prepare(
    'SELECT id FROM game_editions WHERE launcher_id = ? AND owned = 1 AND parent_edition_id IS NULL'
  ).all(launcher.id);

  // Approve ALL editions
  const res = await makeFetch(app, '/api/launchers/xbox/approve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: authCookie() },
    body: JSON.stringify({ approved_edition_ids: editions.map(e => e.id) }),
  });

  assert.equal(res.status, 200);

  const updated = db.prepare('SELECT sync_locked FROM launchers WHERE name = ?').get('xbox');
  assert.equal(updated.sync_locked, 1, 'sync_locked should be 1 even when all approved');
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd backend && node --test tests/routes/launchers.test.js`
Expected: FAIL — `sync_locked` is still 0

- [ ] **Step 4: Modify approve endpoint to set sync_locked**

In `backend/src/routes/launchers.js`, two changes:

1. In the early-return path (line 246-248), set the lock before returning:
```javascript
if (toDelete.length === 0) {
  db.prepare('UPDATE launchers SET sync_locked = 1 WHERE id = ?').run(launcherId);
  return res.json({ deleted_editions: 0, deleted_games: 0 });
}
```

2. After the `runApproval()` call (after line 280), add:
```javascript
db.prepare('UPDATE launchers SET sync_locked = 1 WHERE id = ?').run(launcherId);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && node --test tests/routes/launchers.test.js`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/launchers.js backend/tests/routes/launchers.test.js
git commit -m "feat: approve endpoint locks launcher sync after approval"
```

---

### Task 6: Unlock Endpoint and Credential Deletion Reset

**Files:**
- Modify: `backend/src/routes/launchers.js` (add unlock endpoint, modify delete handler)
- Test: `backend/tests/routes/launchers.test.js`

- [ ] **Step 1: Write failing test — unlock endpoint**

```javascript
it('POST /api/launchers/:id/unlock-sync should clear sync_locked', async () => {
  const db = app.locals.db;
  // Ensure locked
  db.prepare('UPDATE launchers SET sync_locked = 1 WHERE name = ?').run('xbox');

  const res = await makeFetch(app, '/api/launchers/xbox/unlock-sync', {
    method: 'POST',
    headers: { Cookie: authCookie() },
  });

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);

  const row = db.prepare('SELECT sync_locked FROM launchers WHERE name = ?').get('xbox');
  assert.equal(row.sync_locked, 0, 'sync_locked should be 0 after unlock');
});
```

- [ ] **Step 2: Write failing test — unlock unknown launcher**

```javascript
it('POST /api/launchers/:id/unlock-sync should return 400 for unknown launcher', async () => {
  const res = await makeFetch(app, '/api/launchers/fakeLauncher/unlock-sync', {
    method: 'POST',
    headers: { Cookie: authCookie() },
  });
  assert.equal(res.status, 400);
});
```

- [ ] **Step 3: Write failing test — credential deletion resets lock**

```javascript
it('DELETE /api/launchers/:id/credentials should reset sync_locked', async () => {
  const db = app.locals.db;
  db.prepare('UPDATE launchers SET sync_locked = 1 WHERE name = ?').run('xbox');

  const res = await makeFetch(app, '/api/launchers/xbox/credentials', {
    method: 'DELETE',
    headers: { Cookie: authCookie() },
  });

  assert.equal(res.status, 200);

  const row = db.prepare('SELECT sync_locked FROM launchers WHERE name = ?').get('xbox');
  assert.equal(row.sync_locked, 0, 'sync_locked should be reset when credentials removed');
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `cd backend && node --test tests/routes/launchers.test.js`
Expected: FAIL — 404 on unlock endpoint, sync_locked not reset on delete

- [ ] **Step 5: Add unlock endpoint**

In `backend/src/routes/launchers.js`, add before the `module.exports` line:

```javascript
// POST /api/launchers/:id/unlock-sync
router.post('/:id/unlock-sync', (req, res) => {
  const { id } = req.params;
  const launcher = LAUNCHER_MAP[id];

  if (!launcher) {
    return res.status(400).json({ error: `Unknown launcher: ${id}` });
  }

  const db = req.app.locals.db;
  const row = db.prepare('SELECT id FROM launchers WHERE name = ?').get(id);

  if (!row) {
    return res.status(404).json({ error: 'Launcher not configured' });
  }

  db.prepare('UPDATE launchers SET sync_locked = 0 WHERE name = ?').run(id);
  res.json({ success: true });
});
```

- [ ] **Step 6: Modify credential deletion to reset sync_locked**

In `backend/src/routes/launchers.js`, in the `DELETE /:id/credentials` handler (line 154-156), add `sync_locked = 0` to the UPDATE:

```javascript
db.prepare(
  'UPDATE launchers SET credentials_json = NULL, enabled = 0, last_sync_at = NULL, sync_locked = 0 WHERE name = ?'
).run(id);
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd backend && node --test tests/routes/launchers.test.js`
Expected: ALL PASS

- [ ] **Step 8: Commit**

```bash
git add backend/src/routes/launchers.js backend/tests/routes/launchers.test.js
git commit -m "feat: add unlock-sync endpoint and reset lock on credential deletion"
```

---

### Task 7: Available Endpoint Exposes `sync_locked`

**Files:**
- Modify: `backend/src/routes/launchers.js:26-39` (update /available handler)
- Test: `backend/tests/routes/launchers.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
it('GET /api/launchers/available should include sync_locked field', async () => {
  const res = await makeFetch(app, '/api/launchers/available', {
    headers: { Cookie: authCookie() },
  });
  const body = await res.json();
  const xbox = body.find(l => l.id === 'xbox');
  assert.ok(xbox, 'Xbox should be in the list');
  assert.ok('sync_locked' in xbox, 'sync_locked field should be present');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/routes/launchers.test.js`
Expected: FAIL — `sync_locked field should be present`

- [ ] **Step 3: Update the /available handler**

In `backend/src/routes/launchers.js`, modify the DB query (line 28-30) to include `sync_locked`:

```javascript
const dbLaunchers = db.prepare(
  'SELECT name, credentials_json IS NOT NULL as configured, priority, sync_locked FROM launchers'
).all();
```

Then update the result mapping (line 33-37) to include `sync_locked`:

```javascript
const result = AVAILABLE_LAUNCHERS.map(l => ({
  ...l,
  configured: !!(dbMap[l.id]?.configured),
  priority: dbMap[l.id]?.priority ?? 99,
  sync_locked: !!(dbMap[l.id]?.sync_locked),
}));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && node --test tests/routes/launchers.test.js`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/launchers.js backend/tests/routes/launchers.test.js
git commit -m "feat: expose sync_locked in launchers available endpoint"
```

---

### Task 8: Frontend — Settings Lock/Unlock UI

**Files:**
- Modify: `frontend/src/pages/Settings.jsx` (LaunchersTab component, lines 169-232)

- [ ] **Step 1: Add Lock import**

Add `Lock` to the lucide-react import (line 4):

```javascript
import { Loader2, RefreshCw, GripVertical, Lock } from 'lucide-react';
```

- [ ] **Step 2: Add unlock handler function**

In `LaunchersTab()`, add after the `removeLauncher` function (after line 96):

```javascript
async function unlockSync(name) {
  await fetch(`/api/launchers/${name}/unlock-sync`, { method: 'POST', credentials: 'same-origin' });
  queryClient.invalidateQueries({ queryKey: ['launchersAvailable'] });
}
```

- [ ] **Step 3: Update the launcher action buttons**

Replace the OTP/Sync button section (lines 203-217) with conditional rendering based on `sync_locked`:

```jsx
{l.sync_locked ? (
  <>
    <span className="flex items-center gap-1 px-3 py-1.5 bg-yellow-900/30 text-yellow-400 text-sm rounded">
      <Lock size={14} /> Locked
    </span>
    <button
      onClick={() => unlockSync(l.id)}
      className="flex items-center gap-1 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-sm rounded transition-colors"
    >
      Unlock
    </button>
  </>
) : isAwaitingOtp(l.id) ? (
  <button
    onClick={() => handleSyncClick(l)}
    className="flex items-center gap-1 px-3 py-1.5 bg-yellow-600 hover:bg-yellow-700 text-white text-sm rounded transition-colors"
  >
    Enter Code
  </button>
) : (
  <button
    onClick={() => handleSyncClick(l)}
    className="flex items-center gap-1 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-sm rounded transition-colors"
  >
    <RefreshCw size={14} /> Sync
  </button>
)}
```

Note: The `l.sync_locked` check wraps the existing OTP/Sync button logic. The Approve and Remove buttons remain outside this block and are always visible.

- [ ] **Step 4: Verify visually**

Open the app in the browser, go to Settings > Launchers. If Xbox is locked, you should see "Locked" indicator + Unlock button. If unlocked, the normal Sync button should appear.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/Settings.jsx
git commit -m "feat: show lock/unlock UI for sync-locked launchers"
```

---

### Task 9: Frontend — Update XboxApproval Confirmation Text

**Files:**
- Modify: `frontend/src/pages/XboxApproval.jsx:175`

- [ ] **Step 1: Update the confirmation dialog text**

In `frontend/src/pages/XboxApproval.jsx`, line 175, change:

```jsx
Delete {deleteCount} Xbox game{deleteCount !== 1 ? 's' : ''}? This cannot be undone (re-sync to recover).
```

to:

```jsx
Delete {deleteCount} Xbox game{deleteCount !== 1 ? 's' : ''}? This cannot be undone (unlock and re-sync to recover).
```

- [ ] **Step 2: Verify visually**

Open the Xbox Approval page, deselect some games, click Save, and verify the confirmation dialog shows the updated text.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/XboxApproval.jsx
git commit -m "fix: update approval confirmation text to mention unlock step"
```

---

### Task 10: Version Bump and Changelog

**Files:**
- Modify: `backend/package.json` (version)
- Modify: `frontend/package.json` (version)
- Modify: `CHANGELOG.md` (if it exists, otherwise skip)

- [ ] **Step 1: Bump version**

Update version in both `backend/package.json` and `frontend/package.json` from `1.10.0` to `1.11.0`.

- [ ] **Step 2: Run full test suite**

Run: `cd backend && node --test 'tests/**/*.test.js'`
Expected: ALL PASS

- [ ] **Step 3: Commit**

```bash
git add backend/package.json frontend/package.json
git commit -m "chore: bump version to 1.11.0 for sync lock feature"
```
