<#
.SYNOPSIS
  Production EmDash content backup of the DB the production Worker actually uses.

.DESCRIPTION
  HARD RULE: resolve Worker TURSO_DATABASE_URL first. Do NOT blindly assume
  freedomtimes-emdash-production (that named DB can be a stale thin corpus).

  Creates:
    1) Turso branch: prod-rollback-YYYYMMDD-HHMMSS  (THE production EmDash content backup —
                   always this name, never the source Worker DB name such as
                   prod-work-embeds-… or freedomtimes-emdash-production)
    2) Local file:   .release/backups/emdash-production-YYYYMMDD-HHMMSS.db
    3) Metadata:     .release/rollback-branches/YYYYMMDD-HHMMSS-prod-rollback-YYYYMMDD-HHMMSS.json
                   including workerTursoHost, sourceDatabase (whatever the Worker uses),
                   postCount, weeklySlugsSample, verification
    4) Backup log:   ../freedomtimes-agents/data/backups/prod-emdash-YYYYMMDD-HHMMSS.json
                   (“where is the backup” record; no tokens). Committing it to
                   freedomtimes-agents is a manual follow-up (web/docs/DEPLOY.md).

  The backup is of whatever Turso DB the production Worker is using. The backup branch
  name is always prod-rollback-<stamp> (Jon's naming, 31 Oct 2026; Sept to 31 Oct 2026 it was
  prod-backup-<stamp>, and those branches stay valid), never a work/scratch DB name.

  Before any branch or export (#148), the resolved source host is checked against the LIVE
  production Worker: sha256("freedomtimes-turso-host-v1:" + host) must equal tursoHostSha256 from
  https://freedomtimes.news/api/deploy-provenance.json (DEPLOY_PROVENANCE_TOKEN sent as a bearer
  when set). Mismatch, a missing hash, a redirect, 401/403 or repeated network/5xx failures stop
  the script: nothing is backed up. A 404 passes only as the #144 bootstrap (live commit predates
  the endpoint). On a match the resolver caveats (env fallback, "named DB stale/thin") collapse
  into one notice. -SkipLiveProvenanceCheck (local only, refused on GitHub Actions) is for when
  the site is down, e.g. the disaster-recovery safety backup
  (disaster-recover-production-emdash.ps1 -SkipLiveProvenanceCheck forwards it); the caveats
  then stay warnings and the metadata records liveProvenanceCheck: skipped.

  Then runs verify-production-emdash-backup.mjs (--from-worker --compare-staging by default).
  Non-zero exit if verify FAIL.

  Staging compare (#161): required by default (Jon, 31 Oct 2026: a machine with the production
  keys has the staging token too). It needs a staging EmDash API token, EMDASH_STAGING_PAT (or
  EMDASH_STAGING_TOKEN), filled from .env.dev like the production keys; failing both,
  ~/.config/emdash/auth.json. Before any branch or export (and before the -DryRun return) the
  token is checked read-only (verify-production-emdash-backup.mjs --check-staging-auth); if it is
  missing or rejected (401/403) the script stops, naming the variable and the fix, and nothing is
  backed up. -SkipStagingCompare skips the check and the compare (deploy-worker.yml and
  deploy-production-local.ps1 pass it). The metadata verification field always holds the verify
  report or, when verify wrote none, its error kind and message.

  -SkipFileExport (used by .github/workflows/deploy-worker.yml; the repo is public, so CI
  never writes a .db): verify reads the new prod-rollback-* branch directly instead of the
  file, with a read-only, 1-day database token created for that branch only
  (turso db tokens create <branch> -r -e 1d). The token is passed through process env,
  masked in GitHub Actions, never printed or written to disk, and cleared afterwards.
  Tokens are never invalidated here: invalidation rotates keys for the whole Turso group,
  which would break the live production token.

.EXAMPLE
  pwsh ./scripts/backup-production-emdash.ps1 -AllowProduction
