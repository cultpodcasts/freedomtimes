# Turso database-count guard (#limit, 31 Oct 2026). Dot-source, then call
# Assert-TursoDatabaseHeadroom before any Turso db-create of a backup/rollback branch.
# Runs `node scripts/turso-backup-retention.mjs --check-limit` (Turso Platform API, token from the
# environment; the token is never printed). At or above the threshold (default 95; plan limit 100)
# it throws with the operator command, so the deploy fails before Turso's own
# "maximum database count" error. With no Platform API token/org in the environment the check is
# skipped with a warning (local CLI-only sessions).

function Assert-TursoDatabaseHeadroom {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot,
        [int]$Threshold = 95,
        [string]$NodeCommand = "node"
    )
    $script = Join-Path $RepoRoot "scripts/turso-backup-retention.mjs"
    $output = & $NodeCommand $script --check-limit --limit-threshold $Threshold 2>&1 | ForEach-Object { "$_" }
    $code = $LASTEXITCODE
    foreach ($line in $output) { Write-Host $line }
    if ($code -eq 4) {
        $detail = ($output | Where-Object { $_ -match 'at or above' } | Select-Object -Last 1)
        if ([string]::IsNullOrWhiteSpace($detail)) {
            $detail = "Turso database count is at or above $Threshold. Jon: on the MSI run node scripts/turso-backup-retention.mjs --delete --expect-count N (N from the dry-run)."
        }
        throw "TURSO DATABASE LIMIT: $detail"
    }
    if ($code -ne 0) {
        throw "Turso database limit check failed (exit $code). Nothing was created."
    }
}
