# Sets FT_BUILD_COMMIT_SHA / FT_BUILD_TREE_DIRTY / FT_BUILD_VERSION / GITHUB_REPOSITORY before `npm run build`.
# Dot-source from deploy scripts: . "$PSScriptRoot/build-provenance-env.ps1"
#
# #168: the deployed version is stamped here, at deploy time. PRs never edit the version and
# nothing commits back to main. web/package.json `version` is only the BASE (change it only to
# start a new minor/major line, and never lower it). Get-BuildVersion derives the stamp:
#
# | Build                                   | FT_BUILD_VERSION                                  | Example               |
# |-----------------------------------------|---------------------------------------------------|-----------------------|
# | GitHub Actions, production              | <major>.<minor>.<basePatch + GITHUB_RUN_NUMBER>   | 0.0.57 + run 60 -> 0.0.117 |
# | GitHub Actions, staging (PR)            | same number + -staging.pr.<PR>                    | 0.0.117-staging.pr.168 |
# | Local deploy script (either env)        | <base>-local.<sha7>[.dirty]                       | 0.0.57-local.1a2b3c4  |
#
# The run number is the deploy-worker.yml run counter (one counter for staging and production
# runs), so the production number only ever goes up, and re-running a run keeps its version.
# The counter belongs to the workflow FILE: renaming or deleting/recreating deploy-worker.yml
# restarts it at 1. Raise the base minor in web/package.json in the same PR before doing that.
# The stamp is baked into the build (FT_* is a vite envPrefix) and served by /api/version.json
# (`version`) next to `commitSha`, which #142/#144/#148 read.

function Get-BuildVersion {
    param(
        [Parameter(Mandatory = $true)]
        [string]$BaseVersion,
        [Parameter(Mandatory = $true)]
        [ValidateSet("staging", "production")]
        [string]$Environment,
        [string]$RunNumber = "",
        [string]$PullRequestNumber = "",
        [string]$CommitSha = "",
        [bool]$Dirty = $false,
        [bool]$IsCi = $false
    )

    $base = $BaseVersion.Trim()
    if ($base -notmatch '^(\d+)\.(\d+)\.(\d+)$') {
        throw "web/package.json version '$base' is not a plain major.minor.patch base version (#168)."
    }
    $major = [int64]$Matches[1]; $minor = [int64]$Matches[2]; $patch = [int64]$Matches[3]

    if (-not $IsCi) {
        $short = if ($CommitSha -match '^[0-9a-fA-F]{7,}$') { $CommitSha.Substring(0, 7).ToLowerInvariant() } else { "unknown" }
        $suffix = "local.$short"
        if ($Dirty) { $suffix += ".dirty" }
        return "$base-$suffix"
    }

    if ($RunNumber -notmatch '^\d+$' -or [int64]$RunNumber -lt 1) {
        throw "GITHUB_RUN_NUMBER '$RunNumber' is not a positive integer; cannot stamp the deploy version (#168)."
    }
    $stamped = "$major.$minor.$($patch + [int64]$RunNumber)"
    if ($Environment -eq "production") {
        return $stamped
    }
    if ($PullRequestNumber -match '^\d+$') {
        return "$stamped-staging.pr.$PullRequestNumber"
    }
    return "$stamped-staging"
}

function Set-BuildProvenanceEnv {
    param(
        [string]$RepoRoot = (Split-Path $PSScriptRoot -Parent),
        [ValidateSet("staging", "production")]
        [string]$Environment = "staging"
    )

    $commitSha = ""
    $isDirty = $false
    $git = Get-Command git -ErrorAction SilentlyContinue
    if ($null -eq $git) {
        Write-Warning "git not found; build provenance commit SHA will be unknown."
    }
    else {
        $commitSha = [string](& git -C $RepoRoot rev-parse HEAD 2>$null)
        $commitSha = $commitSha.Trim()
        if ($commitSha) {
            [Environment]::SetEnvironmentVariable("FT_BUILD_COMMIT_SHA", $commitSha, "Process")
        }

        $dirtyOutput = (& git -C $RepoRoot status --porcelain 2>$null)
        $isDirty = -not [string]::IsNullOrWhiteSpace($dirtyOutput)
        [Environment]::SetEnvironmentVariable("FT_BUILD_TREE_DIRTY", $(if ($isDirty) { "1" } else { "0" }), "Process")
    }

    if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable("GITHUB_REPOSITORY", "Process"))) {
        [Environment]::SetEnvironmentVariable("GITHUB_REPOSITORY", "cultpodcasts/freedomtimes", "Process")
    }

    $packageJsonPath = Join-Path (Join-Path $RepoRoot "web") "package.json"
    $baseVersion = [string]((Get-Content -Raw -LiteralPath $packageJsonPath | ConvertFrom-Json).version)
    $isCi = ([Environment]::GetEnvironmentVariable("GITHUB_ACTIONS", "Process") -eq "true")
    $version = Get-BuildVersion -BaseVersion $baseVersion -Environment $Environment `
        -RunNumber ([string][Environment]::GetEnvironmentVariable("GITHUB_RUN_NUMBER", "Process")) `
        -PullRequestNumber ([string][Environment]::GetEnvironmentVariable("FT_DEPLOY_PR_NUMBER", "Process")) `
        -CommitSha $commitSha -Dirty $isDirty -IsCi $isCi
    [Environment]::SetEnvironmentVariable("FT_BUILD_VERSION", $version, "Process")
    Write-Host "[version] $Environment build version: $version (base $baseVersion from web/package.json; not written back)" -ForegroundColor Cyan

    $summary = [Environment]::GetEnvironmentVariable("GITHUB_STEP_SUMMARY", "Process")
    if (-not [string]::IsNullOrWhiteSpace($summary)) {
        $shortSha = if ($commitSha.Length -ge 7) { $commitSha.Substring(0, 7) } else { "unknown" }
        @(
            "### Build version ($Environment)",
            "- Version: ``$version`` (served at ``/api/version.json`` as ``version``)",
            "- Commit: ``$shortSha``; base ``$baseVersion`` from web/package.json"
        ) | Add-Content -LiteralPath $summary
    }

    return $version
}
