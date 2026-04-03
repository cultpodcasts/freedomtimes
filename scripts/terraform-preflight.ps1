[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("staging", "production")]
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
$overlayFile = if ($Environment -eq "staging") { $StagingEnvFile } else { $ProductionEnvFile }
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
    $overlayValues = Parse-EnvFile -Path $overlayEnvPath
    $merged = Merge-Hashtable -Base $baseValues -Overlay $overlayValues
    Set-ProcessEnvFromHashtable -Values $merged

    Write-Host "Loaded env values from $BaseEnvFile + $overlayFile" -ForegroundColor DarkGray
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
    "ARM_CLIENT_ID",
    "ARM_CLIENT_SECRET",
    "ARM_SUBSCRIPTION_ID",
    "ARM_TENANT_ID",
    "TF_VAR_cloudflare_api_token",
    "TF_VAR_cloudflare_account_id",
    "TF_VAR_cloudflare_zone_id",
    "TF_VAR_auth0_domain",
    "TF_VAR_auth0_management_client_id",
    "TF_VAR_auth0_management_client_secret",
    "TF_VAR_route_pattern"
)

$requiredByEnvironment = @{
    staging = @()
    production = @()
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
