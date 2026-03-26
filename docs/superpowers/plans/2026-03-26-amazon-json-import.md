# Amazon JSON Import + PowerShell Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace SQLite-based Amazon import with JSON-based import, and provide a PowerShell script to decrypt/export Amazon Games entitlements on Windows.

**Architecture:** PowerShell script decrypts DPAPI blobs from Entitlements.sqlite → exports JSON → user uploads JSON → backend parses and previews → user approves → import.

**Tech Stack:** PowerShell, Node.js, Express/multer, React

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `tools/amazon-export.ps1` | Create | Decrypt DPAPI blobs, export JSON |
| `backend/src/services/launchers/amazon.js` | Modify | Replace parseGamesDb with parseGamesJson |
| `backend/src/routes/launchers.js` | Modify | Update preview endpoint for JSON |
| `frontend/src/pages/AmazonApproval.jsx` | Modify | Accept .json, update instructions |
| `backend/tests/services/launchers/amazon.test.js` | Rewrite | Test parseGamesJson |
| `backend/tests/routes/launchers.test.js` | Modify | Update preview test to send JSON |

---

### Task 1: PowerShell export script

**Files:**
- Create: `tools/amazon-export.ps1`

- [ ] **Step 1: Create the PowerShell script**

```powershell
# amazon-export.ps1 — Decrypt Amazon Games entitlements and export as JSON
# Run on the Windows machine where Amazon Games is installed.
# Usage: .\amazon-export.ps1 [-Path <path-to-Entitlements.sqlite>]

param(
    [string]$Path = "$env:LOCALAPPDATA\Amazon Games\Data\Entitlements.sqlite"
)

Add-Type -AssemblyName System.Security

if (-not (Test-Path $Path)) {
    Write-Error "Entitlements.sqlite not found at: $Path"
    exit 1
}

# Load SQLite interop
Add-Type -Path "$env:LOCALAPPDATA\Amazon Games\App\sqlite3.dll" -ErrorAction SilentlyContinue
$connectionString = "Data Source=$Path;Version=3;Read Only=True;"

try {
    [System.Reflection.Assembly]::LoadWithPartialName("System.Data.SQLite") | Out-Null
    $conn = New-Object System.Data.SQLite.SQLiteConnection($connectionString)
} catch {
    # Fallback: use Microsoft.Data.Sqlite if available
    try {
        Add-Type -AssemblyName Microsoft.Data.Sqlite
        $conn = New-Object Microsoft.Data.Sqlite.SqliteConnection("Data Source=$Path")
    } catch {
        Write-Error "No SQLite library found. Install System.Data.SQLite or run: Install-Package Microsoft.Data.Sqlite"
        exit 1
    }
}

$conn.Open()
$cmd = $conn.CreateCommand()
$cmd.CommandText = "SELECT key, value FROM game_entitlements"
$reader = $cmd.ExecuteReader()

$games = @()
$errors = 0

while ($reader.Read()) {
    $productId = $reader.GetString(0)
    $blob = $reader["value"]

    # Read blob bytes
    $ms = New-Object System.IO.MemoryStream
    $bufferSize = 8192
    $buffer = New-Object byte[] $bufferSize
    $stream = $reader.GetStream(1)
    while (($bytesRead = $stream.Read($buffer, 0, $bufferSize)) -gt 0) {
        $ms.Write($buffer, 0, $bytesRead)
    }
    $encryptedBytes = $ms.ToArray()
    $ms.Dispose()

    try {
        $decryptedBytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
            $encryptedBytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser
        )
        $jsonText = [System.Text.Encoding]::UTF8.GetString($decryptedBytes)
        $data = $jsonText | ConvertFrom-Json

        # Extract title — try common field names
        $title = $null
        if ($data.productTitle) { $title = $data.productTitle }
        elseif ($data.title) { $title = $data.title }
        elseif ($data.product_title) { $title = $data.product_title }

        if (-not $title) {
            # Log first unknown blob for debugging
            if ($errors -eq 0) {
                Write-Warning "Could not find title field. First decrypted blob:"
                Write-Warning $jsonText.Substring(0, [Math]::Min(500, $jsonText.Length))
            }
            $title = "Unknown ($productId)"
            $errors++
        }

        $games += @{
            productId = $productId
            title = $title
        }
    } catch {
        $errors++
        if ($errors -le 3) {
            Write-Warning "Failed to decrypt product $productId : $_"
        }
    }
}

$reader.Close()
$conn.Close()

$outputPath = Join-Path (Get-Location) "amazon-games.json"
$games | ConvertTo-Json -Depth 3 | Out-File -Encoding utf8 $outputPath

Write-Host "Exported $($games.Count) games to $outputPath ($errors errors)"
```

