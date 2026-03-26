# Ubisoft Cache Import Sync Lock — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent Ubisoft sync from removing cache-imported games by setting `sync_locked = 1` after cache import.

**Architecture:** Add one line to the existing cache import endpoint to set the launcher's `sync_locked` flag, identical to the Xbox approval flow. Add a regression test.

**Tech Stack:** Node.js, better-sqlite3, node:test

---

### Task 1: Write regression test

**Files:**
- Modify: `backend/tests/routes/launchers.test.js:322` (before closing `});`)

- [ ] **Step 1: Write the failing test**

Add before line 323 (`});`) in the test file:

```javascript
  // REGRESSION: Ubisoft cache-imported games were removed when a subsequent
  // GraphQL sync ran, because the sync engine marked API-missing games as
  // unowned. Fix: cache import now locks the launcher like Xbox approval does.
  it('regression: ubisoft cache import should set sync_locked', async () => {
    const db = app.locals.db;
    const { encrypt } = require('../../src/utils/encrypt');
    const creds = encrypt(JSON.stringify({ email: 'test@test.com', password: 'test' }));

    // Ensure ubisoft launcher exists and is unlocked
    db.prepare(
      'INSERT OR REPLACE INTO launchers (name, display_name, enabled, credentials_json, sync_locked) VALUES (?, ?, 1, ?, 0)'
    ).run('ubisoft', 'Ubisoft Connect', creds);

    const before = db.prepare('SELECT sync_locked FROM launchers WHERE name = ?').get('ubisoft');
    assert.equal(before.sync_locked, 0, 'sync_locked should start at 0');

    // Build minimal valid cache files (configurations YAML + ownership protobuf)
    const configYaml = `root:
  start_game:
    online:
      executables:
        - path:
            relative: game.exe
  name: Test Game
  is_dlc: false
  space_id: space-1
  uplay_id: 100`;
    const ownershipBuf = Buffer.from(JSON.stringify({ ownedProducts: [100] }));

    const FormData = (await import('node:buffer')).Buffer;
    const boundary = '----TestBoundary' + Date.now();
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="configurations"; filename="configurations"',
      'Content-Type: application/octet-stream',
      '',
      configYaml,
      `--${boundary}`,
      'Content-Disposition: form-data; name="ownership"; filename="ownership"',
      'Content-Type: application/octet-stream',
      '',
      ownershipBuf.toString(),
      `--${boundary}--`,
    ].join('\r\n');

    const res = await makeFetch(app, '/api/launchers/ubisoft/import-cache', {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        Cookie: authCookie(),
      },
      body,
    });

    assert.equal(res.status, 200, 'Cache import should succeed');

    const after = db.prepare('SELECT sync_locked FROM launchers WHERE name = ?').get('ubisoft');
    assert.equal(after.sync_locked, 1, 'sync_locked should be 1 after cache import');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/routes/launchers.test.js --test-name-pattern "ubisoft cache import should set sync_locked"`
Expected: FAIL — `sync_locked` is still 0 after import

### Task 2: Implement the fix

**Files:**
- Modify: `backend/src/routes/launchers.js:93` (after `importGames(games);`)

- [ ] **Step 3: Add sync_locked after import**

After line 93 (`importGames(games);`), add:

```javascript
  // Lock sync to prevent API sync from removing cache-imported games
  db.prepare('UPDATE launchers SET sync_locked = 1 WHERE id = ?').run(launcher.id);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && node --test tests/routes/launchers.test.js --test-name-pattern "ubisoft cache import should set sync_locked"`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `cd backend && node --test tests/routes/launchers.test.js`
Expected: All tests pass

### Task 3: Version bump, changelog, and commit

- [ ] **Step 6: Bump version to v1.15.5**
- [ ] **Step 7: Update CHANGELOG.md**
- [ ] **Step 8: Commit**

```bash
git add backend/src/routes/launchers.js backend/tests/routes/launchers.test.js
git commit -m "fix: lock ubisoft sync after cache import to preserve imported games"
```
