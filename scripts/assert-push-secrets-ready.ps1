# Shared push secret preflight for local rebuild scripts (staging + production).
# Dot-source from Deploy-EnvironmentCommon.ps1 (deploy-staging-local.ps1 / deploy-production-local.ps1).
# FCM resolution matches production secret sync: PUSH_PRODUCTION_ANDROID_FCM_* or PUSH_STAGING_ANDROID_FCM_* fallback.

Set-StrictMode -Version Latest

function Get-PushSecretsEnvFileValue {
    param(
        [string]$Path,
        [string]$Key
    )

    if (-not (Test-Path $Path)) {
        return ""
    }

    $line = Get-Content $Path | Where-Object { $_ -match "^$([regex]::Escape($Key))=" } | Select-Object -First 1
    if ([string]::IsNullOrWhiteSpace($line)) {
        return ""
    }

    return ($line -split '=', 2)[1].Trim()
}

function Test-PushSecretsPlaceholderValue {
    param([string]$Value)

    if ([string]::IsNullOrWhiteSpace($Value)) {
        return $false
    }

    return $Value.Trim() -match '^<[^>]+>$'
}

function Get-ResolvedPushSecretValue {
    param(
        [string]$Path,
        [string[]]$Keys
    )

    foreach ($key in $Keys) {
        $value = Get-PushSecretsEnvFileValue -Path $Path -Key $key
        if (-not [string]::IsNullOrWhiteSpace($value)) {
            return [pscustomobject]@{
                Key   = $key
                Value = $value
            }
        }
    }

    return $null
}

function Get-AndroidFcmKeyGroups {
    return @(
        @{
            Label = "PUSH_PRODUCTION_ANDROID_FCM_PROJECT_ID or PUSH_STAGING_ANDROID_FCM_PROJECT_ID"
            Keys  = @(
                "PUSH_PRODUCTION_ANDROID_FCM_PROJECT_ID",
                "PUSH_STAGING_ANDROID_FCM_PROJECT_ID"
            )
        },
        @{
            Label = "PUSH_PRODUCTION_ANDROID_FCM_CLIENT_EMAIL or PUSH_STAGING_ANDROID_FCM_CLIENT_EMAIL"
            Keys  = @(
                "PUSH_PRODUCTION_ANDROID_FCM_CLIENT_EMAIL",
                "PUSH_STAGING_ANDROID_FCM_CLIENT_EMAIL"
            )
        },
        @{
            Label = "PUSH_PRODUCTION_ANDROID_FCM_PRIVATE_KEY or PUSH_STAGING_ANDROID_FCM_PRIVATE_KEY"
            Keys  = @(
                "PUSH_PRODUCTION_ANDROID_FCM_PRIVATE_KEY",
                "PUSH_STAGING_ANDROID_FCM_PRIVATE_KEY"
            )
        }
    )
}

function Assert-AndroidFcmSecretsReady {
    param(
        [Parameter(Mandatory = $true)]
        [string]$EnvPath,
        [Parameter(Mandatory = $true)]
        [ValidateSet('Staging', 'Production')]
        [string]$Target
    )

    $label = $Target.ToLowerInvariant()
    $fcmKeyGroups = Get-AndroidFcmKeyGroups
    $productionFcmKeys = @(
        "PUSH_PRODUCTION_ANDROID_FCM_PROJECT_ID",
        "PUSH_PRODUCTION_ANDROID_FCM_CLIENT_EMAIL",
        "PUSH_PRODUCTION_ANDROID_FCM_PRIVATE_KEY"
    )

    $missing = @()
    $placeholders = @()

    foreach ($group in $fcmKeyGroups) {
        $resolved = Get-ResolvedPushSecretValue -Path $EnvPath -Keys $group.Keys
        if ($null -eq $resolved) {
            $missing += $group.Label
            continue
        }

        if (Test-PushSecretsPlaceholderValue -Value $resolved.Value) {
            $placeholders += $resolved.Key
        }
    }

    if ($missing.Count -gt 0) {
        throw "Missing required $label push secret values in .env.dev: $($missing -join ', ')"
    }

    if ($placeholders.Count -gt 0) {
        throw "Unresolved placeholder $label push secret values in .env.dev: $($placeholders -join ', ')"
    }

    $allProductionFcmEmpty = $true
    foreach ($key in $productionFcmKeys) {
        $value = Get-PushSecretsEnvFileValue -Path $EnvPath -Key $key
        if (-not [string]::IsNullOrWhiteSpace($value)) {
            $allProductionFcmEmpty = $false
            break
        }
    }

    if ($allProductionFcmEmpty) {
        Write-Warning "FCM preflight is using PUSH_STAGING_ANDROID_FCM_* only (no PUSH_PRODUCTION_ANDROID_FCM_*). This matches set-github-secrets.ps1 fallback. For clarity, run .\scripts\populate-android-fcm-env.ps1 or copy values to PUSH_PRODUCTION_ANDROID_FCM_* in .env.dev."
    }
}

function Assert-PushSecretsReady {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet('Staging', 'Production')]
        [string]$Target,
        [Parameter(Mandatory = $true)]
        [string]$EnvPath
    )

    $label = $Target.ToLowerInvariant()
    $preflightMessage = "Preflight: validating $label push secret inputs in .env.dev"
    if (Get-Command Write-Step -ErrorAction SilentlyContinue) {
        Write-Step $preflightMessage
    } else {
        Write-Host "[$(Get-Date -Format 'yyyy-MM-ddTHH:mm:ssK')] $preflightMessage" -ForegroundColor Cyan
    }

    if ($Target -eq 'Production') {
        $vapidKeys = @(
            "PUSH_PRODUCTION_SUBSCRIBE_PUBLIC_KEY",
            "PUSH_PRODUCTION_VAPID_PRIVATE_KEY",
            "PUSH_PRODUCTION_VAPID_SUBJECT"
        )
    } else {
        $vapidKeys = @(
            "PUSH_STAGING_SUBSCRIBE_PUBLIC_KEY",
            "PUSH_STAGING_VAPID_PRIVATE_KEY",
            "PUSH_STAGING_VAPID_SUBJECT"
        )
    }

    $missing = @()
    $placeholders = @()

    foreach ($key in $vapidKeys) {
        $value = Get-PushSecretsEnvFileValue -Path $EnvPath -Key $key
        if ([string]::IsNullOrWhiteSpace($value)) {
            $missing += $key
            continue
        }

        if (Test-PushSecretsPlaceholderValue -Value $value) {
            $placeholders += $key
        }
    }

    if ($missing.Count -gt 0) {
        throw "Missing required $label push secret values in .env.dev: $($missing -join ', ')"
    }

    if ($placeholders.Count -gt 0) {
        throw "Unresolved placeholder $label push secret values in .env.dev: $($placeholders -join ', ')"
    }

    Assert-AndroidFcmSecretsReady -EnvPath $EnvPath -Target $Target
}

function Assert-ProductionPushSecretsReady {
    param([string]$EnvPath)

    if ([string]::IsNullOrWhiteSpace($EnvPath)) {
        throw "Assert-ProductionPushSecretsReady requires -EnvPath."
    }

    Assert-PushSecretsReady -Target Production -EnvPath $EnvPath
}

function Assert-StagingPushSecretsReady {
    param([string]$EnvPath)

    if ([string]::IsNullOrWhiteSpace($EnvPath)) {
        throw "Assert-StagingPushSecretsReady requires -EnvPath."
    }

    Assert-PushSecretsReady -Target Staging -EnvPath $EnvPath
}
