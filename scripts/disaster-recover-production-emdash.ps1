<#
.SYNOPSIS
  Non-destructive-first disaster recovery for production EmDash Turso.

.DESCRIPTION
  Safety principle: do NOT default to restoring a backup onto named production
  (overwrites current prod state — knee-jerk, can destroy evidence / newer rows).

  Preferred order (this script):
    1) Identify -FromBranch (verified prod-backup-* NEW backups, or legacy
       prod-rollback-* restore sources, or another known-good Turso DB)
    2) Create a safety branch/export of the **current** Worker DB first
       (that NEW safety backup is named prod-backup-YYYYMMDD-HHMMSS)
    3) Retarget production Worker TURSO_* secrets to -FromBranch (or a fresh --from-db clone)
    4) Print verification probes (apex + sample posts)

  Named production DB is left intact unless -OverwriteNamedProduction (dangerous).
  NEW backups are always prod-backup-*. Legacy prod-rollback-* branches remain valid
  restore sources. Never treat a work/scratch name (prod-work-embeds-…) as the
  backup artifact name — that is a possible *source*, not the backup label.

.EXAMPLE
  pwsh ./scripts/disaster-recover-production-emdash.ps1 -AllowProduction -FromBranch prod-backup-20260908-140000

.EXAMPLE
  pwsh ./scripts/disaster-recover-production-emdash.ps1 -AllowProduction -FromBranch prod-rollback-20260907-163120

.EXAMPLE
  pwsh ./scripts/disaster-recover-production-emdash.ps1 -AllowProduction -FromBranch prod-work-embeds-20260729-183444 -CloneToNewName prod-recovery-20260907-180000
#>
[CmdletBinding()]
param(
    [switch]$AllowProduction,
    [Parameter(Mandatory = $true)]
    [string]$FromBranch,
    [string]$CloneToNewName,
    [string]$TursoGroup = "freedomtimes-production",
    [string]$Organization = "cultpodcasts",
    [string]$HostSuffix,
    [switch]$OverwriteNamedProduction,
    [string]$NamedProductionDatabase = "freedomtimes-emdash-production",
    [switch]$SkipSafetyBackup,
    [switch]$DryRun,
    [switch]$UseNativeTurso,
    [string[]]$ProbePaths = @("/", "/posts/weekly-summary-1-september-2026", "/posts/weekly-summary-10-august-2026")
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $AllowProduction) {
    throw "Refusing production EmDash disaster recovery without -AllowProduction."
}

if ($OverwriteNamedProduction) {
    Write-Warning "DANGEROUS: -OverwriteNamedProduction will clone verified-good onto '$NamedProductionDatabase' (destructive to that named DB's current contents via replace semantics — prefer retarget Worker instead)."
}

function Test-CommandAvailable {
    param([string]$CommandName)
    return $null -ne (Get-Command $CommandName -ErrorAction SilentlyContinue)
}

function Escape-BashSingleQuoted {
    param([string]$Value)
    return "'" + ($Value -replace "'", "'\''") + "'"
}

