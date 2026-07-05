
[CmdletBinding()]
param(
    [switch]$SyncCloudflareWorkerSecrets,
    [switch]$AllowProduction,
    [switch]$DryRun,
    [switch]$SkipVersionBump
)

<#
.SYNOPSIS
  Build and deploy the production Cloudflare Worker without GitHub Actions.

.DESCRIPTION
  Resolves EmDash Turso build credentials from Terraform outputs when present,
  otherwise from repo-root .env.dev (TURSO_PRODUCTION_EMDASH_* or production-prefixed
  scheduler/subscriptions/tips URLs for derivation). Terraform apply is not required
  when .env.dev is populated.

  Use -DryRun to verify credential resolution without building or deploying.

.EXAMPLE
  pwsh ./scripts/deploy-production-worker-local.ps1 -AllowProduction -DryRun
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $AllowProduction) {
    throw "Refusing to deploy the production Worker without -AllowProduction."
}

$repoRoot = Split-Path $PSScriptRoot -Parent
. "$PSScriptRoot/ensure-windows-cli-path.ps1"
Initialize-WindowsCliPath
$productionEnvDir = Join-Path $repoRoot "infra/terraform/environments/production"
$secretSyncScript = Join-Path $PSScriptRoot "set-github-secrets.ps1"

function Write-Step {
    param([string]$Message)
    $timestamp = Get-Date -Format "yyyy-MM-ddTHH:mm:ssK"
    Write-Host "[$timestamp] $Message" -ForegroundColor Cyan
}

function Get-WorkerNameForDisplay {
    . "$PSScriptRoot/resolve-turso-build-credentials.ps1"
    $terraformExe = Resolve-TerraformExecutable
    $workerName = Try-TerraformOutputRaw -TerraformExe $terraformExe -TerraformEnvDir $productionEnvDir -OutputName "worker_name"
    if (-not [string]::IsNullOrWhiteSpace($workerName)) {
        return $workerName
    }

    $workerFromEnv = [Environment]::GetEnvironmentVariable("TF_VAR_WORKER_NAME_PRODUCTION", "Process")
    if (-not [string]::IsNullOrWhiteSpace($workerFromEnv)) {
        return $workerFromEnv.Trim()
    }

    return "freedomtimes"
}

Write-Step "Local production Worker deploy (no GitHub Actions)"
Write-Step "Resolving Turso build credentials (Terraform or .env.dev)"

. "$PSScriptRoot/resolve-turso-build-credentials.ps1"
$resolved = Set-TursoBuildEnv -Environment production -RepoRoot $repoRoot
Write-Host "  TURSO_DATABASE_URL <= $($resolved.Url.Source)" -ForegroundColor DarkGray
Write-Host "  TURSO_AUTH_TOKEN   <= $($resolved.Token.Source)" -ForegroundColor DarkGray

if ($DryRun) {
    Write-Step "Dry run complete — Turso credentials resolved; skipping build and deploy"
    Write-Host "Worker name (display): $(Get-WorkerNameForDisplay)" -ForegroundColor Green
    return
}

if ($SyncCloudflareWorkerSecrets) {
    Write-Step "Syncing Worker secrets to Cloudflare from .env files"
    $pwsh = Get-Command pwsh -ErrorAction SilentlyContinue
    if ($null -eq $pwsh) {
        throw "pwsh (PowerShell 7+) is required for set-github-secrets.ps1. Install PowerShell 7 or run that script manually."
    }
    & pwsh -NoProfile -File $secretSyncScript -Target Production -SyncCloudflareWorkerSecrets -AllowProduction
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
. "$PSScriptRoot/build-provenance-env.ps1"
Set-BuildProvenanceEnv -RepoRoot $repoRoot
Push-Location (Join-Path $repoRoot "web")
try {
    & npm run build
    if ($LASTEXITCODE -ne 0) {
        throw "npm run build failed."
    }
}
finally {
    Pop-Location
}

Write-Step "Deploying Worker (wrangler deploy --env production)"
Push-Location $repoRoot
try {
    & npx wrangler deploy --config .\web\wrangler.jsonc --env production
    if ($LASTEXITCODE -ne 0) {
        throw "Wrangler deploy failed."
    }
}
finally {
    Pop-Location
}

Write-Step "Production Worker deploy finished"
Write-Host "Worker name: $(Get-WorkerNameForDisplay)" -ForegroundColor Green
