<#
.SYNOPSIS
    Sets GitHub Actions secrets and variables for the freedomtimes repo from .env.dev.

.DESCRIPTION
    Reads TF_VAR_* values from .env.dev in the repo root and pushes them to
    GitHub Actions secrets (sensitive) and variables (non-sensitive) via gh CLI.

    Secrets  → Settings > Secrets and variables > Actions > Secrets
    Variables → Settings > Secrets and variables > Actions > Variables

.EXAMPLE
    .\scripts\set-github-secrets.ps1
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path $PSScriptRoot -Parent
$envFile  = Join-Path $repoRoot ".env.dev"

if (-not (Test-Path $envFile)) {
    Write-Error ".env.dev not found at $envFile. Copy .env.dev.example and fill in real values."
    exit 1
}

# Parse .env.dev into a hashtable
$env = @{}
Get-Content $envFile | ForEach-Object {
    $line = $_.Trim()
    if ([string]::IsNullOrWhiteSpace($line) -or $line.StartsWith("#")) {
        return
    }

    if ($line -match '^[A-Za-z_][A-Za-z0-9_]*=') {
        $parts = $line -split '=', 2
        $env[$parts[0].Trim()] = $parts[1].Trim()
    }
}

$repo = "cultpodcasts/freedomtimes"
$tfcCredsFile = Join-Path $env:APPDATA "terraform.d\credentials.tfrc.json"

function Get-TfcTokenFromCredentials {
    param(
        [string]$FilePath
    )

    if (-not (Test-Path $FilePath)) {
        return ""
    }

    try {
        $json = Get-Content $FilePath -Raw | ConvertFrom-Json
        return [string]$json.credentials."app.terraform.io".token
    }
    catch {
        return ""
    }
}

function Get-EnvValue {
    param(
        [hashtable]$Values,
        [string[]]$Keys
    )

    foreach ($key in $Keys) {
        if ($Values.ContainsKey($key) -and -not [string]::IsNullOrWhiteSpace($Values[$key])) {
            return $Values[$key]
        }
    }

    return ""
}

# ---------------------------------------------------------------------------
# Secrets  (sensitive — stored encrypted, never visible after setting)
# ---------------------------------------------------------------------------
$secrets = [ordered]@{
    TF_VAR_CLOUDFLARE_API_TOKEN  = $env["TF_VAR_cloudflare_api_token"]
    TF_VAR_CLOUDFLARE_ACCOUNT_ID = $env["TF_VAR_cloudflare_account_id"]
    TF_VAR_CLOUDFLARE_ZONE_ID    = $env["TF_VAR_cloudflare_zone_id"]
    TF_VAR_AUTH0_DOMAIN           = $env["TF_VAR_auth0_domain"]
    TF_VAR_AUTH0_CLIENT_ID        = $env["TF_VAR_auth0_client_id"]
    TF_VAR_AUTH0_CLIENT_SECRET    = $env["TF_VAR_auth0_client_secret"]
    TF_VAR_AUTH0_ACTION_CLIENT_ID     = $env["TF_VAR_auth0_action_client_id"]
    TF_VAR_AUTH0_ACTION_CLIENT_SECRET = $env["TF_VAR_auth0_action_client_secret"]
    AUTH0_LOGIN_APP_CLIENT_ID_STAGING        = Get-EnvValue -Values $env -Keys @("AUTH0_LOGIN_APP_CLIENT_ID_STAGING", "AUTH0_STAGING_APP_CLIENT_ID", "AUTH0_APP_CLIENT_ID_STAGING")
    AUTH0_LOGIN_APP_CLIENT_SECRET_STAGING    = Get-EnvValue -Values $env -Keys @("AUTH0_LOGIN_APP_CLIENT_SECRET_STAGING", "AUTH0_STAGING_APP_CLIENT_SECRET", "AUTH0_APP_CLIENT_SECRET_STAGING")
    AUTH0_LOGIN_APP_CLIENT_ID_PRODUCTION     = Get-EnvValue -Values $env -Keys @("AUTH0_LOGIN_APP_CLIENT_ID_PRODUCTION", "AUTH0_PRODUCTION_APP_CLIENT_ID", "AUTH0_APP_CLIENT_ID_PRODUCTION")
    AUTH0_LOGIN_APP_CLIENT_SECRET_PRODUCTION = Get-EnvValue -Values $env -Keys @("AUTH0_LOGIN_APP_CLIENT_SECRET_PRODUCTION", "AUTH0_PRODUCTION_APP_CLIENT_SECRET", "AUTH0_APP_CLIENT_SECRET_PRODUCTION")
}

Write-Host "`nSetting secrets..." -ForegroundColor Cyan
foreach ($name in $secrets.Keys) {
    $value = $secrets[$name]
    if ([string]::IsNullOrEmpty($value)) {
        Write-Warning "Skipping secret $name — value is empty in .env.dev"
        continue
    }
    $value | gh secret set $name --repo $repo
    Write-Host "  ✓ $name" -ForegroundColor Green
}

# ---------------------------------------------------------------------------
# Terraform Cloud auth secret
# ---------------------------------------------------------------------------
$tfcToken = Get-TfcTokenFromCredentials -FilePath $tfcCredsFile
if ([string]::IsNullOrWhiteSpace($tfcToken)) {
    Write-Warning "Terraform Cloud token not found in $tfcCredsFile. Skipping TF_TOKEN_app_terraform_io."
}
else {
    $tfcToken | gh secret set TF_TOKEN_app_terraform_io --repo $repo
    Write-Host "  ✓ TF_TOKEN_app_terraform_io" -ForegroundColor Green
}

# ---------------------------------------------------------------------------
# Variables (non-sensitive — visible in workflow logs)
# ---------------------------------------------------------------------------
$variables = [ordered]@{
    TFC_ORGANIZATION      = "freedomtimes"
    TFC_WORKSPACE_PRODUCTION = "freedomtimes-production"
    TF_VAR_ROUTE_PATTERN   = $env["TF_VAR_route_pattern"]
    TF_VAR_WORKER_NAME     = $env["TF_VAR_worker_name"]
    TF_VAR_HOLDING_TITLE   = $env["TF_VAR_holding_title"]
    TF_VAR_HOLDING_HEADING = $env["TF_VAR_holding_heading"]
    TF_VAR_HOLDING_MESSAGE = $env["TF_VAR_holding_message"]
    TF_VAR_CONTACT_EMAIL   = $env["TF_VAR_contact_email"]
}

Write-Host "`nSetting variables..." -ForegroundColor Cyan
foreach ($name in $variables.Keys) {
    $value = $variables[$name]
    if ([string]::IsNullOrEmpty($value)) {
        Write-Warning "Skipping variable $name — value is empty in .env.dev (set it manually if needed)"
        continue
    }
    gh variable set $name --body $value --repo $repo
    Write-Host "  ✓ $name = $value" -ForegroundColor Green
}

Write-Host "`nDone. All secrets and variables are set." -ForegroundColor Cyan
Write-Host "You can verify at: https://github.com/$repo/settings/secrets/actions" -ForegroundColor Gray
