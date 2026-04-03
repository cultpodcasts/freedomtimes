<#
.SYNOPSIS
    Syncs GitHub Actions secrets/variables (and optionally Cloudflare Worker secrets) from .env.dev.

.EXAMPLE
    .\scripts\set-github-secrets.ps1

.EXAMPLE
    .\scripts\set-github-secrets.ps1 -DryRun

.EXAMPLE
    .\scripts\set-github-secrets.ps1 -SyncCloudflareWorkerSecrets
#>

[CmdletBinding()]
param(
    [string]$Repo = "cultpodcasts/freedomtimes",
    [switch]$DryRun,
    [switch]$SyncCloudflareWorkerSecrets
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path $PSScriptRoot -Parent
$envFile = Join-Path $repoRoot ".env.dev"
$tfcCredsFile = Join-Path $env:APPDATA "terraform.d\credentials.tfrc.json"
$stagingWranglerConfig = Join-Path $repoRoot "web\wrangler.staging.jsonc"
$productionWranglerConfig = Join-Path $repoRoot "web\wrangler.production.jsonc"

if (-not (Test-Path $envFile)) {
    Write-Error ".env.dev not found at $envFile. Copy .env.dev.example and fill in real values."
    exit 1
}

function Parse-EnvFile {
    param([string]$Path)

    $values = @{}
    Get-Content $Path | ForEach-Object {
        $line = $_.Trim()
        if ([string]::IsNullOrWhiteSpace($line) -or $line.StartsWith("#")) {
            return
        }

        if ($line -match '^[A-Za-z_][A-Za-z0-9_]*=') {
            $parts = $line -split '=', 2
            $key = $parts[0].Trim().Trim([char]0xFEFF)
            $value = $parts[1].Trim().Trim([char]0xFEFF)
            $values[$key] = $value
        }
    }

    return $values
}

function Get-EnvValue {
    param(
        [hashtable]$Values,
        [string[]]$Keys,
        [string]$Default = ""
    )

    foreach ($key in $Keys) {
        if ($Values.ContainsKey($key) -and -not [string]::IsNullOrWhiteSpace([string]$Values[$key])) {
            return [string]$Values[$key]
        }
    }

    return $Default
}

function Set-GhSecret {
    param(
        [string]$Name,
        [string]$Value,
        [string]$Repository,
        [switch]$WhatIfOnly
    )

    if ([string]::IsNullOrWhiteSpace($Value)) {
        Write-Warning "Skipping secret $Name - value is empty in .env.dev"
        return
    }

    if ($WhatIfOnly) {
        Write-Host "  [dry-run] gh secret set $Name --repo $Repository" -ForegroundColor Yellow
        return
    }

    gh secret set $Name --repo $Repository --body $Value
    Write-Host "  [ok] $Name" -ForegroundColor Green
}

function Set-GhVariable {
    param(
        [string]$Name,
        [string]$Value,
        [string]$Repository,
        [switch]$WhatIfOnly
    )

    if ([string]::IsNullOrWhiteSpace($Value)) {
        Write-Warning "Skipping variable $Name - value is empty in .env.dev"
        return
    }

    if ($WhatIfOnly) {
        Write-Host "  [dry-run] gh variable set $Name --repo $Repository --body <value>" -ForegroundColor Yellow
        return
    }

    gh variable set $Name --repo $Repository --body $Value
    Write-Host "  [ok] $Name = $Value" -ForegroundColor Green
}

function Get-TfcTokenFromCredentials {
    param([string]$FilePath)

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

function Set-WorkerSecret {
    param(
        [string]$ConfigPath,
        [string]$Name,
        [string]$Value,
        [switch]$WhatIfOnly
    )

    if ([string]::IsNullOrWhiteSpace($Value)) {
        Write-Warning "Skipping Worker secret $Name for $ConfigPath - value is empty"
        return
    }

    if ($WhatIfOnly) {
        Write-Host "  [dry-run] wrangler secret put $Name --config $ConfigPath" -ForegroundColor Yellow
        return
    }

    $escaped = $Value.Replace("'", "''")
    $command = "printf '%s' '$escaped' | npx wrangler secret put $Name --config '$ConfigPath'"
    & bash -lc $command
    Write-Host "  [ok] Worker secret $Name via $ConfigPath" -ForegroundColor Green
}

$envValues = Parse-EnvFile -Path $envFile

Write-Host "`nSyncing GitHub Actions secrets..." -ForegroundColor Cyan
$secrets = [ordered]@{
    ARM_CLIENT_ID = (Get-EnvValue -Values $envValues -Keys @("ARM_CLIENT_ID"))
    ARM_CLIENT_SECRET = (Get-EnvValue -Values $envValues -Keys @("ARM_CLIENT_SECRET"))
    ARM_SUBSCRIPTION_ID = (Get-EnvValue -Values $envValues -Keys @("ARM_SUBSCRIPTION_ID"))
    ARM_TENANT_ID = (Get-EnvValue -Values $envValues -Keys @("ARM_TENANT_ID"))
    TF_VAR_CLOUDFLARE_API_TOKEN = (Get-EnvValue -Values $envValues -Keys @("TF_VAR_cloudflare_api_token"))
    TF_VAR_CLOUDFLARE_ACCOUNT_ID = (Get-EnvValue -Values $envValues -Keys @("TF_VAR_cloudflare_account_id"))
    TF_VAR_CLOUDFLARE_ZONE_ID = (Get-EnvValue -Values $envValues -Keys @("TF_VAR_cloudflare_zone_id"))
    TF_VAR_AUTH0_DOMAIN = (Get-EnvValue -Values $envValues -Keys @("TF_VAR_auth0_domain"))
    TF_VAR_AUTH0_CLIENT_ID = (Get-EnvValue -Values $envValues -Keys @("TF_VAR_auth0_client_id"))
    TF_VAR_AUTH0_CLIENT_SECRET = (Get-EnvValue -Values $envValues -Keys @("TF_VAR_auth0_client_secret"))
    AUTH0_LOGIN_APP_CLIENT_ID_STAGING = (Get-EnvValue -Values $envValues -Keys @("AUTH0_LOGIN_APP_CLIENT_ID_STAGING"))
    AUTH0_LOGIN_APP_CLIENT_SECRET_STAGING = (Get-EnvValue -Values $envValues -Keys @("AUTH0_LOGIN_APP_CLIENT_SECRET_STAGING"))
    AUTH0_LOGIN_APP_CLIENT_ID_PRODUCTION = (Get-EnvValue -Values $envValues -Keys @("AUTH0_LOGIN_APP_CLIENT_ID_PRODUCTION"))
    AUTH0_LOGIN_APP_CLIENT_SECRET_PRODUCTION = (Get-EnvValue -Values $envValues -Keys @("AUTH0_LOGIN_APP_CLIENT_SECRET_PRODUCTION"))
    TF_VAR_API_CUSTOM_HOSTNAME_CERTIFICATE_BASE64_STAGING = (Get-EnvValue -Values $envValues -Keys @("TF_VAR_api_custom_hostname_certificate_base64_staging", "TF_VAR_api_custom_hostname_certificate_base64"))
    TF_VAR_API_CUSTOM_HOSTNAME_CERTIFICATE_PASSWORD_STAGING = (Get-EnvValue -Values $envValues -Keys @("TF_VAR_api_custom_hostname_certificate_password_staging", "TF_VAR_api_custom_hostname_certificate_password"))
    TF_VAR_API_CUSTOM_HOSTNAME_CERTIFICATE_BASE64_PRODUCTION = (Get-EnvValue -Values $envValues -Keys @("TF_VAR_api_custom_hostname_certificate_base64_production"))
    TF_VAR_API_CUSTOM_HOSTNAME_CERTIFICATE_PASSWORD_PRODUCTION = (Get-EnvValue -Values $envValues -Keys @("TF_VAR_api_custom_hostname_certificate_password_production"))
}

foreach ($name in $secrets.Keys) {
    Set-GhSecret -Name $name -Value ([string]$secrets[$name]) -Repository $Repo -WhatIfOnly:$DryRun
}

$tfcToken = Get-TfcTokenFromCredentials -FilePath $tfcCredsFile
if ([string]::IsNullOrWhiteSpace($tfcToken)) {
    Write-Warning "Terraform Cloud token not found in $tfcCredsFile. Skipping TF_TOKEN_app_terraform_io."
}
else {
    Set-GhSecret -Name "TF_TOKEN_app_terraform_io" -Value $tfcToken -Repository $Repo -WhatIfOnly:$DryRun
}

Write-Host "`nSyncing GitHub Actions variables..." -ForegroundColor Cyan
$variables = [ordered]@{
    TFC_ORGANIZATION = "freedomtimes"
    TFC_WORKSPACE_PRODUCTION = "freedomtimes-production"

    TF_VAR_AZURE_LOCATION = (Get-EnvValue -Values $envValues -Keys @("TF_VAR_azure_location"))
    TF_VAR_ROUTE_PATTERN = (Get-EnvValue -Values $envValues -Keys @("TF_VAR_route_pattern"))
    TF_VAR_WORKER_NAME = (Get-EnvValue -Values $envValues -Keys @("TF_VAR_worker_name"))
    TF_VAR_HOLDING_TITLE = (Get-EnvValue -Values $envValues -Keys @("TF_VAR_holding_title"))
    TF_VAR_HOLDING_HEADING = (Get-EnvValue -Values $envValues -Keys @("TF_VAR_holding_heading"))
    TF_VAR_HOLDING_MESSAGE = (Get-EnvValue -Values $envValues -Keys @("TF_VAR_holding_message"))
    TF_VAR_CONTACT_EMAIL = (Get-EnvValue -Values $envValues -Keys @("TF_VAR_contact_email"))

    TF_VAR_AZURE_LOCATION_STAGING = (Get-EnvValue -Values $envValues -Keys @("TF_VAR_azure_location_staging", "TF_VAR_azure_location"))
    TF_VAR_ROUTE_PATTERN_STAGING = (Get-EnvValue -Values $envValues -Keys @("TF_VAR_route_pattern_staging", "TF_VAR_route_pattern"))
    TF_VAR_WORKER_NAME_STAGING = (Get-EnvValue -Values $envValues -Keys @("TF_VAR_worker_name_staging"))
    TF_VAR_MANAGE_APEX_DNS_RECORD_STAGING = (Get-EnvValue -Values $envValues -Keys @("TF_VAR_manage_apex_dns_record_staging", "TF_VAR_manage_apex_dns_record") -Default "false")
    TF_VAR_APEX_DNS_RECORD_CONTENT_STAGING = (Get-EnvValue -Values $envValues -Keys @("TF_VAR_apex_dns_record_content_staging", "TF_VAR_apex_dns_record_content") -Default "192.0.2.1")
    TF_VAR_API_CUSTOM_HOSTNAME_STAGING = (Get-EnvValue -Values $envValues -Keys @("TF_VAR_api_custom_hostname_staging", "TF_VAR_api_custom_hostname"))
    COOKIE_BASE_DOMAIN_STAGING = (Get-EnvValue -Values $envValues -Keys @("COOKIE_BASE_DOMAIN_STAGING") -Default "freedomtimes.news")
    AUTH0_ROLES_CLAIM_NAMESPACE_STAGING = (Get-EnvValue -Values $envValues -Keys @("AUTH0_ROLES_CLAIM_NAMESPACE_STAGING") -Default "https://freedomtimes.news")
    API_UPSTREAM_MODE_STAGING = (Get-EnvValue -Values $envValues -Keys @("API_UPSTREAM_MODE_STAGING") -Default "apim")

    TF_VAR_MANAGE_APEX_DNS_RECORD_PRODUCTION = (Get-EnvValue -Values $envValues -Keys @("TF_VAR_manage_apex_dns_record_production", "TF_VAR_manage_apex_dns_record") -Default "true")
    TF_VAR_APEX_DNS_RECORD_CONTENT_PRODUCTION = (Get-EnvValue -Values $envValues -Keys @("TF_VAR_apex_dns_record_content_production", "TF_VAR_apex_dns_record_content") -Default "192.0.2.1")
    TF_VAR_API_CUSTOM_HOSTNAME_PRODUCTION = (Get-EnvValue -Values $envValues -Keys @("TF_VAR_api_custom_hostname_production") -Default "api.freedomtimes.news")
    AUTH0_API_AUDIENCE_PRODUCTION = (Get-EnvValue -Values $envValues -Keys @("AUTH0_API_AUDIENCE_PRODUCTION", "AUTH0_API_AUDIENCE") -Default "https://api.freedomtimes.news")
    API_BASE_URL_PRODUCTION = (Get-EnvValue -Values $envValues -Keys @("API_BASE_URL_PRODUCTION") -Default "https://api.freedomtimes.news/editorial")
    COOKIE_BASE_DOMAIN_PRODUCTION = (Get-EnvValue -Values $envValues -Keys @("COOKIE_BASE_DOMAIN_PRODUCTION", "COOKIE_BASE_DOMAIN") -Default "freedomtimes.news")
    AUTH0_ROLES_CLAIM_NAMESPACE_PRODUCTION = (Get-EnvValue -Values $envValues -Keys @("AUTH0_ROLES_CLAIM_NAMESPACE_PRODUCTION", "AUTH0_ROLES_CLAIM_NAMESPACE") -Default "https://freedomtimes.news")
    API_UPSTREAM_MODE_PRODUCTION = (Get-EnvValue -Values $envValues -Keys @("API_UPSTREAM_MODE_PRODUCTION") -Default "apim")
}

foreach ($name in $variables.Keys) {
    Set-GhVariable -Name $name -Value ([string]$variables[$name]) -Repository $Repo -WhatIfOnly:$DryRun
}

if ($SyncCloudflareWorkerSecrets) {
    Write-Host "`nSyncing Cloudflare Worker secrets..." -ForegroundColor Cyan

    if (-not (Test-Path $stagingWranglerConfig) -or -not (Test-Path $productionWranglerConfig)) {
        Write-Warning "Wrangler config file missing, skipping Cloudflare Worker secret sync."
    }
    else {
        $auth0Domain = Get-EnvValue -Values $envValues -Keys @("TF_VAR_auth0_domain")
        $stagingClientId = Get-EnvValue -Values $envValues -Keys @("AUTH0_LOGIN_APP_CLIENT_ID_STAGING")
        $stagingClientSecret = Get-EnvValue -Values $envValues -Keys @("AUTH0_LOGIN_APP_CLIENT_SECRET_STAGING")
        $productionClientId = Get-EnvValue -Values $envValues -Keys @("AUTH0_LOGIN_APP_CLIENT_ID_PRODUCTION")
        $productionClientSecret = Get-EnvValue -Values $envValues -Keys @("AUTH0_LOGIN_APP_CLIENT_SECRET_PRODUCTION")

        Push-Location (Join-Path $repoRoot "web")
        try {
            Set-WorkerSecret -ConfigPath "wrangler.staging.jsonc" -Name "AUTH0_DOMAIN" -Value $auth0Domain -WhatIfOnly:$DryRun
            Set-WorkerSecret -ConfigPath "wrangler.staging.jsonc" -Name "AUTH0_CLIENT_ID" -Value $stagingClientId -WhatIfOnly:$DryRun
            Set-WorkerSecret -ConfigPath "wrangler.staging.jsonc" -Name "AUTH0_CLIENT_SECRET" -Value $stagingClientSecret -WhatIfOnly:$DryRun

            Set-WorkerSecret -ConfigPath "wrangler.production.jsonc" -Name "AUTH0_DOMAIN" -Value $auth0Domain -WhatIfOnly:$DryRun
            Set-WorkerSecret -ConfigPath "wrangler.production.jsonc" -Name "AUTH0_CLIENT_ID" -Value $productionClientId -WhatIfOnly:$DryRun
            Set-WorkerSecret -ConfigPath "wrangler.production.jsonc" -Name "AUTH0_CLIENT_SECRET" -Value $productionClientSecret -WhatIfOnly:$DryRun
        }
        finally {
            Pop-Location
        }
    }
}

Write-Host "`nDone." -ForegroundColor Cyan
Write-Host "GitHub secrets/vars: https://github.com/$Repo/settings/secrets/actions" -ForegroundColor Gray
