[CmdletBinding()]
param(
    [switch]$SyncCloudflareWorkerSecrets,
    [switch]$SkipVersionBump
)

<#
.SYNOPSIS
  Build and deploy staging Cloudflare Workers (web + scheduler) without Terraform.

.DESCRIPTION
  Intentionally separate from scripts/Invoke-EnvironmentRebuild.ps1 (web worker only).
  Loads Turso build credentials from repo-root .env.dev, runs npm run build in web/,
  then deploys freedomtimes-staging and freedomtimes-scheduler-staging via npx wrangler.

  Required in .env.dev:
    TURSO_DATABASE_URL, TURSO_AUTH_TOKEN

  Optional (wrangler / Cloudflare):
    TF_VAR_CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_ACCOUNT_ID

  Terraform is never invoked. For infra changes use scripts/terraform-run.ps1 separately.

.EXAMPLE
  cd c:\Users\jonbr\source\repos\freedomtimes
  .\scripts\deploy-staging-workers-only.ps1
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path $PSScriptRoot -Parent
$baseEnvPath = Join-Path $repoRoot ".env.dev"
$secretSyncScript = Join-Path $PSScriptRoot "set-github-secrets.ps1"
$stagingSiteOrigin = "https://staging.freedomtimes.news"

function Write-Step {
    param([string]$Message)
    $timestamp = Get-Date -Format "yyyy-MM-ddTHH:mm:ssK"
    Write-Host "[$timestamp] $Message" -ForegroundColor Cyan
}

function Import-EnvFile {
    param([string]$Path)

    if (-not (Test-Path $Path)) {
        throw "Missing $Path. Add TURSO_DATABASE_URL and TURSO_AUTH_TOKEN for Astro build."
    }

    Get-Content $Path | ForEach-Object {
        $line = $_.Trim()
        if ([string]::IsNullOrWhiteSpace($line) -or $line.StartsWith("#")) { return }
        if ($line -match '^[A-Za-z_][A-Za-z0-9_]*=') {
            $parts = $line -split '=', 2
            $key = $parts[0].Trim().Trim([char]0xFEFF)
            $value = $parts[1].Trim().Trim([char]0xFEFF)
            [Environment]::SetEnvironmentVariable($key, $value, "Process")
        }
    }
}

function Get-EnvFileValue {
    param(
        [string]$Path,
        [string]$Key
    )

    if (-not (Test-Path $Path)) { return "" }

    $line = Get-Content $Path | Where-Object { $_ -match "^$([regex]::Escape($Key))=" } | Select-Object -First 1
    if ([string]::IsNullOrWhiteSpace($line)) { return "" }
    return ($line -split '=', 2)[1].Trim()
}

function Get-FirstNonEmpty {
    param([string[]]$Values)

    foreach ($value in $Values) {
        if (-not [string]::IsNullOrWhiteSpace($value)) {
            return $value.Trim()
        }
    }
    return ""
}

function Assert-RequiredBuildEnv {
    $missing = @()
    foreach ($key in @("TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN")) {
        $value = [Environment]::GetEnvironmentVariable($key, "Process")
        if ([string]::IsNullOrWhiteSpace($value)) {
            $missing += $key
        }
    }

    if ($missing.Count -gt 0) {
        throw "Missing required values in .env.dev (or empty after load): $($missing -join ', ')"
    }
}

function Assert-FreshWebBuild {
    param(
        [string]$DistDir,
        [datetime]$BuildStartedAt
    )

    if (-not (Test-Path $DistDir)) {
        throw "Web build output missing at $DistDir. Deploy aborted."
    }

    $serverDir = Join-Path $DistDir "server"
    if (-not (Test-Path $serverDir)) {
        throw "Web build incomplete: missing $serverDir. Deploy aborted."
    }

    $newestFile = Get-ChildItem -Path $DistDir -Recurse -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1

    if ($null -eq $newestFile) {
        throw "Web build output directory is empty at $DistDir. Deploy aborted."
    }

    $staleMargin = [TimeSpan]::FromSeconds(2)
    if ($newestFile.LastWriteTime -lt ($BuildStartedAt - $staleMargin)) {
        throw @(
            "Web build output appears stale (newest file $($newestFile.FullName) at $($newestFile.LastWriteTime) predates build started at $BuildStartedAt).",
            "Deploy aborted; fix the build before deploying the web worker."
        ) -join " "
    }
}

