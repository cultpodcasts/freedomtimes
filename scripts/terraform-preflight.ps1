[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("staging", "production", "auth0-shared")]
    [string]$Environment,
    [string]$BaseEnvFile = ".env.dev",
    [string]$StagingEnvFile = ".env.staging",
    [string]$ProductionEnvFile = ".env.production",
    [switch]$LoadEnvFiles
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path $PSScriptRoot -Parent
$baseEnvPath = Join-Path $repoRoot $BaseEnvFile
$overlayFile = if ($Environment -eq "staging") {
    $StagingEnvFile
}
elseif ($Environment -eq "production") {
    $ProductionEnvFile
}
else {
    $null
}
$overlayEnvPath = Join-Path $repoRoot $overlayFile

function Parse-EnvFile {
    param([string]$Path)

    $values = @{}
    if (-not (Test-Path $Path)) {
        return $values
    }

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

function Merge-Hashtable {
    param(
        [hashtable]$Base,
        [hashtable]$Overlay
    )

    $merged = @{}
    foreach ($key in $Base.Keys) {
        $merged[$key] = $Base[$key]
    }
    foreach ($key in $Overlay.Keys) {
        $merged[$key] = $Overlay[$key]
    }

    return $merged
}

function Set-ProcessEnvFromHashtable {
    param([hashtable]$Values)

    foreach ($key in $Values.Keys) {
        [System.Environment]::SetEnvironmentVariable($key, [string]$Values[$key], "Process")
    }
}

function Get-TfcTokenFromCredentials {
    $tfcCredsFile = Join-Path $env:APPDATA "terraform.d\credentials.tfrc.json"
    if (-not (Test-Path $tfcCredsFile)) {
        return ""
    }

    try {
        $json = Get-Content $tfcCredsFile -Raw | ConvertFrom-Json
        return [string]$json.credentials."app.terraform.io".token
    }
    catch {
        return ""
    }
}

if ($LoadEnvFiles) {
    if (-not (Test-Path $baseEnvPath)) {
        throw "Base env file not found: $baseEnvPath"
    }

    $baseValues = Parse-EnvFile -Path $baseEnvPath
    $overlayValues = if ($overlayFile) { Parse-EnvFile -Path $overlayEnvPath } else { @{} }
    $merged = Merge-Hashtable -Base $baseValues -Overlay $overlayValues
    Set-ProcessEnvFromHashtable -Values $merged

    Write-Host "Loaded env values from $BaseEnvFile + $overlayFile" -ForegroundColor DarkGray
}

# Normalize shared vars from canonical uppercase names in .env.dev to the
# lowercase TF_VAR names used by root module variables.
if ($LoadEnvFiles) {
    $sharedAliases = [ordered]@{
        "TF_VAR_cloudflare_api_token"          = "TF_VAR_CLOUDFLARE_API_TOKEN"
        "TF_VAR_cloudflare_account_id"         = "TF_VAR_CLOUDFLARE_ACCOUNT_ID"
        "TF_VAR_cloudflare_zone_id"            = "TF_VAR_CLOUDFLARE_ZONE_ID"
        "TF_VAR_auth0_domain"                  = "TF_VAR_AUTH0_DOMAIN"
        "TF_VAR_auth0_management_client_id"    = "TF_VAR_AUTH0_MANAGEMENT_CLIENT_ID"
        "TF_VAR_auth0_management_client_secret" = "TF_VAR_AUTH0_MANAGEMENT_CLIENT_SECRET"
        "TF_VAR_azure_location"                = "TF_VAR_AZURE_LOCATION"
    }
    foreach ($targetKey in $sharedAliases.Keys) {
        $sourceKey = $sharedAliases[$targetKey]
        $sourceValue = [System.Environment]::GetEnvironmentVariable($sourceKey, "Process")
        if (-not [string]::IsNullOrWhiteSpace($sourceValue)) {
            [System.Environment]::SetEnvironmentVariable($targetKey, $sourceValue, "Process")
        }
    }
}

# Remap environment-specific vars from suffixed keys in .env.dev to the
# unsuffixed names Terraform expects.  GitHub Actions workflows do this
# remapping in their env: block; this block handles it for local runs.
if ($LoadEnvFiles) {
    $suffix = if ($Environment -eq "staging") { "_STAGING" } else { "_PRODUCTION" }
    if ($Environment -eq "staging" -or $Environment -eq "production") {
        $envSpecificKeys = [ordered]@{
            "TF_VAR_route_pattern"                            = "TF_VAR_ROUTE_PATTERN$suffix"
            "TF_VAR_worker_name"                              = "TF_VAR_WORKER_NAME$suffix"
            "TF_VAR_manage_apex_dns_record"                   = "TF_VAR_MANAGE_APEX_DNS_RECORD$suffix"
            "TF_VAR_apex_dns_record_content"                  = "TF_VAR_APEX_DNS_RECORD_CONTENT$suffix"
            "TF_VAR_api_custom_hostname"                      = "TF_VAR_API_CUSTOM_HOSTNAME$suffix"
            "TF_VAR_workspace_url"                            = "TF_VAR_WORKSPACE_URL$suffix"
            "TF_VAR_api_management_allowed_origins"           = "TF_VAR_API_MANAGEMENT_ALLOWED_ORIGINS$suffix"
            "TF_VAR_api_custom_hostname_certificate_base64"   = "TF_VAR_API_CUSTOM_HOSTNAME_CERTIFICATE_BASE64$suffix"
            "TF_VAR_api_custom_hostname_certificate_password" = "TF_VAR_API_CUSTOM_HOSTNAME_CERTIFICATE_PASSWORD$suffix"
        }
        foreach ($tfVar in $envSpecificKeys.Keys) {
            $sourceKey = $envSpecificKeys[$tfVar]
            $sourceValue = [System.Environment]::GetEnvironmentVariable($sourceKey, "Process")
            if (-not [string]::IsNullOrWhiteSpace($sourceValue)) {
                [System.Environment]::SetEnvironmentVariable($tfVar, $sourceValue, "Process")
            }
        }

        if ($Environment -eq "staging") {
            $audience = [System.Environment]::GetEnvironmentVariable("AUTH0_API_AUDIENCE_STAGING", "Process")
        }
        else {
            $audience = [System.Environment]::GetEnvironmentVariable("AUTH0_API_AUDIENCE_PRODUCTION", "Process")
            if ([string]::IsNullOrWhiteSpace($audience)) {
                $audience = [System.Environment]::GetEnvironmentVariable("AUTH0_API_AUDIENCE", "Process")
            }
        }
        if (-not [string]::IsNullOrWhiteSpace($audience)) {
            [System.Environment]::SetEnvironmentVariable("TF_VAR_auth0_api_identifier", $audience, "Process")
        }
    }

    if ($Environment -eq "auth0-shared") {
        $audience = [System.Environment]::GetEnvironmentVariable("AUTH0_API_AUDIENCE", "Process")
        if (-not [string]::IsNullOrWhiteSpace($audience)) {
            [System.Environment]::SetEnvironmentVariable("TF_VAR_auth0_api_identifier", $audience, "Process")
        }

        $rolesClaim = [System.Environment]::GetEnvironmentVariable("AUTH0_ROLES_CLAIM_NAMESPACE", "Process")
        if (-not [string]::IsNullOrWhiteSpace($rolesClaim)) {
            [System.Environment]::SetEnvironmentVariable("TF_VAR_editorial_roles_claim", $rolesClaim, "Process")
        }

        $workspaceUrl = [System.Environment]::GetEnvironmentVariable("TF_VAR_WORKSPACE_URL_PRODUCTION", "Process")
        if (-not [string]::IsNullOrWhiteSpace($workspaceUrl)) {
            [System.Environment]::SetEnvironmentVariable("TF_VAR_workspace_url", $workspaceUrl, "Process")
        }
    }

    Write-Host "Remapped env-specific vars for $Environment." -ForegroundColor DarkGray
}

# Normalize legacy Auth0 env var names for compatibility.
if (-not $env:TF_VAR_auth0_management_client_id -and $env:TF_VAR_auth0_client_id) {
    $env:TF_VAR_auth0_management_client_id = $env:TF_VAR_auth0_client_id
}
if (-not $env:TF_VAR_auth0_management_client_secret -and $env:TF_VAR_auth0_client_secret) {
    $env:TF_VAR_auth0_management_client_secret = $env:TF_VAR_auth0_client_secret
}

# Auto-load TFC token from local credentials file when not already present.
if (-not $env:TF_TOKEN_app_terraform_io) {
    $token = Get-TfcTokenFromCredentials
    if (-not [string]::IsNullOrWhiteSpace($token)) {
        $env:TF_TOKEN_app_terraform_io = $token
    }
}

$requiredCommon = @(
    "TF_TOKEN_app_terraform_io",
    "TF_VAR_auth0_domain",
    "TF_VAR_auth0_management_client_id",
    "TF_VAR_auth0_management_client_secret"
)

$requiredByEnvironment = @{
    staging = @(
    "ARM_CLIENT_ID",
    "ARM_CLIENT_SECRET",
    "ARM_SUBSCRIPTION_ID",
    "ARM_TENANT_ID",
    "TF_VAR_cloudflare_api_token",
    "TF_VAR_cloudflare_account_id",
    "TF_VAR_cloudflare_zone_id",
    "TF_VAR_route_pattern",
    "TF_VAR_auth0_api_identifier"
    )
    production = @(
        "ARM_CLIENT_ID",
        "ARM_CLIENT_SECRET",
        "ARM_SUBSCRIPTION_ID",
        "ARM_TENANT_ID",
        "TF_VAR_cloudflare_api_token",
        "TF_VAR_cloudflare_account_id",
        "TF_VAR_cloudflare_zone_id",
        "TF_VAR_route_pattern",
        "TF_VAR_auth0_api_identifier"
    )
    "auth0-shared" = @(
        "TF_VAR_auth0_api_identifier",
        "TF_VAR_editorial_roles_claim",
        "TF_VAR_workspace_url"
    )
}

$required = @($requiredCommon + $requiredByEnvironment[$Environment])
$missing = New-Object System.Collections.Generic.List[string]

foreach ($name in $required) {
    $value = [System.Environment]::GetEnvironmentVariable($name, "Process")
    if ([string]::IsNullOrWhiteSpace([string]$value)) {
        [void]$missing.Add($name)
    }
}

if ($missing.Count -gt 0) {
    Write-Error ("Missing required environment variables for {0}: {1}" -f $Environment, ($missing -join ", "))
    exit 1
}

Write-Host ("Terraform preflight passed for {0}. Checked {1} required variables." -f $Environment, $required.Count) -ForegroundColor Green
