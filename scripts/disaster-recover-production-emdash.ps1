<#
.SYNOPSIS
  Non-destructive-first disaster recovery for production EmDash Turso.

.DESCRIPTION
  Safety principle: do NOT default to restoring a backup onto named production
  (overwrites current prod state — knee-jerk, can destroy evidence / newer rows).

  Preferred order (this script):
    1) Identify -FromBranch (a verified prod-rollback-* backup, or an older prod-backup-*
       one, or another known-good Turso DB)
    2) Create a safety branch/export of the **current** Worker DB first
       (that NEW safety backup is named prod-rollback-YYYYMMDD-HHMMSS)
    3) Retarget production Worker TURSO_* secrets to -FromBranch (or a fresh --from-db clone)
    4) Print verification probes (apex + sample posts)

  Step 2 runs backup-production-emdash.ps1, which first proves the source is the DB the
  LIVE production Worker reads (/api/deploy-provenance.json, #148) and refuses otherwise.
  If the production site is down, that check cannot answer: pass -SkipLiveProvenanceCheck
  (explicit opt-in, forwarded to the backup) to take the safety backup without it. Never
  use it while the site is up and reports a different DB host; that refusal is the point.
  -SkipSafetyBackup takes no backup at all and is not the fix for a down site.

  Named production DB is left intact unless -OverwriteNamedProduction (dangerous).
  NEW backups are always prod-rollback-<stamp> (Jon's naming, 31 Oct 2026). prod-backup-*
  branches (Sept to 31 Oct 2026) remain valid restore sources. Never treat a work/scratch name (prod-work-embeds-…) as the
  backup artifact name — that is a possible *source*, not the backup label.

.EXAMPLE
  pwsh ./scripts/disaster-recover-production-emdash.ps1 -AllowProduction -FromBranch prod-rollback-20261101-140000

.EXAMPLE
  pwsh ./scripts/disaster-recover-production-emdash.ps1 -AllowProduction -FromBranch prod-backup-20261030-232606

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
    # Turso org slug. Defaults to TF_VAR_TURSO_ORGANIZATION / TURSO_ORGANIZATION (no hard-coded org).
    [string]$Organization = $(if ($env:TF_VAR_TURSO_ORGANIZATION) { $env:TF_VAR_TURSO_ORGANIZATION } elseif ($env:TURSO_ORGANIZATION) { $env:TURSO_ORGANIZATION } else { "" }),
    [string]$HostSuffix,
    [switch]$OverwriteNamedProduction,
    [string]$NamedProductionDatabase = "freedomtimes-emdash-production",
    [switch]$SkipSafetyBackup,
    # #148: forwarded to backup-production-emdash.ps1 for the safety backup. Only when the
    # production site is down; the backup script refuses it on GitHub Actions.
    [switch]$SkipLiveProvenanceCheck,
    [switch]$DryRun,
    [switch]$UseNativeTurso,
    [string[]]$ProbePaths = @("/", "/posts/weekly-summary-1-september-2026", "/posts/weekly-summary-10-august-2026")
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# #114: native-Turso fallback to ~/.turso/turso via $env:PATH (Linux env names are case-sensitive).
. "$PSScriptRoot/lib/PathEntry.ps1"

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

function Get-DrSafetyBackupHint {
    <#
    .SYNOPSIS
      #148: what to tell the operator when the safety backup throws. A live-provenance refusal
      that is not a host mismatch (site down, 5xx, unreachable, unproven 404) points to
      -SkipLiveProvenanceCheck; a mismatch means the site is up and reading another DB, so it
      must be fixed, never skipped.
    #>
    param(
        [string]$Message,
        [switch]$SkipLiveProvenanceCheck
    )
    if ($SkipLiveProvenanceCheck -or $Message -notmatch 'live Worker provenance, #148') {
        return "Fix backup/verify before retargeting Worker."
    }
    if ($Message -match 'different Turso DB host') {
        return "The live Worker is up and reads a different DB than the backup source: fix TURSO_PRODUCTION_EMDASH_DB_* (do not skip the check), then re-run."
    }
    return "If the production site is down (so it cannot prove its DB), re-run with -SkipLiveProvenanceCheck to take the safety backup without that check. Do not use -SkipSafetyBackup: it takes no backup."
}

$repoRoot = Split-Path $PSScriptRoot -Parent
$script:UseWslTurso = -not $UseNativeTurso

Push-Location $repoRoot
try {
    if ($script:UseWslTurso -and -not (Test-CommandAvailable -CommandName "wsl")) {
        throw "wsl required on Windows. See docs/CLI_PATHS_WINDOWS.md"
    }
    if (-not $script:UseWslTurso) {
        # $env:PATH, never $env:Path: Linux env names are case-sensitive (#114).
        $null = Initialize-NativeTursoCli -MissingMessage "turso CLI missing (not on PATH and no `$HOME/.turso/turso)"
    }

    Write-Host "=== Production EmDash DR (non-destructive first) ===" -ForegroundColor Cyan
    Write-Host "FromBranch: $FromBranch"
    if ($FromBranch -match '^prod-rollback-') {
        Write-Host "Restore source looks like a production backup (prod-rollback-*)." -ForegroundColor Green
    }
    elseif ($FromBranch -match '^prod-backup-') {
        Write-Host "Restore source is an older prod-backup-* backup (still valid)." -ForegroundColor Yellow
    }
    else {
        Write-Warning "FromBranch is not prod-rollback-* or the older prod-backup-*. Confirm this is a known-good Worker-resolved snapshot (not a scratch name treated as 'the backup')."
    }

    if (-not $SkipSafetyBackup) {
        Write-Host "Step 0: safety backup of current Worker DB…" -ForegroundColor Cyan
        if ($SkipLiveProvenanceCheck) {
            Write-Warning "-SkipLiveProvenanceCheck: the safety backup will NOT prove its source is the live Worker's DB (#148). Use only while the production site is down."
        }
        $skipLiveArg = if ($SkipLiveProvenanceCheck) { " -SkipLiveProvenanceCheck" } else { "" }
        if ($DryRun) {
            Write-Host "[dry-run] backup-production-emdash.ps1 -AllowProduction$skipLiveArg" -ForegroundColor Yellow
        }
        else {
            $backupScript = Join-Path $PSScriptRoot "backup-production-emdash.ps1"
            try {
                & $backupScript -AllowProduction -Notes "DR pre-retarget safety backup" -UseNativeTurso:$UseNativeTurso -SkipLiveProvenanceCheck:$SkipLiveProvenanceCheck
            }
            catch {
                throw "Safety backup failed: $($_.Exception.Message) $(Get-DrSafetyBackupHint -Message $_.Exception.Message -SkipLiveProvenanceCheck:$SkipLiveProvenanceCheck)".Trim()
            }
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
                if ([string]::IsNullOrWhiteSpace($Organization)) {
                    throw "turso db show --url failed and no Turso org is set (-Organization / TF_VAR_TURSO_ORGANIZATION); cannot derive the DB URL."
                }
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
Look for the NEW safety backup under: Turso prod-rollback-YYYYMMDD-HHMMSS + agents log data/backups/prod-emdash-*.json
Older restore sources may be named prod-backup-*.
"@ -ForegroundColor Cyan
}
finally {
    Pop-Location
}
