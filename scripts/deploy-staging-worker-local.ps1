
[CmdletBinding()]
param(
    [switch]$SyncCloudflareWorkerSecrets
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path $PSScriptRoot -Parent
$stagingEnvDir = Join-Path $repoRoot "infra/terraform/environments/staging"
$secretSyncScript = Join-Path $PSScriptRoot "set-github-secrets.ps1"
$baseEnvPath = Join-Path $repoRoot ".env.dev"

function Write-Step {
    param([string]$Message)
    $timestamp = Get-Date -Format "yyyy-MM-ddTHH:mm:ssK"
    Write-Host "[$timestamp] $Message" -ForegroundColor Cyan
}

function Get-TerraformOutputRaw {
    param([string]$Name)
    Push-Location $stagingEnvDir
    try {
        $value = (& terraform output -raw $Name).Trim()
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($value)) {
            throw "Failed to read terraform output '$Name' from $stagingEnvDir. Run terraform apply or fix credentials."
        }
        return $value
    }
    finally {
        Pop-Location
    }
}

Write-Step "Local staging Worker deploy (no GitHub Actions)"
Write-Step "Reading Turso build credentials from Terraform outputs"

$env:TURSO_DATABASE_URL = Get-TerraformOutputRaw -Name "turso_database_url"
$env:TURSO_AUTH_TOKEN   = Get-TerraformOutputRaw -Name "turso_database_auth_token"

if ($SyncCloudflareWorkerSecrets) {
    Write-Step "Syncing Worker secrets to Cloudflare from .env files"
    if (-not $env:CLOUDFLARE_ACCOUNT_ID) {
        if (Test-Path $baseEnvPath) {
            $line = Get-Content $baseEnvPath | Where-Object { $_ -match '^TF_VAR_CLOUDFLARE_ACCOUNT_ID=' } | Select-Object -First 1
            if ($line) {
                $env:CLOUDFLARE_ACCOUNT_ID = ($line -split '=', 2)[1].Trim()
            }
        }
    }
    $pwsh = Get-Command pwsh -ErrorAction SilentlyContinue
    if ($null -eq $pwsh) {
        throw "pwsh (PowerShell 7+) is required for set-github-secrets.ps1. Install PowerShell 7 or run that script manually."
    }
    & pwsh -NoProfile -File $secretSyncScript -Target Staging -SyncCloudflareWorkerSecrets
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

Write-Step "Deploying Worker (wrangler deploy --env staging)"
Push-Location $repoRoot
try {
    & npx wrangler deploy --config .\web\wrangler.jsonc --env staging
    if ($LASTEXITCODE -ne 0) {
        throw "Wrangler deploy failed."
    }
}
finally {
    Pop-Location
}

Write-Step "Staging Worker deploy finished"
Write-Host "Worker name: $(Get-TerraformOutputRaw -Name 'worker_name')" -ForegroundColor Green
