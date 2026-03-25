# Two-Phase 2FA Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the pre-sync OTP modal with a two-phase flow where Phase 1 triggers the login (and 2FA challenge), and Phase 2 collects the code and completes the sync.

**Architecture:** Launchers throw `OTP_REQUIRED:<instruction>` when 2FA is needed without a code. The sync engine catches this and marks the job as `awaiting_otp`. The frontend polls sync status, detects `awaiting_otp`, shows an "Enter Code" button, and submits the code to a new `/otp` endpoint which resumes the sync. Humble skips the initial login on Phase 2 (to avoid re-triggering the email). GOG does a full re-auth on Phase 2 (stateless).

**Tech Stack:** React (frontend), Express/SQLite (backend)

---

### Task 1: Backend — Launcher OTP_REQUIRED Errors

**Files:**
- Modify: `backend/src/services/launchers/humble.js`
- Modify: `backend/src/services/launchers/gog.js`

- [ ] **Step 1: Update Humble authenticate() with two-phase paths**

In `backend/src/services/launchers/humble.js`, replace the `authenticate` method. The key change: when `otp_code` is present, skip the initial guard-less POST and go straight to submitting with the guard code. When absent and 2FA is required, throw `OTP_REQUIRED:`.

Find the entire `authenticate(credentials)` method (lines 13-51) and replace with:

```javascript
  async authenticate(credentials) {
    const { username, password, otp_code } = credentials;

    // Phase 2: if we already have a code, submit it directly
    // (skip the guard-less POST to avoid triggering a second email)
    if (otp_code) {
      const guardRes = await axios.post(
        'https://www.humblebundle.com/processlogin',
        new URLSearchParams({ username, password, guard: otp_code }),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          maxRedirects: 0,
          validateStatus: (status) => status < 500,
        }
      );

      const guardData = guardRes.data;
      if (!guardData || !guardData.success) {
        const errMsg = guardData?.errors ? JSON.stringify(guardData.errors) : 'Invalid verification code';
        throw new Error(`Humble Bundle 2FA failed: ${errMsg}`);
      }

      return this._extractSession(guardRes);
    }

    // Phase 1: attempt login without guard — triggers email if 2FA enabled
    const res = await axios.post(
      'https://www.humblebundle.com/processlogin',
      new URLSearchParams({ username, password, guard: '' }),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        maxRedirects: 0,
        validateStatus: (status) => status < 500,
      }
    );

    const data = res.data;

    // 2FA required — Humble has sent the email, signal the sync engine
    if (data && data.humble_guard_required && !data.success) {
      throw new Error('OTP_REQUIRED:Enter the code emailed to you');
    }

    // No 2FA needed — check for direct success
    if (data && data.success) {
      return this._extractSession(res);
    }

    // Login failed for other reasons
    const errMsg = data?.errors ? JSON.stringify(data.errors) : 'Login failed';
    throw new Error(`Humble Bundle login failed: ${errMsg}`);
  }
```

- [ ] **Step 2: Update GOG authenticate() with OTP_REQUIRED throw**

In `backend/src/services/launchers/gog.js`, find the block where 2FA is detected without a code (around line 84-87):

```javascript
      if (!otp_code) {
        throw new Error('GOG requires an authenticator code. Sync this launcher individually with the code from your authenticator app.');
      }
```

Replace with:
```javascript
      if (!otp_code) {
        throw new Error('OTP_REQUIRED:Enter the code from your authenticator app');
      }
```

- [ ] **Step 3: Commit**

```bash
git add backend/src/services/launchers/humble.js backend/src/services/launchers/gog.js
git commit -m "feat: launchers throw OTP_REQUIRED for two-phase 2FA flow"
```

---

### Task 2: Backend — Sync Engine Handles awaiting_otp

**Files:**
- Modify: `backend/src/services/syncEngine.js`

- [ ] **Step 1: Add OTP_REQUIRED detection in the catch block**

In `backend/src/services/syncEngine.js`, find the catch block (lines 159-166):

```javascript
  } catch (err) {
    const completedAt = new Date().toISOString();
    db.prepare(
      'UPDATE sync_jobs SET status = ?, completed_at = ?, error_message = ? WHERE id = ?'
    ).run('failed', completedAt, err.message, jobId);
    console.error(`[Sync] ${launcherName} failed:`, err.message);
    return jobId;
  }
```

Replace with:
```javascript
  } catch (err) {
    if (err.message && err.message.startsWith('OTP_REQUIRED:')) {
      // Two-phase 2FA: launcher needs a code — park the job
      const instruction = err.message.substring('OTP_REQUIRED:'.length);
      db.prepare(
        'UPDATE sync_jobs SET status = ?, error_message = ? WHERE id = ?'
      ).run('awaiting_otp', instruction, jobId);
      console.log(`[Sync] ${launcherName} awaiting OTP code`);
      return jobId;
    }

    const completedAt = new Date().toISOString();
    db.prepare(
      'UPDATE sync_jobs SET status = ?, completed_at = ?, error_message = ? WHERE id = ?'
    ).run('failed', completedAt, err.message, jobId);
    console.error(`[Sync] ${launcherName} failed:`, err.message);
    return jobId;
  }
```

