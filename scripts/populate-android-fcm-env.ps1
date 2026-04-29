[CmdletBinding()]
param(
    [ValidateSet("Staging", "Production")]
    [string]$Target = "Staging",
    [string]$EnvPath,
    [string]$ProjectId,
    [string]$ServiceAccountEmail,
    [string]$JsonKeyPath,
    [switch]$KeepGeneratedKeyFile
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path $PSScriptRoot -Parent
if ([string]::IsNullOrWhiteSpace($EnvPath)) {
    $EnvPath = Join-Path $repoRoot ".env.dev"
}

function Write-Step {
    param([string]$Message)

    $timestamp = Get-Date -Format "yyyy-MM-ddTHH:mm:ssK"
    Write-Host "[$timestamp] $Message" -ForegroundColor Cyan
}

function Assert-CommandAvailable {
    param([string]$Name)

    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Required command '$Name' was not found in PATH."
    }
}

function Get-ResolvedProjectId {
    param([string]$RequestedProjectId)

    if (-not [string]::IsNullOrWhiteSpace($RequestedProjectId)) {
        return $RequestedProjectId.Trim()
    }

    $value = (& gcloud config get-value project 2>$null)
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to determine the active gcloud project. Pass -ProjectId explicitly."
    }

    $resolved = [string]::Join("`n", @($value)).Trim()
    if ([string]::IsNullOrWhiteSpace($resolved) -or $resolved -eq "(unset)") {
        throw "No active gcloud project is configured. Run 'gcloud config set project <id>' or pass -ProjectId explicitly."
    }

    return $resolved
}

function New-TemporaryJsonPath {
    $path = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "freedomtimes-fcm-" + [System.Guid]::NewGuid().ToString("N") + ".json")
    return $path
}

function Get-KeyMaterial {
    param(
        [string]$RequestedJsonKeyPath,
        [string]$RequestedServiceAccountEmail,
        [string]$ResolvedProjectId
    )

    if (-not [string]::IsNullOrWhiteSpace($RequestedJsonKeyPath)) {
        if (-not (Test-Path $RequestedJsonKeyPath)) {
            throw "JSON key file not found: $RequestedJsonKeyPath"
        }

        return [pscustomobject]@{
            Path = (Resolve-Path $RequestedJsonKeyPath).Path
            Generated = $false
        }
    }

    if ([string]::IsNullOrWhiteSpace($RequestedServiceAccountEmail)) {
        throw "Provide either -JsonKeyPath or -ServiceAccountEmail."
    }

    Assert-CommandAvailable -Name "gcloud"
    $tempPath = New-TemporaryJsonPath
    Write-Step "Generating a temporary service-account key via gcloud"
    & gcloud iam service-accounts keys create $tempPath --iam-account=$RequestedServiceAccountEmail --project=$ResolvedProjectId | Out-Null
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $tempPath)) {
        throw "gcloud failed to create a service-account key for $RequestedServiceAccountEmail."
    }

    return [pscustomobject]@{
        Path = $tempPath
        Generated = $true
    }
}

function Convert-ToEscapedPrivateKey {
    param([string]$PrivateKey)

    return ($PrivateKey -replace "`r`n", "`n" -replace "`r", "`n" -replace "`n", "\n").Trim()
}

function Set-OrAppendEnvValue {
    param(
        [string]$Content,
        [string]$Key,
        [string]$Value
    )

    $pattern = '(?m)^' + [regex]::Escape($Key) + '=.*$'
    $replacement = "$Key=$Value"
    if ([regex]::IsMatch($Content, $pattern)) {
        return [regex]::Replace($Content, $pattern, $replacement)
    }

    if ($Content.Length -gt 0 -and -not $Content.EndsWith("`r`n") -and -not $Content.EndsWith("`n")) {
        $Content += "`r`n"
    }

    return $Content + $replacement + "`r`n"
}

$resolvedProjectId = Get-ResolvedProjectId -RequestedProjectId $ProjectId
$prefix = if ($Target -eq "Production") { "PUSH_PRODUCTION_ANDROID_FCM" } else { "PUSH_STAGING_ANDROID_FCM" }
$keyMaterial = $null

try {
    $keyMaterial = Get-KeyMaterial -RequestedJsonKeyPath $JsonKeyPath -RequestedServiceAccountEmail $ServiceAccountEmail -ResolvedProjectId $resolvedProjectId
    $credentials = Get-Content $keyMaterial.Path -Raw | ConvertFrom-Json

    if ([string]::IsNullOrWhiteSpace($credentials.project_id)) {
        throw "The service-account JSON is missing project_id."
    }
    if ([string]::IsNullOrWhiteSpace($credentials.client_email)) {
        throw "The service-account JSON is missing client_email."
    }
    if ([string]::IsNullOrWhiteSpace($credentials.private_key)) {
        throw "The service-account JSON is missing private_key."
    }
    if ($credentials.project_id.Trim() -ne $resolvedProjectId) {
        throw "The service-account JSON project_id '$($credentials.project_id)' does not match the requested project '$resolvedProjectId'."
    }

    if (-not (Test-Path $EnvPath)) {
        throw "Env file not found: $EnvPath"
    }

    Write-Step "Updating Android FCM env values in $EnvPath"
    $content = Get-Content $EnvPath -Raw
    $content = Set-OrAppendEnvValue -Content $content -Key "${prefix}_PROJECT_ID" -Value $credentials.project_id.Trim()
    $content = Set-OrAppendEnvValue -Content $content -Key "${prefix}_CLIENT_EMAIL" -Value $credentials.client_email.Trim()
    $content = Set-OrAppendEnvValue -Content $content -Key "${prefix}_PRIVATE_KEY" -Value (Convert-ToEscapedPrivateKey -PrivateKey $credentials.private_key)
    Set-Content -Path $EnvPath -Value $content -NoNewline

    Write-Step "Updated ${prefix}_PROJECT_ID, ${prefix}_CLIENT_EMAIL, and ${prefix}_PRIVATE_KEY"
    Write-Host "Next step: run .\scripts\set-github-secrets.ps1 -Target $Target -SyncCloudflareWorkerSecrets" -ForegroundColor Green
}
finally {
    if ($null -ne $keyMaterial -and $keyMaterial.Generated -and -not $KeepGeneratedKeyFile -and (Test-Path $keyMaterial.Path)) {
        Remove-Item $keyMaterial.Path -Force
    }
}