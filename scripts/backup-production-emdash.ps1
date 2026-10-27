<#
.SYNOPSIS
  Production EmDash content backup of the DB the production Worker actually uses.

.DESCRIPTION
  HARD RULE: resolve Worker TURSO_DATABASE_URL first. Do NOT blindly assume
  freedomtimes-emdash-production (that named DB can be a stale thin corpus).

  Creates:
    1) Turso branch: prod-backup-YYYYMMDD-HHMMSS  (THE production EmDash content backup —
                   always this name, never the source Worker DB name such as
                   prod-work-embeds-… or freedomtimes-emdash-production)
    2) Local file:   .release/backups/emdash-production-YYYYMMDD-HHMMSS.db
    3) Metadata:     .release/rollback-branches/YYYYMMDD-HHMMSS-prod-backup-YYYYMMDD-HHMMSS.json
                   including workerTursoHost, sourceDatabase (whatever the Worker uses),
                   postCount, weeklySlugsSample, verification
    4) Committed log: ../freedomtimes-agents/data/backups/prod-emdash-YYYYMMDD-HHMMSS.json
                   (canonical “where is the backup” record — commit it; no tokens)

  The backup is of whatever Turso DB the production Worker is using. The artifact
  name is always prod-backup-<stamp>, never a work/scratch DB name.

  Then runs verify-production-emdash-backup.mjs (--from-worker --compare-staging by default).
  Non-zero exit if verify FAIL.

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
    [switch]$SkipAgentsLog
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

. "$PSScriptRoot/lib/EnvFile.ps1"
. "$PSScriptRoot/lib/TursoSourcePreflight.ps1"

# Keys this script may fill from .env.dev (only when the process value is empty).
# Deliberately NOT TURSO_DATABASE_URL / TURSO_AUTH_TOKEN: the resolver's env fallback
# (resolveFromEnv in web/scripts/resolve-production-worker-turso.mjs) accepts that generic
# pair as its second candidate, so loading it from the file would let a failed Worker
# resolve silently back up whatever static DB .env.dev names (2026-09-07 stale-DB
# incident, CONTENT_PROMOTION_RUNBOOK.md). Operators who want it must export it on
# purpose. CLOUDFLARE_* and other file keys are not passed to the node/wrangler children.
$script:ProductionBackupEnvDevKeys = @(
    "TURSO_PRODUCTION_EMDASH_DB_URL",
    "TURSO_PRODUCTION_EMDASH_DB_TOKEN",
    "TURSO_PRODUCTION_EMDASH_DB_NAME",
    "TF_VAR_TURSO_ORGANIZATION",
    "TURSO_ORGANIZATION",
    "TF_VAR_TURSO_DATABASE_GROUP_PRODUCTION"
)