function Invoke-External {
    param(
        [string]$FilePath,
        [string[]]$Arguments,
        [switch]$CaptureOutput,
        [switch]$AllowFailure
    )
    if ($CaptureOutput) {
        $lines = & $FilePath @Arguments 2>&1
        $exitCode = $LASTEXITCODE
        if (-not $AllowFailure -and $exitCode -ne 0) {
            throw "$FilePath $($Arguments -join ' ') failed with exit code $exitCode`n$($lines -join "`n")"
        }
        return [pscustomobject]@{ ExitCode = $exitCode; Output = @($lines) }
    }
    & $FilePath @Arguments
    $exitCode = $LASTEXITCODE
    if (-not $AllowFailure -and $exitCode -ne 0) {
        throw "$FilePath $($Arguments -join ' ') failed with exit code $exitCode"
    }
    return [pscustomobject]@{ ExitCode = $exitCode; Output = @() }
}

function Invoke-Turso {
    param([string[]]$TursoArgs)
    if ($script:UseWslTurso) {
        $parts = foreach ($a in $TursoArgs) { Escape-BashSingleQuoted $a }
        $bashLine = '$HOME/.turso/turso ' + ($parts -join ' ')
        return Invoke-External -FilePath "wsl" -Arguments @("bash", "-lc", $bashLine) -CaptureOutput
    }
    return Invoke-External -FilePath "turso" -Arguments $TursoArgs -CaptureOutput
}

$repoRoot = Split-Path $PSScriptRoot -Parent
$script:UseWslTurso = -not $UseNativeTurso

Push-Location $repoRoot
try {
    if ($script:UseWslTurso -and -not (Test-CommandAvailable -CommandName "wsl")) {
        throw "wsl required on Windows. See docs/CLI_PATHS_WINDOWS.md"
    }
    if (-not $script:UseWslTurso -and -not (Test-CommandAvailable -CommandName "turso")) {
        $homeTurso = Join-Path $HOME ".turso/turso"
        if (Test-Path $homeTurso) {
            $env:Path = "$(Split-Path $homeTurso -Parent)$([IO.Path]::PathSeparator)$env:Path"
        }
        else {
            throw "turso CLI missing"
        }
    }

    Write-Host "=== Production EmDash DR (non-destructive first) ===" -ForegroundColor Cyan
    Write-Host "FromBranch: $FromBranch"
    if ($FromBranch -match '^prod-backup-') {
        Write-Host "Restore source looks like a current production backup (prod-backup-*)." -ForegroundColor Green
    }
    elseif ($FromBranch -match '^prod-rollback-') {
        Write-Host "Restore source is a legacy prod-rollback-* backup (still valid)." -ForegroundColor Yellow
    }
    else {
        Write-Warning "FromBranch is not prod-backup-* or legacy prod-rollback-*. Confirm this is a known-good Worker-resolved snapshot (not a scratch name treated as 'the backup')."
    }

    if (-not $SkipSafetyBackup) {
        Write-Host "Step 0: safety backup of current Worker DB…" -ForegroundColor Cyan
        if ($DryRun) {
            Write-Host "[dry-run] backup-production-emdash.ps1 -AllowProduction" -ForegroundColor Yellow
        }
        else {
            $backupScript = Join-Path $PSScriptRoot "backup-production-emdash.ps1"
            & $backupScript -AllowProduction -Notes "DR pre-retarget safety backup" -UseNativeTurso:$UseNativeTurso
            if ($LASTEXITCODE -ne 0) {
                throw "Safety backup failed (exit $LASTEXITCODE). Fix backup/verify before retargeting Worker."
            }
        }
    }
    else {
        Write-Warning "Skipping safety backup of current Worker DB (-SkipSafetyBackup)."
    }

    $targetDb = $FromBranch.Trim()
    if (-not [string]::IsNullOrWhiteSpace($CloneToNewName)) {
        $targetDb = $CloneToNewName.Trim()
        Write-Host "Creating fresh clone '$targetDb' --from-db '$FromBranch'…" -ForegroundColor Cyan
        if ($DryRun) {
            Write-Host "[dry-run] turso db create $targetDb --from-db $FromBranch --group $TursoGroup" -ForegroundColor Yellow
        }
        else {
            $null = Invoke-Turso -TursoArgs @("db", "create", $targetDb, "--from-db", $FromBranch, "--group", $TursoGroup)
        }
    }

    if ($OverwriteNamedProduction) {
        Write-Host "DANGEROUS path: clone '$targetDb' onto named production '$NamedProductionDatabase' is NOT automated by this script." -ForegroundColor Red
        Write-Host "Do that only as a separate controlled cutover after Worker is healthy on a retargeted branch." -ForegroundColor Red
        Write-Host "Forbidden by default: DROP / blind SQL import over live named production without a fresh pre-change branch." -ForegroundColor Red
        throw "Refusing -OverwriteNamedProduction automation. Retarget the Worker to '$targetDb' instead (this script's default path). Named-DB cutover remains a manual operator step after probes pass."
    }

    Write-Host "Minting token for target DB '$targetDb'…" -ForegroundColor Cyan
    $token = $null
    $dbUrl = $null
    if ($DryRun) {
        Write-Host "[dry-run] turso db tokens create $targetDb" -ForegroundColor Yellow
        Write-Host "[dry-run] turso db show $targetDb --url" -ForegroundColor Yellow
        $token = "dry-run-token"
        $dbUrl = "libsql://$targetDb-$Organization.aws-eu-west-1.turso.io"
    }
    else {
        $tokOut = Invoke-Turso -TursoArgs @("db", "tokens", "create", $targetDb)
        $token = ($tokOut.Output | Where-Object { $_ -and "$_".Trim() -ne "" } | Select-Object -Last 1).ToString().Trim()
        if ([string]::IsNullOrWhiteSpace($token)) {
            throw "Failed to mint token for $targetDb"
        }
        $urlOut = Invoke-Turso -TursoArgs @("db", "show", $targetDb, "--url") -AllowFailure
        # AllowFailure not in Invoke-Turso — call again carefully
        if ($script:UseWslTurso) {
            $urlRes = Invoke-External -FilePath "wsl" -Arguments @(
                "bash", "-lc", '$HOME/.turso/turso db show ' + (Escape-BashSingleQuoted $targetDb) + ' --url'
            ) -CaptureOutput -AllowFailure
        }
        else {
            $urlRes = Invoke-External -FilePath "turso" -Arguments @("db", "show", $targetDb, "--url") -CaptureOutput -AllowFailure
        }
        if ($urlRes.ExitCode -eq 0 -and $urlRes.Output.Count -gt 0) {
            $raw = ($urlRes.Output | Where-Object { "$_" -match "libsql://|https://" } | Select-Object -Last 1)
            if ($raw) {
                $dbUrl = $raw.ToString().Trim()
                if ($dbUrl -notmatch "^libsql://") {
                    $dbUrl = $dbUrl -replace "^https://", "libsql://"
                }
            }
        }
        if ([string]::IsNullOrWhiteSpace($dbUrl)) {
            if ([string]::IsNullOrWhiteSpace($HostSuffix)) {
                $HostSuffix = "$Organization.aws-eu-west-1.turso.io"
            }
            $dbUrl = "libsql://${targetDb}-${HostSuffix}"
            Write-Warning "turso db show --url failed; derived $dbUrl from HostSuffix. Confirm before continuing."
        }
    }

    Write-Host "Retargeting production Worker TURSO_* → $targetDb" -ForegroundColor Cyan
    Write-Host "  URL host: $($dbUrl -replace '^libsql://','')" -ForegroundColor DarkGray
    $switchScript = Join-Path $PSScriptRoot "switch-production-turso-secrets.ps1"
    if ($DryRun) {
        Write-Host "[dry-run] switch-production-turso-secrets.ps1 -AllowProduction -DatabaseName $targetDb" -ForegroundColor Yellow
    }
    else {
        & $switchScript -DatabaseUrl $dbUrl -AuthToken $token -DatabaseName $targetDb -AllowProduction
        if ($LASTEXITCODE -ne 0) {
            throw "switch-production-turso-secrets.ps1 failed (exit $LASTEXITCODE)"
        }
    }

    Write-Host "Verification probes (HTTP)…" -ForegroundColor Cyan
    foreach ($p in $ProbePaths) {
        $u = if ($p.StartsWith("http")) { $p } else { "https://freedomtimes.news$p" }
        try {
            if ($DryRun) {
                Write-Host "[dry-run] GET $u" -ForegroundColor Yellow
                continue
            }
            $resp = Invoke-WebRequest -Uri $u -Method GET -MaximumRedirection 5 -TimeoutSec 45 -UseBasicParsing
            Write-Host ("  {0} → {1}" -f $u, [int]$resp.StatusCode) -ForegroundColor Green
        }
        catch {
            Write-Warning ("  {0} → FAIL ({1})" -f $u, $_.Exception.Message)
        }
    }

    Write-Host @"

DR retarget complete (named production DB left intact).
Next:
  1) Confirm apex + sample posts return 200 with expected content.
  2) Apply/check EmDash migrations against the DB the Worker now uses if needed.
  3) Only if explicitly required later: controlled cutover of verified-good → named production (NOT the first panic step).
  4) Forbidden by default: DROP / blind SQL import over live named production without a fresh pre-change branch of current live first.

Target DB: $targetDb
Look for the NEW safety backup under: Turso prod-backup-YYYYMMDD-HHMMSS + agents log data/backups/prod-emdash-*.json
Legacy restore sources may still be named prod-rollback-*.
"@ -ForegroundColor Cyan
}
finally {
    Pop-Location
}
