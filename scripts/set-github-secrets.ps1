<#
.SYNOPSIS
    Syncs GitHub Actions secrets/variables (and optionally Cloudflare Worker secrets)
    from layered local env files.

.DESCRIPTION
    This script is the synchronization bridge between local environment configuration and remote systems.
    
    CANONICAL SOURCE HIERARCHY:
      .env.dev (base) + .env.staging/.env.production (overlays)
        ↓ (script reads)
      GitHub secrets & variables
        ↓ (workflows read)
      Cloudflare Worker secrets (optional, via -SyncCloudflareWorkerSecrets)
    
    The workflows (terraform-staging.yml, terraform-production.yml) read from GitHub secrets
    and deploy Cloudflare Worker secrets during Terraform apply. The script ensures that
    GitHub secrets stay in sync with your local env files.

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
    [string]$BaseEnvFile = ".env.dev",
    [string]$StagingEnvFile = ".env.staging",
    [string]$ProductionEnvFile = ".env.production",
    [ValidateSet("All", "Staging", "Production")]
    [string]$Target = "All",
    [switch]$DryRun,
    [switch]$SyncCloudflareWorkerSecrets
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path $PSScriptRoot -Parent
$baseEnvPath = Join-Path $repoRoot $BaseEnvFile
$stagingEnvPath = Join-Path $repoRoot $StagingEnvFile
$productionEnvPath = Join-Path $repoRoot $ProductionEnvFile
$tfcCredsFile = Join-Path $env:APPDATA "terraform.d\credentials.tfrc.json"
$stagingWranglerConfig = Join-Path $repoRoot "web\wrangler.staging.jsonc"
$productionWranglerConfig = Join-Path $repoRoot "web\wrangler.production.jsonc"

if (-not (Test-Path $baseEnvPath)) {
    Write-Error "$BaseEnvFile not found at $baseEnvPath. Copy .env.dev.example and fill in real values."
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

function Merge-EnvValues {
    param(
        [hashtable]$Base,
        [hashtable]$Override
    )

    $merged = @{}

    if ($null -ne $Base) {
        foreach ($key in $Base.Keys) {
            $merged[$key] = $Base[$key]
        }
    }

    if ($null -ne $Override) {
        foreach ($key in $Override.Keys) {
            $merged[$key] = $Override[$key]
        }
    }

    return $merged
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
        Write-Warning "Skipping secret $Name - value is empty in the loaded env values"
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
        Write-Warning "Skipping variable $Name - value is empty in the loaded env values"
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
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to set Worker secret $Name via $ConfigPath"
    }
    Write-Host "  [ok] Worker secret $Name via $ConfigPath" -ForegroundColor Green
}

function Add-EntryIfTargetMatches {
    param(
        [System.Collections.IDictionary]$Map,
        [string]$Name,
        [string]$Value,
        [string]$EntryTarget,
        [string]$RequestedTarget
    )

    if ($RequestedTarget -eq "All" -or $RequestedTarget -eq $EntryTarget) {
        $Map[$Name] = $Value
    }
}

$baseEnvValues = Parse-EnvFile -Path $baseEnvPath
$stagingOverlayValues = if (Test-Path $stagingEnvPath) { Parse-EnvFile -Path $stagingEnvPath } else { @{} }
$productionOverlayValues = if (Test-Path $productionEnvPath) { Parse-EnvFile -Path $productionEnvPath } else { @{} }

$stagingEnvValues = Merge-EnvValues -Base $baseEnvValues -Override $stagingOverlayValues
$productionEnvValues = Merge-EnvValues -Base $baseEnvValues -Override $productionOverlayValues

Write-Host "Loaded base env: $BaseEnvFile" -ForegroundColor DarkGray
if (Test-Path $stagingEnvPath) {
    Write-Host "Loaded staging overlay: $StagingEnvFile" -ForegroundColor DarkGray
}
else {
    Write-Host "Staging overlay not found: $StagingEnvFile (using base values only)" -ForegroundColor DarkYellow
}

if (Test-Path $productionEnvPath) {
    Write-Host "Loaded production overlay: $ProductionEnvFile" -ForegroundColor DarkGray
}
else {
    Write-Host "Production overlay not found: $ProductionEnvFile (using base values only)" -ForegroundColor DarkYellow
}