- [ ] **Step 2: Add awaiting_otp handling in syncAll**

In `syncAll()` (lines 182-188), update the status check:

```javascript
    if (job.status === 'failed') {
      failed.push(launcher.name);
    } else if (job.games_found === 0) {
      skipped.push(launcher.name);
    } else {
      succeeded.push(launcher.name);
    }
```

Replace with:
```javascript
    if (job.status === 'failed') {
      failed.push(launcher.name);
    } else if (job.status === 'awaiting_otp') {
      // 2FA launchers park here — not a failure or skip, just waiting for user input
      continue;
    } else if (job.games_found === 0) {
      skipped.push(launcher.name);
    } else {
      succeeded.push(launcher.name);
    }
```

- [ ] **Step 3: Commit**

```bash
git add backend/src/services/syncEngine.js
git commit -m "feat: sync engine parks jobs as awaiting_otp for two-phase 2FA"
```

---

### Task 3: Backend — OTP Submit Endpoint

**Files:**
- Modify: `backend/src/routes/sync.js`

- [ ] **Step 1: Add the OTP endpoint and window constant**

In `backend/src/routes/sync.js`, add the OTP window constant at the top (after line 3) and the new route before the `/:launcherName` catch-all (after the `/status` route, before line 34):

After line 3, add:
```javascript
const OTP_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
```

After the `/status` GET route (after line 32), add:
```javascript

// POST /api/sync/:launcherName/otp — MUST be before /:launcherName to avoid route conflicts
router.post('/:launcherName/otp', (req, res) => {
  const db = req.app.locals.db;
  const { launcherName } = req.params;
  const { otp_code } = req.body || {};

  if (!otp_code) {
    return res.status(400).json({ error: 'otp_code is required' });
  }

  // Find the launcher
  const launcher = db.prepare('SELECT id FROM launchers WHERE name = ?').get(launcherName);
  if (!launcher) {
    return res.status(404).json({ error: `Launcher not found: ${launcherName}` });
  }

  // Find the latest sync job for this launcher
  const job = db.prepare(
    'SELECT id, status, started_at FROM sync_jobs WHERE launcher_id = ? ORDER BY id DESC LIMIT 1'
  ).get(launcher.id);

  if (!job || job.status !== 'awaiting_otp') {
    return res.status(400).json({ error: 'No pending OTP request — click Sync to start' });
  }

  // Check 5-minute window
  const elapsed = Date.now() - new Date(job.started_at).getTime();
  if (elapsed > OTP_WINDOW_MS) {
    return res.status(400).json({ error: 'OTP window expired — click Sync to restart' });
  }

  // Mark the old awaiting_otp job as superseded
  db.prepare('UPDATE sync_jobs SET status = ?, completed_at = ? WHERE id = ?')
    .run('failed', new Date().toISOString(), job.id);

  // Fire and forget — resume sync with the code
  syncLauncher(launcherName, db, otp_code).catch(err =>
    console.error(`[Sync] ${launcherName} OTP sync error:`, err.message)
  );
  res.json({ message: `Sync resumed for ${launcherName}` });
});
```

- [ ] **Step 2: Add OTP_WINDOW_MS to the status response**

In the `/status` GET route, update the response to include the window duration. Find:

```javascript
  res.json(jobs);
```

Replace with:
```javascript
  res.json({ jobs, otp_window_ms: OTP_WINDOW_MS });
```

- [ ] **Step 3: Commit**

```bash
git add backend/src/routes/sync.js
git commit -m "feat: add OTP submit endpoint and window constant for two-phase 2FA"
```

---

### Task 4: Frontend — Two-Phase OTP Flow

**Files:**
- Modify: `frontend/src/pages/Settings.jsx`

- [ ] **Step 1: Update sync status parsing to handle new response shape**

The status response is changing from an array to `{ jobs, otp_window_ms }`. In `frontend/src/pages/Settings.jsx`, find the sync status query and statusMap (around lines 46-53):

```javascript
  const { data: syncStatus } = useQuery({
    queryKey: ['syncStatus'],
    queryFn: () => fetch('/api/sync/status', { credentials: 'same-origin' }).then(r => r.json()),
    refetchInterval: 10000,
  });

  const statusMap = {};
  (syncStatus || []).forEach(j => { statusMap[j.launcher_name] = j; });
```

Replace with:
```javascript
  const { data: syncStatusData } = useQuery({
    queryKey: ['syncStatus'],
    queryFn: () => fetch('/api/sync/status', { credentials: 'same-origin' }).then(r => r.json()),
    refetchInterval: 10000,
  });

  const syncJobs = syncStatusData?.jobs || syncStatusData || [];
  const otpWindowMs = syncStatusData?.otp_window_ms || 300000;

  const statusMap = {};
  syncJobs.forEach(j => { statusMap[j.launcher_name] = j; });
```

Note: `syncStatusData || []` fallback handles backwards compatibility if the response is still a plain array.

- [ ] **Step 2: Replace handleSyncClick and submitOtp with two-phase logic**