#>
[CmdletBinding()]
param(
    [switch]$AllowProduction,
    [string]$TursoGroup,
    [string]$Notes = "production EmDash Worker-resolved backup",
    [switch]$SkipFileExport,
    [switch]$SkipBranch,
    [switch]$SkipStagingCompare,
    [switch]$DryRun,
    [switch]$UseNativeTurso,
    [string]$DatabaseNameOverride,
    [int]$VerifyMaxAgeHours = 24,
    [string]$AgentsRepo,
    [switch]$SkipAgentsLog,
    [switch]$SkipLiveProvenanceCheck
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

. "$PSScriptRoot/lib/EnvFile.ps1"
. "$PSScriptRoot/lib/TursoSourcePreflight.ps1"
# #161: verification record + failure messages that name the cause.
. "$PSScriptRoot/lib/BackupVerifyReport.ps1"
# #114: native-Turso fallback to ~/.turso/turso via $env:PATH (Linux env names are case-sensitive).
. "$PSScriptRoot/lib/PathEntry.ps1"
# Live Worker provenance helpers (#142/#144/#148): Assert-DeployLiveWorkerTursoHostMatchesBackup
# -Phase PreBackup and Write-DeployBackupSourceCaveats.
. "$PSScriptRoot/Deploy-EnvironmentCommon.ps1"

# Keys this script may fill from .env.dev (only when the process value is empty).
# Deliberately NOT TURSO_DATABASE_URL / TURSO_AUTH_TOKEN: the resolver's env fallback
# (resolveFromEnv in web/scripts/resolve-production-worker-turso.mjs) accepts that generic
# pair as its second candidate, so loading it from the file would let a failed Worker
# resolve silently back up whatever static DB .env.dev names (2026-09-07 stale-DB
# incident, CONTENT_PROMOTION_RUNBOOK.md). Operators who want it must export it on
# purpose. CLOUDFLARE_* and other file keys are not passed to the node/wrangler children.
# EMDASH_STAGING_PAT / EMDASH_STAGING_TOKEN (#161): the staging EmDash API token for the default
# staging compare (read-only GET of staging's published posts; never a database token).
$script:ProductionBackupEnvDevKeys = @(
    "TURSO_PRODUCTION_EMDASH_DB_URL",
    "TURSO_PRODUCTION_EMDASH_DB_TOKEN",
    "TURSO_PRODUCTION_EMDASH_DB_NAME",
    "TF_VAR_TURSO_ORGANIZATION",
    "TURSO_ORGANIZATION",
    "TF_VAR_TURSO_DATABASE_GROUP_PRODUCTION",
    "EMDASH_STAGING_PAT",
    "EMDASH_STAGING_TOKEN"
)

if (-not $AllowProduction) {
    throw "Refusing production EmDash backup without -AllowProduction."
}
if ($SkipLiveProvenanceCheck -and $env:GITHUB_ACTIONS -eq "true") {
    throw "Refusing -SkipLiveProvenanceCheck on GitHub Actions (#148): CI must prove the backup source is the live Worker's DB."
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

function Register-GithubActionsSecretMask {
    <#
    .SYNOPSIS
      In GitHub Actions, tell the runner to redact a value from all later log output.
      No-op elsewhere. Never prints the value outside the ::add-mask:: command.
    #>
    param([string]$Value)
    if ($env:GITHUB_ACTIONS -ne "true" -or [string]::IsNullOrWhiteSpace($Value)) {
        return
    }
    Write-Host "::add-mask::$($Value.Trim())"
}

function Write-BackupVerifySummaryForCi {
    <#
    .SYNOPSIS
      CI replacement for echoing verify-production-emdash-backup.mjs output.

    .DESCRIPTION
      P0 rule (web/docs/DEPLOY.md § Backups are never public): this repo is public, so CI logs
      must never carry backup content or row data. The verify report lists post slugs and
      statuses (missingInBackup, statusMismatch, weekly samples, failure text), so in GitHub
      Actions only counts, hashes and the pass flag are printed. The full report stays on the
      runner's disk (never uploaded). Run the script locally to see the slugs.
    #>
    param(
        [string]$ReportPath,
        [int]$ExitCode,
        [object[]]$Output
    )
    $count = { param($value) @($value | Where-Object { $null -ne $_ }).Count }
    if (-not [string]::IsNullOrWhiteSpace($ReportPath) -and (Test-Path -LiteralPath $ReportPath)) {
        try {
            $report = Get-Content -LiteralPath $ReportPath -Raw | ConvertFrom-Json -ErrorAction Stop
            $props = $report.PSObject.Properties
            $get = { param($name) if ($props[$name]) { $report.$name } else { $null } }
            Write-Host "Verify (CI summary; slugs withheld from public logs): pass=$(& $get 'pass') exit=$ExitCode error=$(& $get 'error')"
            Write-Host "  backupCount=$(& $get 'backupCount') liveCount=$(& $get 'liveCount') missingInBackup=$(& $count (& $get 'missingInBackup')) extraInBackup=$(& $count (& $get 'extraInBackup')) statusMismatch=$(& $count (& $get 'statusMismatch')) failures=$(& $count (& $get 'failures'))"
            Write-Host "  inventoryHash=$(& $get 'inventoryHash') liveInventoryHash=$(& $get 'liveInventoryHash')"
            return
        }
        catch {
            Write-Host "Verify report could not be summarised; output withheld from public logs (exit $ExitCode)."
            return
        }
    }
    # No report: show only the machine-readable error kind (never row data).
    $errorKinds = @($Output | ForEach-Object { [string]$_ } | ForEach-Object {
            $m = [regex]::Match($_, '"error"\s*:\s*"([a-z_]{1,40})"')
            if ($m.Success) { $m.Groups[1].Value }
        } | Select-Object -Unique)
    $kinds = if ($errorKinds.Count -gt 0) { $errorKinds -join ", " } else { "none reported" }
    Write-Host "Verify produced no report (exit $ExitCode; error kind: $kinds). Output withheld from public logs; re-run locally for detail."
}

function Register-GithubActionsSecretMasksFromEnvFile {
    <#
    .SYNOPSIS
      Mask the Worker-resolved Turso token(s) the resolver wrote to its private env sidecar.
      The resolved token is not always a registered GitHub secret, so GitHub would not mask it.
    #>
    param([string]$Path)
    if ($env:GITHUB_ACTIONS -ne "true" -or [string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path)) {
        return
    }
    foreach ($line in Get-Content -LiteralPath $Path) {
        if ($line -match '^(TURSO_AUTH_TOKEN|TURSO_PRODUCTION_EMDASH_DB_TOKEN)=(.+)$') {
            Register-GithubActionsSecretMask -Value $Matches[2]
        }
    }
}

function Invoke-TursoCapture {
    <#
    .SYNOPSIS
      Run turso (WSL or native) and return trimmed stdout lines. Throws without echoing output
      when -Sensitive (token creation), so a partial token can never reach the log.
    #>
    param(
        [string[]]$TursoArgs,
        [switch]$Sensitive
    )
    if ($script:UseWslTursoForCapture) {
        $quoted = foreach ($a in $TursoArgs) { Escape-BashSingleQuoted $a }
        $lines = & wsl bash -lc ('$HOME/.turso/turso ' + ($quoted -join " ")) 2>&1
    }
    else {
        $lines = & turso @TursoArgs 2>&1
    }
    $code = $LASTEXITCODE
    if ($code -ne 0) {
        $detail = if ($Sensitive) { "(output withheld: sensitive command)" } else { ($lines -join "`n") }
        throw "turso $($TursoArgs[0..([Math]::Min(2, $TursoArgs.Count - 1))] -join ' ') failed with exit code $code. $detail"
    }
    return @($lines | ForEach-Object { ([string]$_).Trim() } | Where-Object { $_ -ne "" })
}

$repoRoot = Split-Path $PSScriptRoot -Parent
Push-Location $repoRoot
try {
    $UseWslTurso = -not $UseNativeTurso
    $script:UseWslTursoForCapture = $UseWslTurso
    if ($UseWslTurso) {
        if (-not (Test-CommandAvailable -CommandName "wsl")) {
            throw "wsl is required for Turso on Windows. See docs/CLI_PATHS_WINDOWS.md (or pass -UseNativeTurso on Linux)."
        }
    }
    else {
        # $env:PATH, never $env:Path: Linux env names are case-sensitive (#114).
        $null = Initialize-NativeTursoCli -MissingMessage "Turso CLI not on PATH and `$HOME/.turso/turso is missing. See docs/CLI_PATHS_WINDOWS.md"
    }

    if (-not (Test-CommandAvailable -CommandName "node")) {
        throw "node is required to resolve/verify Worker Turso."
    }

    # Node only reads process env, and a deploy child does not load .env.dev unless this
    # script does. Fill allowlisted keys that are still empty; never overwrite. A missing
    # file is not an error: explicit exports (Linux / -UseNativeTurso) work without it, and
    # the resolver reports missing values precisely (resolve_failed / org_suffix_unresolved).
    $envDev = Join-Path $repoRoot ".env.dev"
    $filledKeys = [string[]]@()
    if (Test-Path -LiteralPath $envDev -PathType Leaf) {
        $filledKeys = Import-EnvFileFillMissing -Path $envDev -Keys $script:ProductionBackupEnvDevKeys
        $filledText = if ($filledKeys.Count -gt 0) { $filledKeys -join ", " } else { "none (all preset or absent)" }
        Write-Host "Filled from .env.dev (names only): $filledText" -ForegroundColor DarkGray
    }
    else {
        Write-Host "No $envDev; using process env only." -ForegroundColor DarkGray
    }

    $timestampUtc = (Get-Date).ToUniversalTime().ToString("yyyyMMdd-HHmmss")
    $branchName = "prod-rollback-$timestampUtc"
    $backupFileRel = ".release/backups/emdash-production-$timestampUtc.db"
    $backupFilePath = Join-Path $repoRoot $backupFileRel
    $metaDir = Join-Path $repoRoot ".release/rollback-branches"
    $backupDir = Join-Path $repoRoot ".release/backups"
    New-Item -ItemType Directory -Path $metaDir -Force | Out-Null
    New-Item -ItemType Directory -Path $backupDir -Force | Out-Null

    Write-Host "Resolving production Worker Turso database…" -ForegroundColor Cyan
    $resolveScript = Join-Path $repoRoot "web/scripts/resolve-production-worker-turso.mjs"
    $resolveOut = Join-Path $backupDir "_tmp-resolve-$timestampUtc.json"
    $resolveArgs = @($resolveScript, "--inventory", "--emit-env-file", "--out", $resolveOut)
    # Explicit DB name skips hostname parsing (the resolver strips "-<org>" from
    # libsql://<db>-<org>.<region>.turso.io and refuses if it cannot).
    if (-not [string]::IsNullOrWhiteSpace($DatabaseNameOverride)) {
        $resolveArgs += @("--database-name", $DatabaseNameOverride.Trim())
    }
    $resolveResult = Invoke-External -FilePath "node" -Arguments $resolveArgs -CaptureOutput
    $resolved = Get-Content -LiteralPath $resolveOut -Raw | ConvertFrom-Json
    if (-not $resolved.ok) {
        throw "Worker Turso resolve failed. See $resolveOut"
    }
    if ($resolved.PSObject.Properties["emitEnvFile"]) {
        Register-GithubActionsSecretMasksFromEnvFile -Path ([string]$resolved.emitEnvFile)
    }

    $sourceDatabase = if (-not [string]::IsNullOrWhiteSpace($DatabaseNameOverride)) {
        $DatabaseNameOverride.Trim()
    }
    else {
        [string]$resolved.databaseName
    }
    $workerHost = [string]$resolved.workerTursoHost
    # Public CI logs: the provenance endpoint only ever exposes a hash of this host (#142),
    # so keep the plain hostname out of the job log too.
    Register-GithubActionsSecretMask -Value $workerHost
    $postCount = [int]($resolved.postCount)
    $weeklySample = @($resolved.weeklySlugsSample)

    Write-Host "Worker host:     $workerHost" -ForegroundColor Green
    Write-Host "Source database: $sourceDatabase  (whatever the production Worker points at — NOT the backup name)" -ForegroundColor Green
    Write-Host "Backup branch:   $branchName  (always prod-rollback-<stamp>; never named after the source)" -ForegroundColor Green
    Write-Host "Published posts: $postCount" -ForegroundColor Green

    # #148: prove the source is the DB the LIVE production Worker reads before any branch or
    # export (and before the -DryRun return). Throws on mismatch/failure: nothing backed up.
    if ($SkipLiveProvenanceCheck) {
        $liveProvenance = "skipped"
        Write-Warning "-SkipLiveProvenanceCheck: NOT checking the backup source against the live Worker (#148). Confirm the Worker host yourself."
    }
    else {
        $liveOutcome = Assert-DeployLiveWorkerTursoHostMatchesBackup -Phase PreBackup -ExpectedTursoHost $workerHost
        $liveProvenance = if ($liveOutcome -eq "Match") { "match" } else { "bootstrap" }
    }
    $resolverWarnings = if ($resolved.PSObject.Properties["warnings"] -and $resolved.warnings) { [string[]]@($resolved.warnings) } else { [string[]]@() }
    Write-DeployBackupSourceCaveats -LiveProvenance $liveProvenance -ResolverWarnings $resolverWarnings `
        -SourceDatabase $sourceDatabase -ResolveSource ([string]$resolved.source)

    if ([string]::IsNullOrWhiteSpace($TursoGroup)) {
        $TursoGroup = if ($env:TF_VAR_TURSO_DATABASE_GROUP_PRODUCTION) {
            $env:TF_VAR_TURSO_DATABASE_GROUP_PRODUCTION
        }
        else {
            "freedomtimes-production"
        }
    }

    # Read-only preflight before any branch or export, and before the -DryRun return so a
    # dry run is the cheapest place to catch a wrong source name.
    if (-not $SkipBranch -or -not $SkipFileExport) {
        Write-Host "Confirming Turso database '$sourceDatabase' exists…" -ForegroundColor Cyan
        $shown = Test-TursoSourceDatabase -DatabaseName $sourceDatabase -UseWsl:$UseWslTurso
        if (-not $shown.Ok) {
            $resolverOrg = if ($resolved.PSObject.Properties["organization"]) { [string]$resolved.organization } else { "" }
            throw (Format-TursoSourcePreflightFailure -DatabaseName $sourceDatabase -ExitCode $shown.ExitCode `
                    -WorkerHost $workerHost -Organization $resolverOrg -Output $shown.Output -UseWsl:$UseWslTurso)
        }
        Write-Host "Source DB confirmed: $sourceDatabase" -ForegroundColor Green
    }

    # #161: the staging compare is required by default, so prove the staging token works before
    # any branch or export. Before this, a missing/expired token surfaced only after the Turso
    # branch existed, as a bare "VERIFY FAILED" with no reason in the metadata.
    if ($SkipStagingCompare) {
        Write-Host "Staging compare skipped (-SkipStagingCompare)." -ForegroundColor DarkGray
    }
    else {
        Write-Host "Checking the staging EmDash token for the staging compare…" -ForegroundColor Cyan
        $stagingCheck = Invoke-External -FilePath "node" -Arguments @(
            (Join-Path $repoRoot "web/scripts/verify-production-emdash-backup.mjs"), "--check-staging-auth"
        ) -CaptureOutput -AllowFailure
        if ($stagingCheck.ExitCode -ne 0) {
            $stagingFailure = Get-BackupVerifyFailureFromOutput -Output $stagingCheck.Output
            throw (Format-StagingAuthPreflightFailure -Failure $stagingFailure -ExitCode $stagingCheck.ExitCode -FilledFromEnvDev $filledKeys)
        }
        $stagingOk = Get-BackupVerifyProperty (Get-LastJsonObjectFromOutput -Output $stagingCheck.Output) "stagingTokenSource"
        Write-Host "Staging token OK ($stagingOk)." -ForegroundColor Green
    }

    if ($DryRun) {
        if (-not $SkipBranch -or -not $SkipFileExport) {
            Write-Host "[dry-run] source DB confirmed: $sourceDatabase" -ForegroundColor Yellow
        }
        Write-Host "[dry-run] would create branch $branchName from $sourceDatabase (group $TursoGroup)" -ForegroundColor Yellow
        Write-Host "[dry-run] would export $backupFileRel" -ForegroundColor Yellow
        return
    }

    if (-not $SkipBranch) {
        Write-Host "Creating Turso backup branch '$branchName' from '$sourceDatabase'…" -ForegroundColor Cyan
        if ($UseWslTurso) {
            $bashLine = '$HOME/.turso/turso db create ' + (Escape-BashSingleQuoted $branchName) +
                ' --from-db ' + (Escape-BashSingleQuoted $sourceDatabase) +
                ' --group ' + (Escape-BashSingleQuoted $TursoGroup)
            $null = Invoke-External -FilePath "wsl" -Arguments @("bash", "-lc", $bashLine)
        }
        else {
            $null = Invoke-External -FilePath "turso" -Arguments @(
                "db", "create", $branchName, "--from-db", $sourceDatabase, "--group", $TursoGroup
            )
        }
        Write-Host "Branch created: $branchName" -ForegroundColor Green
    }
    else {
        Write-Warning "Skipping Turso branch (-SkipBranch)."
        $branchName = ""
    }

    if (-not $SkipFileExport) {
        Write-Host "Exporting local file $backupFileRel…" -ForegroundColor Cyan
        if ($UseWslTurso) {
            # WSL path: convert Windows path for --output-file when possible
            $wslOut = Invoke-External -FilePath "wsl" -Arguments @(
                "bash", "-lc", "wslpath -a " + (Escape-BashSingleQuoted $backupFilePath)
            ) -CaptureOutput -AllowFailure
            $outFile = if ($wslOut.ExitCode -eq 0 -and $wslOut.Output.Count -gt 0) {
                ([string]$wslOut.Output[0]).Trim()
            }
            else {
                # Fallback: relative path from repo (mounted)
                "./.release/backups/emdash-production-$timestampUtc.db"
            }
            $bashExport = 'mkdir -p ./.release/backups; $HOME/.turso/turso db export ' +
                (Escape-BashSingleQuoted $sourceDatabase) +
                ' --output-file ' + (Escape-BashSingleQuoted $outFile)
            $null = Invoke-External -FilePath "wsl" -Arguments @("bash", "-lc", $bashExport)
        }
        else {
            $null = Invoke-External -FilePath "turso" -Arguments @(
                "db", "export", $sourceDatabase, "--output-file", $backupFilePath
            )
        }
        if (-not (Test-Path -LiteralPath $backupFilePath)) {
            throw "Export finished but file missing: $backupFilePath"
        }
        Write-Host "File export: $backupFilePath" -ForegroundColor Green
    }
    else {
        Write-Warning "Skipping file export (-SkipFileExport)."
        $backupFileRel = ""
    }

    $headHash = ""
    $headShort = ""
    $currentBranch = ""
    $originMain = ""
    $originRemote = ""
    $isDirty = $false
    if (Test-CommandAvailable -CommandName "git") {
        $headHash = (Invoke-External -FilePath "git" -Arguments @("rev-parse", "HEAD") -CaptureOutput).Output[0].ToString().Trim()
        $headShort = (Invoke-External -FilePath "git" -Arguments @("rev-parse", "--short", "HEAD") -CaptureOutput).Output[0].ToString().Trim()
        $currentBranch = (Invoke-External -FilePath "git" -Arguments @("rev-parse", "--abbrev-ref", "HEAD") -CaptureOutput).Output[0].ToString().Trim()
        $om = Invoke-External -FilePath "git" -Arguments @("rev-parse", "origin/main") -CaptureOutput -AllowFailure
        if ($om.ExitCode -eq 0 -and $om.Output.Count -gt 0) { $originMain = $om.Output[0].ToString().Trim() }
        $or = Invoke-External -FilePath "git" -Arguments @("remote", "get-url", "origin") -CaptureOutput -AllowFailure
        if ($or.ExitCode -eq 0 -and $or.Output.Count -gt 0) { $originRemote = $or.Output[0].ToString().Trim() }
        $dirty = Invoke-External -FilePath "git" -Arguments @("status", "--porcelain") -CaptureOutput
        $isDirty = $dirty.Output.Count -gt 0
    }

    $verifyReportPath = Join-Path $metaDir "$timestampUtc-verify.json"
    $verifyAgainstBranch = $false
    $verifyArgs = [System.Collections.Generic.List[string]]::new()
    $verifyArgs.Add((Join-Path $repoRoot "web/scripts/verify-production-emdash-backup.mjs"))
    $verifyArgs.Add("--from-worker")
    $verifyArgs.Add("--metadata-out")
    $verifyArgs.Add($verifyReportPath)
    if (-not [string]::IsNullOrWhiteSpace($backupFileRel) -and (Test-Path -LiteralPath $backupFilePath)) {
        $verifyArgs.Add("--backup-db")
        $verifyArgs.Add($backupFileRel)
    }
    elseif (-not [string]::IsNullOrWhiteSpace($branchName)) {
        # Branch-only (CI: no .db on a public repo's runner). Read the new branch directly with a
        # read-only, 1-day token scoped to that branch. Passed by env, never on the command line.
        Write-Host "Verifying the Turso branch '$branchName' directly (no .db export)…" -ForegroundColor Cyan
        $branchUrl = (Invoke-TursoCapture -TursoArgs @("db", "show", $branchName, "--url") | Select-Object -Last 1)
        if ([string]::IsNullOrWhiteSpace($branchUrl) -or $branchUrl -notmatch '^libsql://') {
            throw "Could not read the libsql URL of backup branch '$branchName'. Backup not verified; refusing to continue."
        }
        $branchToken = (Invoke-TursoCapture -Sensitive -TursoArgs @("db", "tokens", "create", $branchName, "--read-only", "--expiration", "1d") | Select-Object -Last 1)
        if ([string]::IsNullOrWhiteSpace($branchToken)) {
            throw "Could not create a read-only token for backup branch '$branchName'. Backup not verified; refusing to continue."
        }
        Register-GithubActionsSecretMask -Value $branchToken
        $env:TURSO_BACKUP_DATABASE_URL = $branchUrl
        $env:TURSO_BACKUP_AUTH_TOKEN = $branchToken
        $branchToken = $null
        $verifyAgainstBranch = $true
        $verifyArgs.Add("--backup-branch")
        $verifyArgs.Add($branchName)
    }
    else {
        throw "Nothing to verify: both -SkipBranch and -SkipFileExport were passed."
    }
    if (-not $SkipStagingCompare) {
        $verifyArgs.Add("--compare-staging")
    }

    Write-Host "Verifying backup against live Worker inventory…" -ForegroundColor Cyan
    try {
        $verifyRun = Invoke-External -FilePath "node" -Arguments $verifyArgs.ToArray() -CaptureOutput -AllowFailure
    }
    finally {
        if ($verifyAgainstBranch) {
            Remove-Item Env:TURSO_BACKUP_DATABASE_URL, Env:TURSO_BACKUP_AUTH_TOKEN -ErrorAction SilentlyContinue
        }
    }
    if ($env:GITHUB_ACTIONS -eq "true") {
        Write-BackupVerifySummaryForCi -ReportPath $verifyReportPath -ExitCode $verifyRun.ExitCode -Output $verifyRun.Output
    }
    else {
        $verifyRun.Output | ForEach-Object { $_ }
    }
    $verifyPass = $verifyRun.ExitCode -eq 0
    # #161: never null. The report, or the error kind and message when verify wrote none.
    $verification = New-BackupVerificationRecord -ReportPath $verifyReportPath -ExitCode $verifyRun.ExitCode -Output $verifyRun.Output

    $metadataFileName = if ($branchName) {
        "$timestampUtc-$branchName.json"
    }
    else {
        "$timestampUtc-emdash-production-file-only.json"
    }
    $metadataFilePath = Join-Path $metaDir $metadataFileName

    $metadata = [ordered]@{
        createdAtUtc       = [DateTime]::UtcNow.ToString("o")
        kind               = "production-emdash-content-backup"
        sourceDatabase     = $sourceDatabase
        backupDatabase     = $branchName
        rollbackDatabase   = $branchName
        backupFile         = $backupFileRel
        workerTursoHost    = $workerHost
        resolveSource      = [string]$resolved.source
        # #148: match = live Worker host hash proved the source; bootstrap / skipped = unproven.
        liveProvenanceCheck = $liveProvenance
        postCount          = $postCount
        weeklySlugsSample  = $weeklySample
        inventoryHash      = [string]$resolved.inventoryHash
        tursoGroup         = $TursoGroup
        notes              = $Notes
        verification       = $verification
        verificationPass   = $verifyPass
        git                = [ordered]@{
            head              = $headHash
            headShort         = $headShort
            currentBranch     = $currentBranch
            originMain        = $originMain
            originRemote      = $originRemote
            dirtyWorkingTree  = $isDirty
        }
    }
    $metadata | ConvertTo-Json -Depth 12 | Set-Content -Path $metadataFilePath -Encoding UTF8

    Write-Host "Backup metadata: $metadataFilePath" -ForegroundColor Green

    if (-not $SkipAgentsLog) {
        if ([string]::IsNullOrWhiteSpace($AgentsRepo)) {
            if ($env:FREEDOMTIMES_AGENTS_DIR) {
                $AgentsRepo = $env:FREEDOMTIMES_AGENTS_DIR
            }
            else {
                $AgentsRepo = Join-Path (Split-Path $repoRoot -Parent) "freedomtimes-agents"
            }
        }
        $logPayloadPath = Join-Path $backupDir "_tmp-backup-log-$timestampUtc.json"
        $postsObj = $resolved.posts
        $logPayload = [ordered]@{
            createdAtUtc           = $metadata.createdAtUtc
            environment            = "production"
            sourceDatabase         = $sourceDatabase
            workerTursoHost        = $workerHost
            destination            = [ordered]@{
                tursoBranch = $branchName
                localFile   = $backupFileRel
            }
            backupNaming           = "Turso branch is always prod-rollback-YYYYMMDD-HHMMSS (never the Worker source name)."
            posts                  = $postsObj
            postCount              = $postCount
            weeklySlugsSample      = $weeklySample
            verificationPass       = $verifyPass
            # #154: same values as the metadata, so the committed log shows whether the source was proven (#148).
            liveProvenanceCheck    = $liveProvenance
            resolveSource          = [string]$resolved.source
            freedomtimesMetadata   = (".release/rollback-branches/" + $metadataFileName)
            notes                  = $Notes
        }
        $logPayload | ConvertTo-Json -Depth 12 | Set-Content -Path $logPayloadPath -Encoding UTF8
        $logWriter = Join-Path $repoRoot "web/scripts/write-emdash-backup-log.mjs"
        $logArgs = @(
            $logWriter, "--from-json", $logPayloadPath, "--stamp", $timestampUtc, "--agents-dir", $AgentsRepo
        )
        try {
            $logRun = Invoke-External -FilePath "node" -Arguments $logArgs -CaptureOutput
        }
        catch {
            # #154: the writer runs last. Say what already exists so the operator does not redo the backup.
            throw "Backup branch $branchName and metadata $metadataFileName were created (verificationPass=$verifyPass); only writing the freedomtimes-agents log failed: $($_.Exception.Message). Fix the cause and write it with: node web/scripts/write-emdash-backup-log.mjs --from-json $logPayloadPath --stamp $timestampUtc --agents-dir <freedomtimes-agents>"
        }
        $agentsLogPath = ($logRun.Output | Select-Object -Last 1).ToString().Trim()
        Write-Host "Agents backup log: $agentsLogPath" -ForegroundColor Green
        Write-Host "Manual follow-up: git add + commit that JSON in freedomtimes-agents (no tokens, no .db). See web/docs/DEPLOY.md." -ForegroundColor Cyan
    }
    else {
        Write-Host "Skipping the freedomtimes-agents backup log (-SkipAgentsLog). The Turso branch and .release/rollback-branches/ metadata are the record; adding a data/backups/prod-emdash-*.json entry is a manual follow-up (web/docs/DEPLOY.md)." -ForegroundColor Yellow
    }

    if (-not $verifyPass) {
        throw (Format-BackupVerifyFailedMessage -Verification $verification -VerifyReportPath $verifyReportPath -MetadataPath $metadataFilePath -FilledFromEnvDev $filledKeys -PublicLog:($env:GITHUB_ACTIONS -eq "true"))
    }
    $parts = @()
    if ($branchName) { $parts += "branch" }
    if ($backupFileRel) { $parts += "file" }
    $parts += "metadata"
    if (-not $SkipAgentsLog) { $parts += "agents log" }
    Write-Host "PASS: production EmDash backup verified ($($parts -join ' + '))." -ForegroundColor Green
    Write-Host "Backup name: $branchName  (of Worker source '$sourceDatabase')" -ForegroundColor Green
    if (-not $SkipAgentsLog) {
        Write-Host "Look here: freedomtimes-agents/data/backups/prod-emdash-$timestampUtc.json" -ForegroundColor Cyan
    }
    Write-Host "Metadata: .release/rollback-branches/$metadataFileName" -ForegroundColor Cyan
    if ($backupFileRel) {
        Write-Host "File: $backupFileRel" -ForegroundColor Cyan
    }
}
finally {
    if ($env:GITHUB_ACTIONS -eq "true") {
        # Runner hygiene: the resolver's temp files hold published slugs (inventory) and the
        # Worker DB token. Nothing uploads them, but remove them so no later step can.
        Get-ChildItem -LiteralPath (Join-Path $repoRoot ".release/backups") -Filter "_tmp-*" -File -ErrorAction SilentlyContinue |
            Remove-Item -Force -ErrorAction SilentlyContinue
    }
    Pop-Location
}