Write-Host "`nSyncing GitHub Actions secrets..." -ForegroundColor Cyan
$secrets = [ordered]@{
    ARM_CLIENT_ID = (Get-EnvValue -Values $baseEnvValues -Keys @("ARM_CLIENT_ID"))
    ARM_CLIENT_SECRET = (Get-EnvValue -Values $baseEnvValues -Keys @("ARM_CLIENT_SECRET"))
    ARM_SUBSCRIPTION_ID = (Get-EnvValue -Values $baseEnvValues -Keys @("ARM_SUBSCRIPTION_ID"))
    ARM_TENANT_ID = (Get-EnvValue -Values $baseEnvValues -Keys @("ARM_TENANT_ID"))
    TF_VAR_CLOUDFLARE_API_TOKEN = (Get-EnvValue -Values $baseEnvValues -Keys @("TF_VAR_cloudflare_api_token"))
    TF_VAR_CLOUDFLARE_ACCOUNT_ID = (Get-EnvValue -Values $baseEnvValues -Keys @("TF_VAR_cloudflare_account_id"))
    TF_VAR_CLOUDFLARE_ZONE_ID = (Get-EnvValue -Values $baseEnvValues -Keys @("TF_VAR_cloudflare_zone_id"))
    TF_VAR_AUTH0_DOMAIN = (Get-EnvValue -Values $baseEnvValues -Keys @("TF_VAR_auth0_domain"))
    TF_VAR_AUTH0_MANAGEMENT_CLIENT_ID = (Get-EnvValue -Values $baseEnvValues -Keys @("TF_VAR_auth0_management_client_id", "TF_VAR_auth0_client_id"))
    TF_VAR_AUTH0_MANAGEMENT_CLIENT_SECRET = (Get-EnvValue -Values $baseEnvValues -Keys @("TF_VAR_auth0_management_client_secret", "TF_VAR_auth0_client_secret"))
    # Backward compatibility for older workflows still referencing deprecated secret names.
    TF_VAR_AUTH0_CLIENT_ID = (Get-EnvValue -Values $baseEnvValues -Keys @("TF_VAR_auth0_management_client_id", "TF_VAR_auth0_client_id"))
    TF_VAR_AUTH0_CLIENT_SECRET = (Get-EnvValue -Values $baseEnvValues -Keys @("TF_VAR_auth0_management_client_secret", "TF_VAR_auth0_client_secret"))
}

Add-EntryIfTargetMatches -Map $secrets -Name "AUTH0_LOGIN_APP_CLIENT_ID_STAGING" -Value (Get-EnvValue -Values $stagingEnvValues -Keys @("AUTH0_LOGIN_APP_CLIENT_ID", "AUTH0_LOGIN_APP_CLIENT_ID_STAGING")) -EntryTarget "Staging" -RequestedTarget $Target
Add-EntryIfTargetMatches -Map $secrets -Name "AUTH0_LOGIN_APP_CLIENT_SECRET_STAGING" -Value (Get-EnvValue -Values $stagingEnvValues -Keys @("AUTH0_LOGIN_APP_CLIENT_SECRET", "AUTH0_LOGIN_APP_CLIENT_SECRET_STAGING")) -EntryTarget "Staging" -RequestedTarget $Target
Add-EntryIfTargetMatches -Map $secrets -Name "TF_VAR_API_CUSTOM_HOSTNAME_CERTIFICATE_BASE64_STAGING" -Value (Get-EnvValue -Values $stagingEnvValues -Keys @("TF_VAR_api_custom_hostname_certificate_base64", "TF_VAR_api_custom_hostname_certificate_base64_staging")) -EntryTarget "Staging" -RequestedTarget $Target
Add-EntryIfTargetMatches -Map $secrets -Name "TF_VAR_API_CUSTOM_HOSTNAME_CERTIFICATE_PASSWORD_STAGING" -Value (Get-EnvValue -Values $stagingEnvValues -Keys @("TF_VAR_api_custom_hostname_certificate_password", "TF_VAR_api_custom_hostname_certificate_password_staging")) -EntryTarget "Staging" -RequestedTarget $Target
Add-EntryIfTargetMatches -Map $secrets -Name "AUTH0_LOGIN_APP_CLIENT_ID_PRODUCTION" -Value (Get-EnvValue -Values $productionEnvValues -Keys @("AUTH0_LOGIN_APP_CLIENT_ID", "AUTH0_LOGIN_APP_CLIENT_ID_PRODUCTION")) -EntryTarget "Production" -RequestedTarget $Target
Add-EntryIfTargetMatches -Map $secrets -Name "AUTH0_LOGIN_APP_CLIENT_SECRET_PRODUCTION" -Value (Get-EnvValue -Values $productionEnvValues -Keys @("AUTH0_LOGIN_APP_CLIENT_SECRET", "AUTH0_LOGIN_APP_CLIENT_SECRET_PRODUCTION")) -EntryTarget "Production" -RequestedTarget $Target
Add-EntryIfTargetMatches -Map $secrets -Name "TF_VAR_API_CUSTOM_HOSTNAME_CERTIFICATE_BASE64_PRODUCTION" -Value (Get-EnvValue -Values $productionEnvValues -Keys @("TF_VAR_api_custom_hostname_certificate_base64", "TF_VAR_api_custom_hostname_certificate_base64_production")) -EntryTarget "Production" -RequestedTarget $Target
Add-EntryIfTargetMatches -Map $secrets -Name "TF_VAR_API_CUSTOM_HOSTNAME_CERTIFICATE_PASSWORD_PRODUCTION" -Value (Get-EnvValue -Values $productionEnvValues -Keys @("TF_VAR_api_custom_hostname_certificate_password", "TF_VAR_api_custom_hostname_certificate_password_production")) -EntryTarget "Production" -RequestedTarget $Target