Find the existing `handleSyncClick`, `fireSyncRequest`, and `submitOtp` functions (lines 55-79):

```javascript
  function handleSyncClick(launcher) {
    if (launcher.otp_supported && launcher.configured) {
      setOtpPrompt(launcher);
      setOtpCode('');
    } else {
      fireSyncRequest(launcher.id);
    }
  }

  async function fireSyncRequest(name, code) {
    const opts = { method: 'POST', credentials: 'same-origin' };
    if (code) {
      opts.headers = { 'Content-Type': 'application/json' };
      opts.body = JSON.stringify({ otp_code: code });
    }
    await fetch(`/api/sync/${name}`, opts);
    queryClient.invalidateQueries({ queryKey: ['syncStatus'] });
  }

  function submitOtp() {
    if (!otpPrompt || !otpCode.trim()) return;
    fireSyncRequest(otpPrompt.id, otpCode.trim());
    setOtpPrompt(null);
    setOtpCode('');
  }
```

Replace with:
```javascript
  function isAwaitingOtp(launcherName) {
    const status = statusMap[launcherName];
    if (!status || status.status !== 'awaiting_otp') return false;
    const elapsed = Date.now() - new Date(status.started_at).getTime();
    return elapsed < otpWindowMs;
  }

  function handleSyncClick(launcher) {
    // If already awaiting OTP, show the code modal instead of starting a new sync
    if (isAwaitingOtp(launcher.id)) {
      setOtpPrompt({ ...launcher, otp_instruction: statusMap[launcher.id]?.error_message });
      setOtpCode('');
      return;
    }
    // Always fire sync immediately — backend handles 2FA detection
    fetch(`/api/sync/${launcher.id}`, { method: 'POST', credentials: 'same-origin' });
    queryClient.invalidateQueries({ queryKey: ['syncStatus'] });
  }

  async function submitOtp() {
    if (!otpPrompt || !otpCode.trim()) return;
    await fetch(`/api/sync/${otpPrompt.id}/otp`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ otp_code: otpCode.trim() }),
    });
    setOtpPrompt(null);
    setOtpCode('');
    queryClient.invalidateQueries({ queryKey: ['syncStatus'] });
  }
```

- [ ] **Step 3: Add "Enter Code" button to launcher rows**

Find the Sync button in the configured launcher buttons area (around line 183):

```jsx
                <button
                  onClick={() => handleSyncClick(l)}
                  className="flex items-center gap-1 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-sm rounded transition-colors"
                >
                  <RefreshCw size={14} /> Sync
                </button>
```

Replace with:
```jsx
                {isAwaitingOtp(l.id) ? (
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

- [ ] **Step 4: Update the OTP modal to use instruction from sync status**

The existing modal already uses `otpPrompt.otp_instruction`. The `handleSyncClick` function now sets this from `statusMap[launcher.id]?.error_message`, so no change is needed to the modal JSX itself.

- [ ] **Step 5: Update the status display for awaiting_otp**

Find the status text area in the launcher row (around line 172-180). The existing status display shows colored text for `success`, `failed`, and other statuses. Add explicit handling for `awaiting_otp`. Find:

```jsx
                  {status?.status && l.configured && l.implemented && (
                    <span className={`ml-2 ${status.status === 'success' ? 'text-green-400' : status.status === 'failed' ? 'text-red-400' : 'text-yellow-400'}`}>
                      ({status.status})
                    </span>
                  )}
```

Replace with:
```jsx
                  {status?.status && l.configured && l.implemented && (
                    <span className={`ml-2 ${status.status === 'success' ? 'text-green-400' : status.status === 'failed' ? 'text-red-400' : 'text-yellow-400'}`}>
                      ({status.status === 'awaiting_otp' ? 'waiting for code' : status.status})
                    </span>
                  )}
```

- [ ] **Step 6: Test in browser**

1. Click Sync on Humble — verify sync starts immediately (no modal)
2. After a few seconds (up to 10s poll interval), verify "Enter Code" button appears in yellow
3. Verify status shows "(waiting for code)"
4. Click "Enter Code" — verify OTP modal appears with "Enter the code emailed to you"
5. Enter code, click Sync — verify sync resumes
6. Close modal, refresh page — verify "Enter Code" button reappears
7. Wait 5+ minutes — verify "Enter Code" button disappears
8. Click Sync on Steam — verify sync fires immediately, no "Enter Code" button
9. Repeat tests for GOG

- [ ] **Step 7: Commit**

```bash
git add frontend/src/pages/Settings.jsx
git commit -m "feat: two-phase 2FA with Enter Code button and status-driven OTP modal"
```

---

### Task 5: Version Bump

**Files:**
- Modify: `backend/package.json`
- Modify: `frontend/package.json`

- [ ] **Step 1: Bump version**

Bump from 1.9.0 to 1.9.1 (bugfix) in both `backend/package.json` and `frontend/package.json`.

- [ ] **Step 2: Commit**

```bash
git add backend/package.json frontend/package.json
git commit -m "chore: bump version to 1.9.1 for two-phase 2FA fix"
```
