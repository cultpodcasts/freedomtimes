
[CmdletBinding()]
param(
    [switch]$SyncCloudflareWorkerSecrets,
    [switch]$AllowProduction
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $AllowProduction) {
    throw "Refusing to deploy the production Worker without -AllowProduction."
}

$repoRoot = Split-Path $PSScriptRoot -Parent
$productionEnvDir = Join-Path $repoRoot "infra/terraform/environments/production"
$secretSyncScript = Join-Path $PSScriptRoot "set-github-secrets.ps1"

function Write-Step {
    param([string]$Message)
    $timestamp = Get-Date -Format "yyyy-MM-ddTHH:mm:ssK"
    Write-Host "[$timestamp] $Message" -ForegroundColor Cyan
}

function Get-TerraformOutputRaw {
    param([string]$Name)
    Push-Location $productionEnvDir
    try {
        $value = (& terraform output -raw $Name).Trim()
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($value)) {
            throw "Failed to read terraform output '$Name' from $productionEnvDir. Run terraform apply or fix credentials."
        }
        return $value
    }
    finally {
        Pop-Location
    }
}

Write-Step "Local production Worker deploy (no GitHub Actions)"
Write-Step "Reading Turso build credentials from Terraform outputs"

$env:TURSO_DATABASE_URL = Get-TerraformOutputRaw -Name "turso_database_url"
$env:TURSO_AUTH_TOKEN   = Get-TerraformOutputRaw -Name "turso_database_auth_token"

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

Write-Step "Building web (npm run build)"
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
Write-Host "Worker name: $(Get-TerraformOutputRaw -Name 'worker_name')" -ForegroundColor Green