foreach ($name in $secrets.Keys) {
    Set-GhSecret -Name $name -Value ([string]$secrets[$name]) -Repository $Repo -WhatIfOnly:$DryRun
}

$tfcToken = Get-TfcTokenFromCredentials -FilePath $tfcCredsFile
if ([string]::IsNullOrWhiteSpace($tfcToken)) {
    Write-Warning "Terraform Cloud token not found in $tfcCredsFile. Skipping TF_TOKEN_APP_TERRAFORM_IO."
}
else {
    Set-GhSecret -Name "TF_TOKEN_APP_TERRAFORM_IO" -Value $tfcToken -Repository $Repo -WhatIfOnly:$DryRun
}

Write-Host "`nSyncing GitHub Actions variables..." -ForegroundColor Cyan
$variables = [ordered]@{
    TFC_ORGANIZATION = "freedomtimes"
    TFC_WORKSPACE_PRODUCTION = "freedomtimes-production"

    TF_VAR_AZURE_LOCATION = (Get-EnvValue -Values $baseEnvValues -Keys @("TF_VAR_azure_location"))
    TF_VAR_ROUTE_PATTERN = (Get-EnvValue -Values $baseEnvValues -Keys @("TF_VAR_route_pattern"))
    TF_VAR_WORKER_NAME = (Get-EnvValue -Values $baseEnvValues -Keys @("TF_VAR_worker_name"))
    TF_VAR_HOLDING_TITLE = (Get-EnvValue -Values $baseEnvValues -Keys @("TF_VAR_holding_title"))
    TF_VAR_HOLDING_HEADING = (Get-EnvValue -Values $baseEnvValues -Keys @("TF_VAR_holding_heading"))
    TF_VAR_HOLDING_MESSAGE = (Get-EnvValue -Values $baseEnvValues -Keys @("TF_VAR_holding_message"))
    TF_VAR_CONTACT_EMAIL = (Get-EnvValue -Values $baseEnvValues -Keys @("TF_VAR_contact_email"))
}

