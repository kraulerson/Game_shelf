# amazon-export.ps1 - Decrypt Amazon Games entitlements and export as JSON
# Run on the Windows machine where Amazon Games is installed.
# Usage: .\amazon-export.ps1 [-Path <path-to-Entitlements.sqlite>]
#
# Requires: Amazon Games app installed (for SQLite library)
# Output: amazon-games.json in the current directory

param(
    [string]$Path = "$env:LOCALAPPDATA\Amazon Games\Data\Entitlements.sqlite"
)

Add-Type -AssemblyName System.Security

if (-not (Test-Path $Path)) {
    Write-Error "Entitlements.sqlite not found at: $Path"
    Write-Error "Specify the path with: .\amazon-export.ps1 -Path 'C:\path\to\Entitlements.sqlite'"
    exit 1
}

# Try to load a SQLite library
$conn = $null
try {
    [System.Reflection.Assembly]::LoadWithPartialName("System.Data.SQLite") | Out-Null
    $conn = New-Object System.Data.SQLite.SQLiteConnection("Data Source=$Path;Version=3;Read Only=True;")
} catch {
    try {
        Add-Type -AssemblyName Microsoft.Data.Sqlite -ErrorAction Stop
        $conn = New-Object Microsoft.Data.Sqlite.SqliteConnection("Data Source=$Path")
    } catch {
        Write-Error "No SQLite library found. Install with: Install-Package System.Data.SQLite"
        exit 1
    }
}

$conn.Open()
$cmd = $conn.CreateCommand()
$cmd.CommandText = "SELECT key, value FROM game_entitlements"
$reader = $cmd.ExecuteReader()

$games = @()
$errors = 0
$firstBlob = $true

while ($reader.Read()) {
    $productId = $reader.GetString(0)

    # Read blob bytes into array
    $stream = $reader.GetStream(1)
    $ms = New-Object System.IO.MemoryStream
    $stream.CopyTo($ms)
    $encryptedBytes = $ms.ToArray()
    $ms.Dispose()

    try {
        $decryptedBytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
            $encryptedBytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser
        )
        $jsonText = [System.Text.Encoding]::UTF8.GetString($decryptedBytes)

        # Log first decrypted blob for debugging
        if ($firstBlob) {
            Write-Host "Sample decrypted data (first entry):"
            Write-Host ($jsonText.Substring(0, [Math]::Min(500, $jsonText.Length)))
            Write-Host ""
            $firstBlob = $false
        }

        $data = $jsonText | ConvertFrom-Json

        # Extract title - try common field names
        $title = $null
        if ($data.productTitle) { $title = $data.productTitle }
        elseif ($data.title) { $title = $data.title }
        elseif ($data.product_title) { $title = $data.product_title }
        elseif ($data.ProductTitle) { $title = $data.ProductTitle }

        if (-not $title) {
            if ($errors -eq 0) {
                Write-Warning "Could not find title field in decrypted data. Check sample output above."
            }
            $title = "Unknown ($productId)"
            $errors++
        }

        $games += [PSCustomObject]@{
            productId = $productId
            title     = $title
        }
    } catch {
        $errors++
        if ($errors -le 3) {
            Write-Warning "Failed to decrypt product ${productId}: $_"
        }
    }
}

$reader.Close()
$conn.Close()

if ($games.Count -eq 0) {
    Write-Error "No games found. Check that you are running this on the correct Windows account."
    exit 1
}

$outputPath = Join-Path (Get-Location) "amazon-games.json"
$games | ConvertTo-Json -Depth 3 | Out-File -Encoding utf8 $outputPath

Write-Host ""
Write-Host "Exported $($games.Count) games to $outputPath"
if ($errors -gt 0) {
    Write-Warning "$errors entries had errors (see warnings above)"
}
Write-Host "Upload this file to Gameshelf: Settings > Amazon Games > Import Database"