if (-not $AllowProduction) {
    throw "Refusing production EmDash backup without -AllowProduction."
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

$repoRoot = Split-Path $PSScriptRoot -Parent
Push-Location $repoRoot
try {
    $UseWslTurso = -not $UseNativeTurso
    if ($UseWslTurso) {
        if (-not (Test-CommandAvailable -CommandName "wsl")) {
            throw "wsl is required for Turso on Windows. See docs/CLI_PATHS_WINDOWS.md (or pass -UseNativeTurso on Linux)."
        }
    }
    elseif (-not (Test-CommandAvailable -CommandName "turso")) {
        $homeTurso = Join-Path $HOME ".turso/turso"
        if (Test-Path $homeTurso) {
            $env:Path = "$(Split-Path $homeTurso -Parent)$([IO.Path]::PathSeparator)$env:Path"
        }
        else {
            throw "Turso CLI not on PATH. See docs/CLI_PATHS_WINDOWS.md"
        }
    }

    if (-not (Test-CommandAvailable -CommandName "node")) {
        throw "node is required to resolve/verify Worker Turso."
    }

    # Node only reads process env, and a deploy child does not load .env.dev unless this
    # script does. Fill allowlisted keys that are still empty; never overwrite. A missing
    # file is not an error: explicit exports (Linux / -UseNativeTurso) work without it, and
    # the resolver reports missing values precisely (resolve_failed / org_suffix_unresolved).
    $envDev = Join-Path $repoRoot ".env.dev"
    if (Test-Path -LiteralPath $envDev -PathType Leaf) {
        $filledKeys = Import-EnvFileFillMissing -Path $envDev -Keys $script:ProductionBackupEnvDevKeys
        $filledText = if ($filledKeys.Count -gt 0) { $filledKeys -join ", " } else { "none (all preset or absent)" }
        Write-Host "Filled from .env.dev (names only): $filledText" -ForegroundColor DarkGray
    }
    else {
        Write-Host "No $envDev; using process env only." -ForegroundColor DarkGray
    }

    $timestampUtc = (Get-Date).ToUniversalTime().ToString("yyyyMMdd-HHmmss")
    $branchName = "prod-backup-$timestampUtc"
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

    $sourceDatabase = if (-not [string]::IsNullOrWhiteSpace($DatabaseNameOverride)) {
        $DatabaseNameOverride.Trim()
    }
    else {
        [string]$resolved.databaseName
    }
    $workerHost = [string]$resolved.workerTursoHost
    $postCount = [int]($resolved.postCount)
    $weeklySample = @($resolved.weeklySlugsSample)

    Write-Host "Worker host:     $workerHost" -ForegroundColor Green
    Write-Host "Source database: $sourceDatabase  (whatever the production Worker points at — NOT the backup name)" -ForegroundColor Green
    Write-Host "Backup branch:   $branchName  (always prod-backup-<stamp>; never named after the source)" -ForegroundColor Green
    Write-Host "Published posts: $postCount" -ForegroundColor Green
    if ($resolved.warnings) {
        foreach ($w in @($resolved.warnings)) {
            Write-Warning $w
        }
    }
    if ($sourceDatabase -eq "freedomtimes-emdash-production") {
        Write-Warning "Source is the named production DB. Confirm Worker host is correct before treating this as the live corpus."
    }

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
        # Branch-only: need credentials — mint via turso tokens create is operator-side;
        # for verify without file we fail clearly.
        throw "Verify requires the local file export (omit -SkipFileExport) so inventory can be checked offline."
    }
    if (-not $SkipStagingCompare) {
        $verifyArgs.Add("--compare-staging")
    }

    Write-Host "Verifying backup against live Worker inventory…" -ForegroundColor Cyan
    $verifyRun = Invoke-External -FilePath "node" -Arguments $verifyArgs.ToArray() -CaptureOutput -AllowFailure
    $verifyRun.Output | ForEach-Object { $_ }
    $verifyPass = $verifyRun.ExitCode -eq 0
    $verification = $null
    if (Test-Path -LiteralPath $verifyReportPath) {
        $verification = Get-Content -LiteralPath $verifyReportPath -Raw | ConvertFrom-Json
    }

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
            backupNaming           = "Turso branch is always prod-backup-YYYYMMDD-HHMMSS (never the Worker source name)."
            posts                  = $postsObj
            postCount              = $postCount
            weeklySlugsSample      = $weeklySample
            verificationPass       = $verifyPass
            freedomtimesMetadata   = (".release/rollback-branches/" + $metadataFileName)
            notes                  = $Notes
        }
        $logPayload | ConvertTo-Json -Depth 12 | Set-Content -Path $logPayloadPath -Encoding UTF8
        $logWriter = Join-Path $repoRoot "web/scripts/write-emdash-backup-log.mjs"
        $logArgs = @(
            $logWriter, "--from-json", $logPayloadPath, "--stamp", $timestampUtc, "--agents-dir", $AgentsRepo
        )
        $logRun = Invoke-External -FilePath "node" -Arguments $logArgs -CaptureOutput
        $agentsLogPath = ($logRun.Output | Select-Object -Last 1).ToString().Trim()
        Write-Host "Agents backup log (commit this): $agentsLogPath" -ForegroundColor Green
        Write-Host "Required: git add + commit that JSON in freedomtimes-agents (no tokens, no .db)." -ForegroundColor Cyan
    }
    else {
        Write-Warning "Skipping freedomtimes-agents backup log (-SkipAgentsLog). Operator policy is to always write and commit data/backups/prod-emdash-*.json."
    }

    if (-not $verifyPass) {
        throw "PRODUCTION BACKUP VERIFY FAILED. Refusing to treat this checkpoint as good. See $verifyReportPath and $metadataFilePath"
    }
    Write-Host "PASS: production EmDash backup verified (branch + file + metadata + agents log)." -ForegroundColor Green
    Write-Host "Backup name: $branchName  (of Worker source '$sourceDatabase')" -ForegroundColor Green
    Write-Host "Look here: freedomtimes-agents/data/backups/prod-emdash-$timestampUtc.json  (canonical record)" -ForegroundColor Cyan
    Write-Host "Also: .release/rollback-branches/ + .release/backups/emdash-production-$timestampUtc.db" -ForegroundColor Cyan
}
finally {
    Pop-Location
}
