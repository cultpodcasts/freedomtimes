[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("staging", "production", "auth0-shared")]
    [string]$Environment,
    [string]$BaseEnvFile = ".env.dev",
    [switch]$LoadEnvFiles,
    [switch]$SkipTursoPreflight
)

. "$PSScriptRoot/terraform-turso-env.ps1"

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path $PSScriptRoot -Parent
$baseEnvPath = Join-Path $repoRoot $BaseEnvFile

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

    $values = Parse-EnvFile -Path $baseEnvPath
    Set-ProcessEnvFromHashtable -Values $values

    Write-Host "Loaded env values from $BaseEnvFile" -ForegroundColor DarkGray
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
        "TF_VAR_turso_organization"            = "TF_VAR_TURSO_ORGANIZATION"
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
            "TF_VAR_api_custom_hostname_certificate_base64"   = "TF_VAR_API_CUSTOM_HOSTNAME_CERTIFICATE_BASE64$suffix"
            "TF_VAR_api_custom_hostname_certificate_password" = "TF_VAR_API_CUSTOM_HOSTNAME_CERTIFICATE_PASSWORD$suffix"
            "TF_VAR_turso_database_name"                      = "TF_VAR_TURSO_DATABASE_NAME$suffix"
            "TF_VAR_turso_database_group"                     = "TF_VAR_TURSO_DATABASE_GROUP$suffix"
            "TF_VAR_turso_database_token_expiration"          = "TF_VAR_TURSO_DATABASE_TOKEN_EXPIRATION$suffix"
            "TF_VAR_turso_database_size_limit"                = "TF_VAR_TURSO_DATABASE_SIZE_LIMIT$suffix"
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

    Set-TursoPlatformApiTokenForEnvironment -Environment $Environment
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
    "TF_VAR_auth0_domain",
    "TF_VAR_auth0_management_client_id",
    "TF_VAR_auth0_management_client_secret"
)

$requiredCommon = @("TF_TOKEN_app_terraform_io") + $requiredCommon

$requiredByEnvironment = @{
    staging = @(
    "TF_VAR_cloudflare_api_token",
    "TF_VAR_cloudflare_account_id",
    "TF_VAR_cloudflare_zone_id",
    "TF_VAR_route_pattern",
    "TF_VAR_auth0_api_identifier"
    )
    production = @(
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

if ($Environment -eq "staging" -or $Environment -eq "production") {
    if (-not $SkipTursoPreflight) {
        $tursoApiToken = [System.Environment]::GetEnvironmentVariable("TF_VAR_turso_api_token", "Process")
        if ([string]::IsNullOrWhiteSpace([string]$tursoApiToken)) {
            $hint = if ($Environment -eq "staging") {
                "set TURSO_TOKEN_STAGING (preferred), TURSO_PLATFORM_API_TOKEN, or TF_VAR_turso_api_token"
            }
            else {
                "set TURSO_PLATFORM_API_TOKEN or TF_VAR_turso_api_token (TURSO_TOKEN only when it is a Platform API token, not TURSO_AUTH_TOKEN / libsql JWT)"
            }
            Write-Error ("Missing Turso Platform API token for {0}: {1}. Turso dashboard -> Settings -> API tokens." -f $Environment, $hint)
            exit 1
        }

        if (-not (Test-TursoPlatformApiToken $tursoApiToken)) {
            $shapeHint = if (Test-LooksLikeTursoDatabaseJwt $tursoApiToken) {
                " The value looks like a libsql database JWT and failed the Turso Platform API probe."
            }
            else {
                ""
            }
            Write-Error ("TF_VAR_turso_api_token for {0} is not a valid Turso Platform API token.{1} Turso dashboard -> Settings -> API tokens." -f $Environment, $shapeHint)
            exit 1
        }

        $tursoOrganization = [System.Environment]::GetEnvironmentVariable("TF_VAR_turso_organization", "Process")
        if ([string]::IsNullOrWhiteSpace([string]$tursoOrganization)) {
            Write-Error ("Missing Turso organization for {0}: provide TF_VAR_TURSO_ORGANIZATION." -f $Environment)
            exit 1
        }
    }
    else {
        Write-Warning "Skipping Turso Platform API token preflight check (-SkipTursoPreflight)."
    }
}

Write-Host ("Terraform preflight passed for {0}. Checked {1} required variables." -f $Environment, $required.Count) -ForegroundColor Green