Add-EntryIfTargetMatches -Map $variables -Name "TF_VAR_AZURE_LOCATION_STAGING" -Value (Get-EnvValue -Values $stagingEnvValues -Keys @("TF_VAR_azure_location") -Default (Get-EnvValue -Values $baseEnvValues -Keys @("TF_VAR_azure_location"))) -EntryTarget "Staging" -RequestedTarget $Target
Add-EntryIfTargetMatches -Map $variables -Name "TF_VAR_ROUTE_PATTERN_STAGING" -Value (Get-EnvValue -Values $stagingEnvValues -Keys @("TF_VAR_route_pattern")) -EntryTarget "Staging" -RequestedTarget $Target
Add-EntryIfTargetMatches -Map $variables -Name "TF_VAR_WORKER_NAME_STAGING" -Value (Get-EnvValue -Values $stagingEnvValues -Keys @("TF_VAR_worker_name") -Default "freedomtimes-holding-staging") -EntryTarget "Staging" -RequestedTarget $Target
Add-EntryIfTargetMatches -Map $variables -Name "TF_VAR_MANAGE_APEX_DNS_RECORD_STAGING" -Value (Get-EnvValue -Values $stagingEnvValues -Keys @("TF_VAR_manage_apex_dns_record") -Default "false") -EntryTarget "Staging" -RequestedTarget $Target
Add-EntryIfTargetMatches -Map $variables -Name "TF_VAR_APEX_DNS_RECORD_CONTENT_STAGING" -Value (Get-EnvValue -Values $stagingEnvValues -Keys @("TF_VAR_apex_dns_record_content") -Default "192.0.2.1") -EntryTarget "Staging" -RequestedTarget $Target
Add-EntryIfTargetMatches -Map $variables -Name "TF_VAR_API_CUSTOM_HOSTNAME_STAGING" -Value (Get-EnvValue -Values $stagingEnvValues -Keys @("TF_VAR_api_custom_hostname")) -EntryTarget "Staging" -RequestedTarget $Target
Add-EntryIfTargetMatches -Map $variables -Name "COOKIE_BASE_DOMAIN_STAGING" -Value (Get-EnvValue -Values $stagingEnvValues -Keys @("COOKIE_BASE_DOMAIN")) -EntryTarget "Staging" -RequestedTarget $Target
Add-EntryIfTargetMatches -Map $variables -Name "AUTH0_ROLES_CLAIM_NAMESPACE_STAGING" -Value (Get-EnvValue -Values $stagingEnvValues -Keys @("AUTH0_ROLES_CLAIM_NAMESPACE")) -EntryTarget "Staging" -RequestedTarget $Target
Add-EntryIfTargetMatches -Map $variables -Name "API_UPSTREAM_MODE_STAGING" -Value (Get-EnvValue -Values $stagingEnvValues -Keys @("API_UPSTREAM_MODE") -Default "apim") -EntryTarget "Staging" -RequestedTarget $Target
Add-EntryIfTargetMatches -Map $variables -Name "TF_VAR_MANAGE_APEX_DNS_RECORD_PRODUCTION" -Value (Get-EnvValue -Values $productionEnvValues -Keys @("TF_VAR_manage_apex_dns_record") -Default "true") -EntryTarget "Production" -RequestedTarget $Target
Add-EntryIfTargetMatches -Map $variables -Name "TF_VAR_APEX_DNS_RECORD_CONTENT_PRODUCTION" -Value (Get-EnvValue -Values $productionEnvValues -Keys @("TF_VAR_apex_dns_record_content") -Default "192.0.2.1") -EntryTarget "Production" -RequestedTarget $Target
Add-EntryIfTargetMatches -Map $variables -Name "TF_VAR_API_CUSTOM_HOSTNAME_PRODUCTION" -Value (Get-EnvValue -Values $productionEnvValues -Keys @("TF_VAR_api_custom_hostname")) -EntryTarget "Production" -RequestedTarget $Target
Add-EntryIfTargetMatches -Map $variables -Name "AUTH0_API_AUDIENCE_PRODUCTION" -Value (Get-EnvValue -Values $productionEnvValues -Keys @("AUTH0_API_AUDIENCE")) -EntryTarget "Production" -RequestedTarget $Target
Add-EntryIfTargetMatches -Map $variables -Name "API_BASE_URL_PRODUCTION" -Value (Get-EnvValue -Values $productionEnvValues -Keys @("API_BASE_URL")) -EntryTarget "Production" -RequestedTarget $Target
Add-EntryIfTargetMatches -Map $variables -Name "COOKIE_BASE_DOMAIN_PRODUCTION" -Value (Get-EnvValue -Values $productionEnvValues -Keys @("COOKIE_BASE_DOMAIN")) -EntryTarget "Production" -RequestedTarget $Target
Add-EntryIfTargetMatches -Map $variables -Name "AUTH0_ROLES_CLAIM_NAMESPACE_PRODUCTION" -Value (Get-EnvValue -Values $productionEnvValues -Keys @("AUTH0_ROLES_CLAIM_NAMESPACE")) -EntryTarget "Production" -RequestedTarget $Target
Add-EntryIfTargetMatches -Map $variables -Name "API_UPSTREAM_MODE_PRODUCTION" -Value (Get-EnvValue -Values $productionEnvValues -Keys @("API_UPSTREAM_MODE") -Default "apim") -EntryTarget "Production" -RequestedTarget $Target