function Get-StagingWebWranglerVarArgs {
    $audience = Get-FirstNonEmpty -Values @(
        ([Environment]::GetEnvironmentVariable("AUTH0_API_AUDIENCE_STAGING", "Process")),
        (Get-EnvFileValue -Path $baseEnvPath -Key "AUTH0_API_AUDIENCE_STAGING"),
        ([Environment]::GetEnvironmentVariable("AUTH0_API_AUDIENCE", "Process")),
        (Get-EnvFileValue -Path $baseEnvPath -Key "AUTH0_API_AUDIENCE"),
        "https://api.freedomtimes.news"
    )

    $rolesClaim = Get-FirstNonEmpty -Values @(
        ([Environment]::GetEnvironmentVariable("AUTH0_ROLES_CLAIM_NAMESPACE", "Process")),
        (Get-EnvFileValue -Path $baseEnvPath -Key "AUTH0_ROLES_CLAIM_NAMESPACE"),
        "https://freedomtimes.news/roles"
    )

    $pairs = [ordered]@{
        AUTH0_API_AUDIENCE            = $audience
        API_BASE_URL                  = "https://api-staging.freedomtimes.news/editorial"
        COOKIE_BASE_DOMAIN            = "freedomtimes.news"
        AUTH0_ROLES_CLAIM_NAMESPACE   = $rolesClaim
        API_UPSTREAM_MODE             = "apim"
    }

    $wranglerVarList = New-Object System.Collections.Generic.List[string]
    foreach ($entry in $pairs.GetEnumerator()) {
        $wranglerVarList.Add("--var")
        $wranglerVarList.Add("$($entry.Key):$($entry.Value)")
    }
    return $wranglerVarList.ToArray()
}

function Ensure-CloudflareAccountId {
    if (-not [string]::IsNullOrWhiteSpace($env:CLOUDFLARE_ACCOUNT_ID)) { return }

    $accountId = Get-FirstNonEmpty -Values @(([Environment]::GetEnvironmentVariable("TF_VAR_CLOUDFLARE_ACCOUNT_ID", "Process")), (Get-EnvFileValue -Path $baseEnvPath -Key "TF_VAR_CLOUDFLARE_ACCOUNT_ID"))

    if ($accountId) {
        $env:CLOUDFLARE_ACCOUNT_ID = $accountId
    }
}

Write-Step "Staging workers-only deploy (no Terraform)"
Write-Step "Loading .env.dev"
Import-EnvFile -Path $baseEnvPath
Assert-RequiredBuildEnv
Ensure-CloudflareAccountId

if ($SyncCloudflareWorkerSecrets) {
    Write-Step "Syncing Worker secrets to Cloudflare from .env files"
    $pwsh = Get-Command pwsh -ErrorAction SilentlyContinue
    if ($null -eq $pwsh) {
        throw "pwsh (PowerShell 7+) is required for set-github-secrets.ps1."
    }
    & pwsh -NoProfile -File $secretSyncScript -Target Staging -SyncCloudflareWorkerSecrets
    if ($LASTEXITCODE -ne 0) {
        throw "Cloudflare Worker secret sync failed."
    }
}

if ($SkipVersionBump) {
    Write-Step "Skipping web version bump (-SkipVersionBump)"
} else {
    . "$PSScriptRoot/bump-web-version.ps1"
    Invoke-WebVersionBump -RepoRoot $repoRoot | Out-Null
}

Write-Step "Building web (npm run build)"
$buildStartedAt = Get-Date
. "$PSScriptRoot/build-provenance-env.ps1"
Set-BuildProvenanceEnv -RepoRoot $repoRoot
Push-Location (Join-Path $repoRoot "web")
try {
    & npm run build
    if ($LASTEXITCODE -ne 0) {
        throw "npm run build failed (exit $LASTEXITCODE). Web worker deploy aborted."
    }
}
finally {
    Pop-Location
}

$webDistDir = Join-Path $repoRoot "web\dist"
Assert-FreshWebBuild -DistDir $webDistDir -BuildStartedAt $buildStartedAt

$webVarArgs = Get-StagingWebWranglerVarArgs

Write-Step "Deploying web worker (freedomtimes-staging)"
Push-Location $repoRoot
try {
    & npx wrangler deploy --config .\web\wrangler.jsonc --env staging $webVarArgs
    if ($LASTEXITCODE -ne 0) {
        throw "Web worker wrangler deploy failed."
    }
}
finally {
    Pop-Location
}

Write-Step "Deploying scheduler worker (freedomtimes-scheduler-staging)"
Push-Location (Join-Path $repoRoot "scheduler-worker")
try {
    & npx wrangler deploy --config wrangler.jsonc --env staging
    if ($LASTEXITCODE -ne 0) {
        throw "Scheduler worker wrangler deploy failed."
    }
}
finally {
    Pop-Location
}

Write-Step "Staging workers deploy complete"
Write-Host "Web worker:    freedomtimes-staging" -ForegroundColor Green
Write-Host "Scheduler:     freedomtimes-scheduler-staging" -ForegroundColor Green
Write-Host "Staging site:  $stagingSiteOrigin" -ForegroundColor Green



