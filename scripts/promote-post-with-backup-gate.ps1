<#
.SYNOPSIS
  Mandatory Step 0 wrapper: verified Worker-resolved production backup, then promote.

.DESCRIPTION
  If no .release/rollback-branches metadata with verification.pass=true (24h) exists,
  creates one via backup-production-emdash.ps1 (Turso prod-backup-YYYYMMDD-HHMMSS +
  local emdash-production-<stamp>.db + agents log prod-emdash-<stamp>.json).
  Then runs promote-post-staging-to-production.mjs.

.EXAMPLE
  pwsh ./scripts/promote-post-with-backup-gate.ps1 -Collection posts -Slug weekly-summary-6-september-2026 -AllowProduction
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Slug,
    [string]$Collection = "posts",
    [switch]$AllowProduction,
    [switch]$SkipBackupRefresh
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $AllowProduction) {
    throw "Refusing production promote without -AllowProduction."
}

$repoRoot = Split-Path $PSScriptRoot -Parent
Push-Location $repoRoot
try {
    $verifyScript = Join-Path $repoRoot "web/scripts/verify-production-emdash-backup.mjs"
    $gate = & node $verifyScript --check-metadata auto --max-age-hours 24
    $gateExit = $LASTEXITCODE
    if ($gate) { $gate | ForEach-Object { $_ } }

    if ($gateExit -ne 0) {
        if ($SkipBackupRefresh) {
            throw "No fresh verified production backup, and -SkipBackupRefresh was set. Run backup-production-emdash.ps1 first."
        }
        Write-Host "No fresh verified backup — creating Worker-resolved production checkpoint…" -ForegroundColor Cyan
        & (Join-Path $PSScriptRoot "backup-production-emdash.ps1") -AllowProduction -Notes "pre-promote backup gate"
        if ($LASTEXITCODE -ne 0) {
            throw "backup-production-emdash.ps1 failed (exit $LASTEXITCODE). Promote refused."
        }
    }
    else {
        Write-Host "Using existing verified production backup metadata (<24h)." -ForegroundColor Green
    }

    Write-Host "Promoting $Collection/$Slug (push notifications may fire)…" -ForegroundColor Yellow
    & node (Join-Path $repoRoot "web/scripts/promote-post-staging-to-production.mjs") $Collection $Slug --i-understand-production
    if ($LASTEXITCODE -ne 0) {
        throw "promote-post-staging-to-production.mjs failed (exit $LASTEXITCODE)"
    }
}
finally {
    Pop-Location
}