foreach ($name in $variables.Keys) {
    Set-GhVariable -Name $name -Value ([string]$variables[$name]) -Repository $Repo -WhatIfOnly:$DryRun
}

if ($SyncCloudflareWorkerSecrets) {
    Write-Host "`nSyncing Cloudflare Worker secrets..." -ForegroundColor Cyan
    Write-Host "Reading credentials from local env: .env.staging + .env.production" -ForegroundColor Gray
    Write-Host "These are synced to Cloudflare directly by the script, independent of GitHub." -ForegroundColor Gray
    Write-Host "For CI/CD automation: the workflows read GitHub secrets and sync to Cloudflare during Terraform apply." -ForegroundColor Gray


    if (-not (Test-Path $stagingWranglerConfig) -or -not (Test-Path $productionWranglerConfig)) {
        Write-Warning "Wrangler config file missing, skipping Cloudflare Worker secret sync."
    }
    else {
        $stagingAuth0Domain = Get-EnvValue -Values $stagingEnvValues -Keys @("AUTH0_DOMAIN", "TF_VAR_auth0_domain")
        $stagingClientId = Get-EnvValue -Values $stagingEnvValues -Keys @("AUTH0_CLIENT_ID", "AUTH0_LOGIN_APP_CLIENT_ID", "AUTH0_LOGIN_APP_CLIENT_ID_STAGING")
        $stagingClientSecret = Get-EnvValue -Values $stagingEnvValues -Keys @("AUTH0_CLIENT_SECRET", "AUTH0_LOGIN_APP_CLIENT_SECRET", "AUTH0_LOGIN_APP_CLIENT_SECRET_STAGING")
        $productionAuth0Domain = Get-EnvValue -Values $productionEnvValues -Keys @("AUTH0_DOMAIN", "TF_VAR_auth0_domain")
        $productionClientId = Get-EnvValue -Values $productionEnvValues -Keys @("AUTH0_CLIENT_ID", "AUTH0_LOGIN_APP_CLIENT_ID", "AUTH0_LOGIN_APP_CLIENT_ID_PRODUCTION")
        $productionClientSecret = Get-EnvValue -Values $productionEnvValues -Keys @("AUTH0_CLIENT_SECRET", "AUTH0_LOGIN_APP_CLIENT_SECRET", "AUTH0_LOGIN_APP_CLIENT_SECRET_PRODUCTION")

        Push-Location (Join-Path $repoRoot "web")
        try {
            if ($Target -eq "All" -or $Target -eq "Staging") {
                Set-WorkerSecret -ConfigPath "wrangler.staging.jsonc" -Name "AUTH0_DOMAIN" -Value $stagingAuth0Domain -WhatIfOnly:$DryRun
                Set-WorkerSecret -ConfigPath "wrangler.staging.jsonc" -Name "AUTH0_CLIENT_ID" -Value $stagingClientId -WhatIfOnly:$DryRun
                Set-WorkerSecret -ConfigPath "wrangler.staging.jsonc" -Name "AUTH0_CLIENT_SECRET" -Value $stagingClientSecret -WhatIfOnly:$DryRun
            }

            if ($Target -eq "All" -or $Target -eq "Production") {
                Set-WorkerSecret -ConfigPath "wrangler.production.jsonc" -Name "AUTH0_DOMAIN" -Value $productionAuth0Domain -WhatIfOnly:$DryRun
                Set-WorkerSecret -ConfigPath "wrangler.production.jsonc" -Name "AUTH0_CLIENT_ID" -Value $productionClientId -WhatIfOnly:$DryRun
                Set-WorkerSecret -ConfigPath "wrangler.production.jsonc" -Name "AUTH0_CLIENT_SECRET" -Value $productionClientSecret -WhatIfOnly:$DryRun
            }
        }
        finally {
            Pop-Location
        }
    }
}

Write-Host "`nDone." -ForegroundColor Cyan
Write-Host "GitHub secrets/vars: https://github.com/$Repo/settings/secrets/actions" -ForegroundColor Gray
