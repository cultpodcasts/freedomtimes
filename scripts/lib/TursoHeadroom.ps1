# Turso database-count guard (#limit, 31 Oct 2026). Dot-source, then call
# Assert-TursoDatabaseHeadroom before any Turso db-create of a backup/rollback branch.
# Runs `node scripts/turso-backup-retention.mjs --check-limit` (Turso Platform API, token from the
# environment; the token is never printed). At or above the threshold (default 95; plan limit 100)
# it throws with the operator command, so the deploy fails before Turso's own
# "maximum database count" error. With no Platform API token/org the check is skipped with a
# warning locally, and fails closed on GitHub Actions (AGENTS.md §6). Staging uses -Threshold 90 so
# staging churn stops before the production pre-migrate backup loses its headroom.

function Assert-TursoDatabaseHeadroom {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot,
        [int]$Threshold = 95,
        [string]$NodeCommand = "node"
    )
    $script = Join-Path $RepoRoot "scripts/turso-backup-retention.mjs"
    # Repo convention (Deploy-EnvironmentCommon.ps1): classify the native exit code ourselves, so
    # exit 4 reaches the operator message instead of a generic "ended with non-zero exit code".
    $PSNativeCommandUseErrorActionPreference = $false
    # A stale 0 must never pass the check (e.g. node missing under -ErrorAction Continue).
    $global:LASTEXITCODE = $null
    $output = @()
    try {
        $output = @(& $NodeCommand $script --check-limit --limit-threshold $Threshold 2>&1 | ForEach-Object { "$_" })
    }
    catch {
        throw "Turso database limit check could not run ($NodeCommand): $($_.Exception.Message). Nothing was created."
    }
    $code = $LASTEXITCODE
    if ($null -eq $code) {
        throw "Turso database limit check did not run ($NodeCommand gave no exit code). Nothing was created."
    }
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