- [ ] **Step 2: Commit**

```bash
git add tools/amazon-export.ps1
git commit -m "feat(amazon): add PowerShell script to decrypt and export entitlements"
```

---

### Task 2: Replace parseGamesDb with parseGamesJson

**Files:**
- Modify: `backend/src/services/launchers/amazon.js`
- Rewrite: `backend/tests/services/launchers/amazon.test.js`

- [ ] **Step 1: Rewrite the unit tests for parseGamesJson**

Replace `backend/tests/services/launchers/amazon.test.js` entirely:

```javascript
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('Amazon parseGamesJson', () => {
  it('should parse a valid JSON array of games', () => {
    const { parseGamesJson } = require('../../../src/services/launchers/amazon');
    const json = JSON.stringify([
      { productId: 'aaa-bbb', title: 'Ghostwire: Tokyo' },
      { productId: 'ccc-ddd', title: 'Fallout 76' },
    ]);
    const games = parseGamesJson(Buffer.from(json));

    assert.ok(Array.isArray(games), 'should return an array');
    assert.equal(games.length, 2);
    assert.equal(games[0].title, 'Fallout 76');  // sorted alphabetically
    assert.equal(games[1].title, 'Ghostwire: Tokyo');
    assert.equal(games[0].launcher_game_id, 'ccc-ddd');
    assert.equal(games[1].launcher_game_id, 'aaa-bbb');
  });

  it('should skip entries without a title', () => {
    const { parseGamesJson } = require('../../../src/services/launchers/amazon');
    const json = JSON.stringify([
      { productId: 'aaa', title: 'Valid Game' },
      { productId: 'bbb' },
      { productId: 'ccc', title: '' },
    ]);
    const games = parseGamesJson(Buffer.from(json));
    assert.equal(games.length, 1);
    assert.equal(games[0].title, 'Valid Game');
  });

  it('should throw on invalid JSON', () => {
    const { parseGamesJson } = require('../../../src/services/launchers/amazon');
    assert.throws(() => parseGamesJson(Buffer.from('not json')), /Failed to parse/);
  });

  it('should throw on non-array JSON', () => {
    const { parseGamesJson } = require('../../../src/services/launchers/amazon');
    assert.throws(() => parseGamesJson(Buffer.from('{"foo":"bar"}')), /Expected a JSON array/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && node --test tests/services/launchers/amazon.test.js`
Expected: FAIL — parseGamesJson not found

- [ ] **Step 3: Replace parseGamesDb with parseGamesJson in amazon.js**

Replace `backend/src/services/launchers/amazon.js` entirely:

```javascript
const BaseLauncher = require('./base');

/**
 * Parse an Amazon Games JSON export file.
 * Expected format: [{ productId: "uuid", title: "Game Name" }, ...]
 * Generated by tools/amazon-export.ps1
 */
function parseGamesJson(buffer) {
  let data;
  try {
    data = JSON.parse(buffer.toString('utf8'));
  } catch (err) {
    throw new Error('Failed to parse amazon-games.json: ' + err.message);
  }

  if (!Array.isArray(data)) {
    throw new Error('Expected a JSON array of games');
  }

  const games = data
    .filter(entry => entry.title && entry.title.trim().length > 0)
    .map(entry => ({
      launcher_game_id: entry.productId || entry.title,
      title: entry.title.trim(),
    }));

  games.sort((a, b) => a.title.localeCompare(b.title));
  return games;
}

class AmazonLauncher extends BaseLauncher {
  async fetchOwnedGames() {
    throw new Error('Amazon Games uses file import only — no API sync available.');
  }
}

module.exports = AmazonLauncher;
module.exports.parseGamesJson = parseGamesJson;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && node --test tests/services/launchers/amazon.test.js`
Expected: All 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/launchers/amazon.js backend/tests/services/launchers/amazon.test.js
git commit -m "feat(amazon): replace SQLite parser with JSON parser"
```

---

### Task 3: Update preview endpoint and route test

**Files:**
- Modify: `backend/src/routes/launchers.js:47-64`
- Modify: `backend/tests/routes/launchers.test.js` (preview test)

- [ ] **Step 1: Update the preview endpoint**

In `backend/src/routes/launchers.js`, replace the preview route (lines 47-64):

```javascript
// POST /api/launchers/amazon/preview — upload amazon-games.json, return parsed game list (no DB writes)
router.post('/amazon/preview', uploadCache.single('games_json'), (req, res) => {
  const file = req.file;
  if (!file) {
    return res.status(400).json({ error: 'games_json file is required' });
  }

  const { parseGamesJson } = require('../services/launchers/amazon');

  let games;
  try {
    games = parseGamesJson(file.buffer);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  res.json({ games });
});
```

- [ ] **Step 2: Update the preview route test**

In `backend/tests/routes/launchers.test.js`, replace the amazon preview test with:

```javascript
  // Amazon Games: preview should parse JSON and return game list without DB writes
  it('POST /api/launchers/amazon/preview should return parsed games', async () => {
    const jsonData = JSON.stringify([
      { productId: 'amzn1.preview.aaa', title: 'Preview Game' },
      { productId: 'amzn1.preview.bbb', title: 'Another Game' },
    ]);
    const fileBuffer = Buffer.from(jsonData);

    const boundary = '----TestBoundary' + Date.now();
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="games_json"; filename="amazon-games.json"\r\nContent-Type: application/json\r\n\r\n`),
      fileBuffer,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const res = await makeFetch(app, '/api/launchers/amazon/preview', {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        Cookie: authCookie(),
      },
      body,
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.games), 'should return games array');
    assert.equal(data.games.length, 2);
    assert.equal(data.games[0].title, 'Another Game');  // sorted
    assert.equal(data.games[1].title, 'Preview Game');

    // Verify no DB writes happened
    const db = app.locals.db;
    const amazonRow = db.prepare("SELECT id FROM launchers WHERE name = 'amazon'").get();
    if (amazonRow) {
      const editions = db.prepare('SELECT COUNT(*) as c FROM game_editions WHERE launcher_id = ?').get(amazonRow.id);
      assert.equal(editions.c, 0, 'preview should not write to game_editions');
    }
  });
```

- [ ] **Step 3: Run tests to verify**

Run: `cd backend && node --test tests/routes/launchers.test.js --test-name-pattern "amazon"`
Expected: All amazon tests pass

- [ ] **Step 4: Commit**

```bash
git add backend/src/routes/launchers.js backend/tests/routes/launchers.test.js
git commit -m "feat(amazon): update preview endpoint for JSON import"
```

---

### Task 4: Update frontend AmazonApproval page

**Files:**
- Modify: `frontend/src/pages/AmazonApproval.jsx`

- [ ] **Step 1: Update file upload and instructions**

Three changes in `AmazonApproval.jsx`:

1. Change form field from `games_db` to `games_json` (line 24)
2. Change file accept from `.db` to `.json` (in the input element)
3. Update the instructions text to reference the PowerShell script

Line 24: `formData.append('games_json', file);`

Instructions (around line 95-98):
```jsx
      <p className="text-sm text-gray-400 mb-4">
        First, run <code className="text-gray-300">amazon-export.ps1</code> on your Windows machine to
        export your library. Then upload the generated{' '}
        <code className="text-gray-300">amazon-games.json</code> file here.
      </p>
```

File input (around line 113):
```jsx
            accept=".json"
```

Upload label text: `'Select amazon-games.json file'`

- [ ] **Step 2: Verify frontend builds**

Run: `cd frontend && npx vite build 2>&1 | tail -5`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/AmazonApproval.jsx
git commit -m "feat(amazon): update frontend for JSON import with PowerShell instructions"
```

---

### Task 5: Version bump + full verification

- [ ] **Step 1: Bump version to v1.16.1**

In `backend/package.json`, change version to `"1.16.1"`.

- [ ] **Step 2: Run full backend test suite**

Run: `cd backend && node --test tests/**/*.test.js`
Expected: All pass (except pre-existing setup.test.js QR failure)

- [ ] **Step 3: Commit**

```bash
git add backend/package.json
git commit -m "chore: bump version to v1.16.1 for Amazon JSON import"
```
