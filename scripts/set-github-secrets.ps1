param(
    [ValidateSet("Staging", "Production")]
    [string]$Target = "Staging",
    [switch]$SyncCloudflareWorkerSecrets,
    [switch]$SyncGitHubSecretsAndVars,
    [switch]$DryRun,
    [switch]$AllowProduction
)

# --- GUARDRAIL: Prevent accidental production updates ---
if ($Target -eq "Production" -and -not $AllowProduction) {
    Write-Error "[GUARDRAIL] Refusing to update production secrets. Use -AllowProduction to override, but only with explicit approval."
    exit 1
}

# --- DEBUG: Show all parameter values at script start ---
Write-Host "[DEBUG] Script parameters: Target='$Target' SyncCloudflareWorkerSecrets='$SyncCloudflareWorkerSecrets' DryRun='$DryRun'" -ForegroundColor Magenta
Write-Host "[DEBUG] PSBoundParameters: $($PSBoundParameters | Out-String)" -ForegroundColor Magenta

# Main function containing the sync logic
function Main {
    Write-Host "[DEBUG] Main function entered" -ForegroundColor Cyan
    Write-Host "[DEBUG] SyncCloudflareWorkerSecrets: $SyncCloudflareWorkerSecrets" -ForegroundColor Cyan
    Write-Host "[DEBUG] SyncGitHubSecretsAndVars: $SyncGitHubSecretsAndVars" -ForegroundColor Cyan
    Write-Host "[DEBUG] baseEnvPath: $baseEnvPath" -ForegroundColor Cyan
    Write-Host "[DEBUG] stagingEnvPath: $stagingEnvPath" -ForegroundColor Cyan
    Write-Host "[DEBUG] productionEnvPath: $productionEnvPath" -ForegroundColor Cyan
    Write-Host "[DEBUG] About to check $SyncCloudflareWorkerSecrets..." -ForegroundColor Cyan
    if ($SyncCloudflareWorkerSecrets) {
        Write-Host "[DEBUG] Entered Cloudflare Worker secret sync block" -ForegroundColor Cyan
        if ($Target -eq "Staging") {
            Write-Host "\nSyncing Cloudflare Worker secrets for STAGING..." -ForegroundColor Cyan
            Write-Host "Reading credentials from local env: .env.staging" -ForegroundColor Gray
            Assert-NoConflictingOverlayValues -BaseValues $baseEnvValues -OverlayValues $stagingOverlayValues -Keys @(
                "AUTH0_DOMAIN",
                "TF_VAR_auth0_domain",
                "AUTH0_LOGIN_APP_CLIENT_ID_STAGING",
                "AUTH0_LOGIN_APP_CLIENT_SECRET_STAGING",
                "EMDASH_AUTH_SECRET_STAGING",
                "EMDASH_PREVIEW_SECRET_STAGING",
                "TURSO_STAGING_SUBSCRIPTIONS_DB_URL",
                "TURSO_STAGING_SUBSCRIPTIONS_DB_TOKEN",
                "TURSO_STAGING_SCHEDULER_DB_URL",
                "TURSO_STAGING_SCHEDULER_DB_TOKEN",
                "PUSH_STAGING_SUBSCRIBE_PUBLIC_KEY",
                "PUSH_STAGING_VAPID_PRIVATE_KEY",
                "PUSH_STAGING_VAPID_SUBJECT",
                "PUSH_STAGING_IOS_APNS_TEAM_ID",
                "PUSH_STAGING_IOS_APNS_KEY_ID",
                "PUSH_STAGING_IOS_APNS_PRIVATE_KEY",
                "PUSH_STAGING_IOS_APNS_BUNDLE_ID"
            ) -OverlayPath $stagingEnvPath -TargetLabel "Staging"
            $stagingEnvValues = Merge-EnvValues -Base $baseEnvValues -Override $stagingOverlayValues
            $stagingAuth0Domain = Get-EnvValue -Values $stagingEnvValues -Keys @("AUTH0_DOMAIN", "TF_VAR_auth0_domain")
            Write-Host "[LOG] Setting AUTH0_DOMAIN for staging: '$stagingAuth0Domain'" -ForegroundColor Magenta
            $stagingClientId = Get-EnvValueOrThrow -Values $stagingEnvValues -Keys @("AUTH0_LOGIN_APP_CLIENT_ID_STAGING") -ErrorMessage "Missing AUTH0_LOGIN_APP_CLIENT_ID_STAGING for staging Worker secret sync."
            $stagingClientSecret = Get-EnvValueOrThrow -Values $stagingEnvValues -Keys @("AUTH0_LOGIN_APP_CLIENT_SECRET_STAGING") -ErrorMessage "Missing AUTH0_LOGIN_APP_CLIENT_SECRET_STAGING for staging Worker secret sync."
            $stagingEmdashAuthSecret = Get-EnvValueOrThrow -Values $stagingEnvValues -Keys @("EMDASH_AUTH_SECRET_STAGING") -ErrorMessage "Missing EMDASH_AUTH_SECRET_STAGING for staging Worker secret sync."
            $stagingEmdashPreviewSecret = Get-EnvValueOrThrow -Values $stagingEnvValues -Keys @("EMDASH_PREVIEW_SECRET_STAGING") -ErrorMessage "Missing EMDASH_PREVIEW_SECRET_STAGING for staging Worker secret sync."
            $stagingSubscriptionsDbUrl = Get-EnvValueOrThrow -Values $stagingEnvValues -Keys @("TURSO_STAGING_SUBSCRIPTIONS_DB_URL") -ErrorMessage "Missing TURSO_STAGING_SUBSCRIPTIONS_DB_URL for staging Worker secret sync."
            $stagingSubscriptionsDbToken = Get-EnvValueOrThrow -Values $stagingEnvValues -Keys @("TURSO_STAGING_SUBSCRIPTIONS_DB_TOKEN") -ErrorMessage "Missing TURSO_STAGING_SUBSCRIPTIONS_DB_TOKEN for staging Worker secret sync."
            $stagingSchedulerDbUrl = Get-EnvValueOrThrow -Values $stagingEnvValues -Keys @("TURSO_STAGING_SCHEDULER_DB_URL") -ErrorMessage "Missing TURSO_STAGING_SCHEDULER_DB_URL for staging scheduler Worker secret sync."
            $stagingSchedulerDbToken = Get-EnvValueOrThrow -Values $stagingEnvValues -Keys @("TURSO_STAGING_SCHEDULER_DB_TOKEN") -ErrorMessage "Missing TURSO_STAGING_SCHEDULER_DB_TOKEN for staging scheduler Worker secret sync."
            $stagingPushPublicKey = Get-EnvValueOrThrow -Values $stagingEnvValues -Keys @("PUSH_STAGING_SUBSCRIBE_PUBLIC_KEY") -ErrorMessage "Missing PUSH_STAGING_SUBSCRIBE_PUBLIC_KEY for staging Worker secret sync."
            $stagingPushPrivateKey = Get-EnvValueOrThrow -Values $stagingEnvValues -Keys @("PUSH_STAGING_VAPID_PRIVATE_KEY") -ErrorMessage "Missing PUSH_STAGING_VAPID_PRIVATE_KEY for staging scheduler Worker secret sync."
            $stagingPushSubject = Get-EnvValueOrThrow -Values $stagingEnvValues -Keys @("PUSH_STAGING_VAPID_SUBJECT") -ErrorMessage "Missing PUSH_STAGING_VAPID_SUBJECT for staging scheduler Worker secret sync."
            $stagingIosApnsTeamId = Get-EnvValue -Values $stagingEnvValues -Keys @("PUSH_STAGING_IOS_APNS_TEAM_ID")
            $stagingIosApnsKeyId = Get-EnvValue -Values $stagingEnvValues -Keys @("PUSH_STAGING_IOS_APNS_KEY_ID")
            $stagingIosApnsPrivateKey = Get-EnvValue -Values $stagingEnvValues -Keys @("PUSH_STAGING_IOS_APNS_PRIVATE_KEY")
            $stagingIosApnsBundleId = Get-EnvValue -Values $stagingEnvValues -Keys @("PUSH_STAGING_IOS_APNS_BUNDLE_ID")
            Write-Host "[DEBUG] Will set AUTH0_CLIENT_ID, AUTH0_CLIENT_SECRET, EMDASH_AUTH_SECRET, EMDASH_PREVIEW_SECRET for staging" -ForegroundColor Yellow
            Set-WorkerSecret -ConfigPath $stagingWranglerConfig -Name "AUTH0_DOMAIN" -Value $stagingAuth0Domain -WhatIfOnly:$DryRun
            Set-WorkerSecret -ConfigPath $stagingWranglerConfig -Name "AUTH0_CLIENT_ID" -Value $stagingClientId -WhatIfOnly:$DryRun
            Set-WorkerSecret -ConfigPath $stagingWranglerConfig -Name "AUTH0_CLIENT_SECRET" -Value $stagingClientSecret -WhatIfOnly:$DryRun
            Set-WorkerSecret -ConfigPath $stagingWranglerConfig -Name "TURSO_SUBSCRIPTIONS_DATABASE_URL" -Value $stagingSubscriptionsDbUrl -WhatIfOnly:$DryRun
            Set-WorkerSecret -ConfigPath $stagingWranglerConfig -Name "TURSO_SUBSCRIPTIONS_AUTH_TOKEN" -Value $stagingSubscriptionsDbToken -WhatIfOnly:$DryRun
            Set-WorkerSecret -ConfigPath $stagingWranglerConfig -Name "PUSH_SUBSCRIBE_PUBLIC_KEY" -Value $stagingPushPublicKey -WhatIfOnly:$DryRun
            Set-WorkerSecret -ConfigPath $stagingWranglerConfig -Name "EMDASH_AUTH_SECRET" -Value $stagingEmdashAuthSecret -WhatIfOnly:$DryRun
            Set-WorkerSecret -ConfigPath $stagingWranglerConfig -Name "EMDASH_PREVIEW_SECRET" -Value $stagingEmdashPreviewSecret -WhatIfOnly:$DryRun
            Set-WorkerSecret -ConfigPath $stagingSchedulerWranglerConfig -Name "TURSO_SCHEDULER_DATABASE_URL" -Value $stagingSchedulerDbUrl -WhatIfOnly:$DryRun
            Set-WorkerSecret -ConfigPath $stagingSchedulerWranglerConfig -Name "TURSO_SCHEDULER_AUTH_TOKEN" -Value $stagingSchedulerDbToken -WhatIfOnly:$DryRun
            Set-WorkerSecret -ConfigPath $stagingSchedulerWranglerConfig -Name "TURSO_SUBSCRIPTIONS_DATABASE_URL" -Value $stagingSubscriptionsDbUrl -WhatIfOnly:$DryRun
            Set-WorkerSecret -ConfigPath $stagingSchedulerWranglerConfig -Name "TURSO_SUBSCRIPTIONS_AUTH_TOKEN" -Value $stagingSubscriptionsDbToken -WhatIfOnly:$DryRun
            Set-WorkerSecret -ConfigPath $stagingSchedulerWranglerConfig -Name "PUSH_VAPID_PUBLIC_KEY" -Value $stagingPushPublicKey -WhatIfOnly:$DryRun
            Set-WorkerSecret -ConfigPath $stagingSchedulerWranglerConfig -Name "PUSH_VAPID_PRIVATE_KEY" -Value $stagingPushPrivateKey -WhatIfOnly:$DryRun
            Set-WorkerSecret -ConfigPath $stagingSchedulerWranglerConfig -Name "PUSH_VAPID_SUBJECT" -Value $stagingPushSubject -WhatIfOnly:$DryRun
            if (-not [string]::IsNullOrWhiteSpace($stagingIosApnsTeamId) -and -not [string]::IsNullOrWhiteSpace($stagingIosApnsKeyId) -and -not [string]::IsNullOrWhiteSpace($stagingIosApnsPrivateKey) -and -not [string]::IsNullOrWhiteSpace($stagingIosApnsBundleId)) {
                Set-WorkerSecret -ConfigPath $stagingSchedulerWranglerConfig -Name "PUSH_IOS_APNS_TEAM_ID" -Value $stagingIosApnsTeamId -WhatIfOnly:$DryRun
                Set-WorkerSecret -ConfigPath $stagingSchedulerWranglerConfig -Name "PUSH_IOS_APNS_KEY_ID" -Value $stagingIosApnsKeyId -WhatIfOnly:$DryRun
                Set-WorkerSecret -ConfigPath $stagingSchedulerWranglerConfig -Name "PUSH_IOS_APNS_PRIVATE_KEY" -Value $stagingIosApnsPrivateKey -WhatIfOnly:$DryRun
                Set-WorkerSecret -ConfigPath $stagingSchedulerWranglerConfig -Name "PUSH_IOS_APNS_BUNDLE_ID" -Value $stagingIosApnsBundleId -WhatIfOnly:$DryRun
            }
        }
        elseif ($Target -eq "Production") {
            Write-Host "\nSyncing Cloudflare Worker secrets for PRODUCTION..." -ForegroundColor Red
            Write-Host "Reading credentials from local env: .env.production" -ForegroundColor Gray
            Assert-NoConflictingOverlayValues -BaseValues $baseEnvValues -OverlayValues $productionOverlayValues -Keys @(
                "AUTH0_DOMAIN",
                "TF_VAR_auth0_domain",
                "AUTH0_LOGIN_APP_CLIENT_ID_PRODUCTION",
                "AUTH0_LOGIN_APP_CLIENT_SECRET_PRODUCTION",
                "TURSO_PRODUCTION_SUBSCRIPTIONS_DB_URL",
                "TURSO_PRODUCTION_SUBSCRIPTIONS_DB_TOKEN",
                "TURSO_PRODUCTION_SCHEDULER_DB_URL",
                "TURSO_PRODUCTION_SCHEDULER_DB_TOKEN",
                "PUSH_PRODUCTION_SUBSCRIBE_PUBLIC_KEY",
                "PUSH_PRODUCTION_VAPID_PRIVATE_KEY",
                "PUSH_PRODUCTION_VAPID_SUBJECT",
                "PUSH_PRODUCTION_ANDROID_FCM_PROJECT_ID",
                "PUSH_PRODUCTION_ANDROID_FCM_CLIENT_EMAIL",
                "PUSH_PRODUCTION_ANDROID_FCM_PRIVATE_KEY",
                "PUSH_PRODUCTION_IOS_APNS_TEAM_ID",
                "PUSH_PRODUCTION_IOS_APNS_KEY_ID",
                "PUSH_PRODUCTION_IOS_APNS_PRIVATE_KEY",
                "PUSH_PRODUCTION_IOS_APNS_BUNDLE_ID"
            ) -OverlayPath $productionEnvPath -TargetLabel "Production"
            $productionEnvValues = Merge-EnvValues -Base $baseEnvValues -Override $productionOverlayValues
            $productionAuth0Domain = Get-EnvValue -Values $productionEnvValues -Keys @("AUTH0_DOMAIN", "TF_VAR_auth0_domain")
            Write-Host "[LOG] Setting AUTH0_DOMAIN for production: '$productionAuth0Domain'" -ForegroundColor Magenta
            $productionClientId = Get-EnvValueOrThrow -Values $productionEnvValues -Keys @("AUTH0_LOGIN_APP_CLIENT_ID_PRODUCTION") -ErrorMessage "Missing AUTH0_LOGIN_APP_CLIENT_ID_PRODUCTION for production Worker secret sync."
            $productionClientSecret = Get-EnvValueOrThrow -Values $productionEnvValues -Keys @("AUTH0_LOGIN_APP_CLIENT_SECRET_PRODUCTION") -ErrorMessage "Missing AUTH0_LOGIN_APP_CLIENT_SECRET_PRODUCTION for production Worker secret sync."
            $productionPushPublicKey = Get-EnvValue -Values $productionEnvValues -Keys @("PUSH_PRODUCTION_SUBSCRIBE_PUBLIC_KEY")
            $productionPushPrivateKey = Get-EnvValue -Values $productionEnvValues -Keys @("PUSH_PRODUCTION_VAPID_PRIVATE_KEY")
            $productionPushSubject = Get-EnvValue -Values $productionEnvValues -Keys @("PUSH_PRODUCTION_VAPID_SUBJECT")
            # Same Firebase project for staging and production Android apps; prefer production-prefixed keys, fall back to staging.
            $productionAndroidFcmProjectId = Get-EnvValueOrThrow -Values $productionEnvValues -Keys @("PUSH_PRODUCTION_ANDROID_FCM_PROJECT_ID", "PUSH_STAGING_ANDROID_FCM_PROJECT_ID") -ErrorMessage "Missing PUSH_PRODUCTION_ANDROID_FCM_PROJECT_ID or PUSH_STAGING_ANDROID_FCM_PROJECT_ID for production scheduler Worker secret sync (required for Android FCM)."
            $productionAndroidFcmClientEmail = Get-EnvValueOrThrow -Values $productionEnvValues -Keys @("PUSH_PRODUCTION_ANDROID_FCM_CLIENT_EMAIL", "PUSH_STAGING_ANDROID_FCM_CLIENT_EMAIL") -ErrorMessage "Missing PUSH_PRODUCTION_ANDROID_FCM_CLIENT_EMAIL or PUSH_STAGING_ANDROID_FCM_CLIENT_EMAIL for production scheduler Worker secret sync (required for Android FCM)."
            $productionAndroidFcmPrivateKey = Get-EnvValueOrThrow -Values $productionEnvValues -Keys @("PUSH_PRODUCTION_ANDROID_FCM_PRIVATE_KEY", "PUSH_STAGING_ANDROID_FCM_PRIVATE_KEY") -ErrorMessage "Missing PUSH_PRODUCTION_ANDROID_FCM_PRIVATE_KEY or PUSH_STAGING_ANDROID_FCM_PRIVATE_KEY for production scheduler Worker secret sync (required for Android FCM)."
            $productionIosApnsTeamId = Get-EnvValue -Values $productionEnvValues -Keys @("PUSH_PRODUCTION_IOS_APNS_TEAM_ID")
            $productionIosApnsKeyId = Get-EnvValue -Values $productionEnvValues -Keys @("PUSH_PRODUCTION_IOS_APNS_KEY_ID")
            $productionIosApnsPrivateKey = Get-EnvValue -Values $productionEnvValues -Keys @("PUSH_PRODUCTION_IOS_APNS_PRIVATE_KEY")
            $productionIosApnsBundleId = Get-EnvValue -Values $productionEnvValues -Keys @("PUSH_PRODUCTION_IOS_APNS_BUNDLE_ID")
            # Prefer explicit production-prefixed keys; fall back to names documented in .env.dev.example (TURSO_SUBSCRIPTIONS_*, TURSO_SCHEDULER_*).
            $productionSubscriptionsDbUrl = Get-EnvValueOrThrow -Values $productionEnvValues -Keys @("TURSO_PRODUCTION_SUBSCRIPTIONS_DB_URL", "TURSO_SUBSCRIPTIONS_DATABASE_URL") -ErrorMessage "Missing production subscriptions Turso URL: set TURSO_PRODUCTION_SUBSCRIPTIONS_DB_URL or TURSO_SUBSCRIPTIONS_DATABASE_URL for production Worker secret sync."
            $productionSubscriptionsDbToken = Get-EnvValueOrThrow -Values $productionEnvValues -Keys @("TURSO_PRODUCTION_SUBSCRIPTIONS_DB_TOKEN", "TURSO_SUBSCRIPTIONS_AUTH_TOKEN") -ErrorMessage "Missing production subscriptions Turso token: set TURSO_PRODUCTION_SUBSCRIPTIONS_DB_TOKEN or TURSO_SUBSCRIPTIONS_AUTH_TOKEN for production Worker secret sync."
            $productionSchedulerDbUrl = Get-EnvValueOrThrow -Values $productionEnvValues -Keys @("TURSO_PRODUCTION_SCHEDULER_DB_URL", "TURSO_SCHEDULER_DATABASE_URL") -ErrorMessage "Missing production scheduler Turso URL: set TURSO_PRODUCTION_SCHEDULER_DB_URL or TURSO_SCHEDULER_DATABASE_URL for production scheduler Worker secret sync."
            $productionSchedulerDbToken = Get-EnvValueOrThrow -Values $productionEnvValues -Keys @("TURSO_PRODUCTION_SCHEDULER_DB_TOKEN", "TURSO_SCHEDULER_AUTH_TOKEN") -ErrorMessage "Missing production scheduler Turso token: set TURSO_PRODUCTION_SCHEDULER_DB_TOKEN or TURSO_SCHEDULER_AUTH_TOKEN for production scheduler Worker secret sync."
            Write-Host "[DEBUG] Will set AUTH0_CLIENT_ID and AUTH0_CLIENT_SECRET for production" -ForegroundColor Yellow
            Set-WorkerSecret -ConfigPath $productionWranglerConfig -Name "AUTH0_DOMAIN" -Value $productionAuth0Domain -WhatIfOnly:$DryRun
            Set-WorkerSecret -ConfigPath $productionWranglerConfig -Name "AUTH0_CLIENT_ID" -Value $productionClientId -WhatIfOnly:$DryRun
            Set-WorkerSecret -ConfigPath $productionWranglerConfig -Name "AUTH0_CLIENT_SECRET" -Value $productionClientSecret -WhatIfOnly:$DryRun
            Set-WorkerSecret -ConfigPath $productionWranglerConfig -Name "TURSO_SUBSCRIPTIONS_DATABASE_URL" -Value $productionSubscriptionsDbUrl -WhatIfOnly:$DryRun
            Set-WorkerSecret -ConfigPath $productionWranglerConfig -Name "TURSO_SUBSCRIPTIONS_AUTH_TOKEN" -Value $productionSubscriptionsDbToken -WhatIfOnly:$DryRun
            Set-WorkerSecret -ConfigPath $productionWranglerConfig -Name "PUSH_SUBSCRIBE_PUBLIC_KEY" -Value $productionPushPublicKey -WhatIfOnly:$DryRun
            Set-WorkerSecret -ConfigPath $productionSchedulerWranglerConfig -Name "TURSO_SCHEDULER_DATABASE_URL" -Value $productionSchedulerDbUrl -WhatIfOnly:$DryRun
            Set-WorkerSecret -ConfigPath $productionSchedulerWranglerConfig -Name "TURSO_SCHEDULER_AUTH_TOKEN" -Value $productionSchedulerDbToken -WhatIfOnly:$DryRun
            Set-WorkerSecret -ConfigPath $productionSchedulerWranglerConfig -Name "TURSO_SUBSCRIPTIONS_DATABASE_URL" -Value $productionSubscriptionsDbUrl -WhatIfOnly:$DryRun
            Set-WorkerSecret -ConfigPath $productionSchedulerWranglerConfig -Name "TURSO_SUBSCRIPTIONS_AUTH_TOKEN" -Value $productionSubscriptionsDbToken -WhatIfOnly:$DryRun
            Set-WorkerSecret -ConfigPath $productionSchedulerWranglerConfig -Name "PUSH_VAPID_PUBLIC_KEY" -Value $productionPushPublicKey -WhatIfOnly:$DryRun
            Set-WorkerSecret -ConfigPath $productionSchedulerWranglerConfig -Name "PUSH_VAPID_PRIVATE_KEY" -Value $productionPushPrivateKey -WhatIfOnly:$DryRun
            Set-WorkerSecret -ConfigPath $productionSchedulerWranglerConfig -Name "PUSH_VAPID_SUBJECT" -Value $productionPushSubject -WhatIfOnly:$DryRun
            Set-WorkerSecret -ConfigPath $productionSchedulerWranglerConfig -Name "PUSH_ANDROID_FCM_PROJECT_ID" -Value $productionAndroidFcmProjectId -WhatIfOnly:$DryRun
            Set-WorkerSecret -ConfigPath $productionSchedulerWranglerConfig -Name "PUSH_ANDROID_FCM_CLIENT_EMAIL" -Value $productionAndroidFcmClientEmail -WhatIfOnly:$DryRun
            Set-WorkerSecret -ConfigPath $productionSchedulerWranglerConfig -Name "PUSH_ANDROID_FCM_PRIVATE_KEY" -Value $productionAndroidFcmPrivateKey -WhatIfOnly:$DryRun
            if (-not [string]::IsNullOrWhiteSpace($productionIosApnsTeamId) -and -not [string]::IsNullOrWhiteSpace($productionIosApnsKeyId) -and -not [string]::IsNullOrWhiteSpace($productionIosApnsPrivateKey) -and -not [string]::IsNullOrWhiteSpace($productionIosApnsBundleId)) {
                Set-WorkerSecret -ConfigPath $productionSchedulerWranglerConfig -Name "PUSH_IOS_APNS_TEAM_ID" -Value $productionIosApnsTeamId -WhatIfOnly:$DryRun
                Set-WorkerSecret -ConfigPath $productionSchedulerWranglerConfig -Name "PUSH_IOS_APNS_KEY_ID" -Value $productionIosApnsKeyId -WhatIfOnly:$DryRun
                Set-WorkerSecret -ConfigPath $productionSchedulerWranglerConfig -Name "PUSH_IOS_APNS_PRIVATE_KEY" -Value $productionIosApnsPrivateKey -WhatIfOnly:$DryRun
                Set-WorkerSecret -ConfigPath $productionSchedulerWranglerConfig -Name "PUSH_IOS_APNS_BUNDLE_ID" -Value $productionIosApnsBundleId -WhatIfOnly:$DryRun
            }
        }
    }

    if ($SyncGitHubSecretsAndVars) {
        if (-not $AllowProduction) {
            Write-Error "[GUARDRAIL] SyncGitHubSecretsAndVars updates repo-level GitHub secrets and variables that affect production deployments. Use -AllowProduction to proceed."
            return
        }
        $ghRepo = "cultpodcasts/freedomtimes"
        Write-Host "`nSyncing GitHub secrets and variables from .env.dev to $ghRepo..." -ForegroundColor Cyan

        # Hardcoded list of sensitive values synced as GitHub Actions secrets.
        # Secrets are never logged by GitHub Actions and must never be displayed.
        # Includes: Cloudflare API tokens, Auth0 management client,
        # and Auth0 login app credentials for each environment.
        # See ENVIRONMENT_SETUP.md "Syncing Secrets & Variables" for the complete categorization rationale.
        $secrets = @(
            "TF_VAR_CLOUDFLARE_API_TOKEN",
            "TF_VAR_CLOUDFLARE_ACCOUNT_ID",
            "TF_VAR_CLOUDFLARE_ZONE_ID",
            "TF_VAR_AUTH0_DOMAIN",
            "TF_VAR_AUTH0_MANAGEMENT_CLIENT_ID",
            "TF_VAR_AUTH0_MANAGEMENT_CLIENT_SECRET",
            "AUTH0_LOGIN_APP_CLIENT_ID_STAGING",
            "AUTH0_LOGIN_APP_CLIENT_SECRET_STAGING",
            "AUTH0_LOGIN_APP_CLIENT_ID_PRODUCTION",
            "AUTH0_LOGIN_APP_CLIENT_SECRET_PRODUCTION",
            "TURSO_TOKEN",
            "EMDASH_AUTH_SECRET_STAGING",
            "EMDASH_PREVIEW_SECRET_STAGING",
            "ANDROID_STAGING_SIGNING_KEYSTORE_BASE64",
            "ANDROID_STAGING_SIGNING_STORE_PASSWORD",
            "ANDROID_STAGING_SIGNING_KEY_ALIAS",
            "ANDROID_STAGING_SIGNING_KEY_PASSWORD",
            "PUSH_STAGING_SUBSCRIBE_PUBLIC_KEY",
            "PUSH_STAGING_VAPID_PRIVATE_KEY",
            "PUSH_STAGING_VAPID_SUBJECT",
            "PUSH_STAGING_ANDROID_GOOGLE_SERVICES_JSON_BASE64",
            "PUSH_STAGING_IOS_APNS_TEAM_ID",
            "PUSH_STAGING_IOS_APNS_KEY_ID",
            "PUSH_STAGING_IOS_APNS_PRIVATE_KEY",
            "PUSH_STAGING_IOS_APNS_BUNDLE_ID",
            "EMDASH_AUTH_SECRET_PRODUCTION",
            "EMDASH_PREVIEW_SECRET_PRODUCTION",
            "ANDROID_PRODUCTION_SIGNING_KEYSTORE_BASE64",
            "ANDROID_PRODUCTION_SIGNING_STORE_PASSWORD",
            "ANDROID_PRODUCTION_SIGNING_KEY_ALIAS",
            "ANDROID_PRODUCTION_SIGNING_KEY_PASSWORD",
            "PUSH_PRODUCTION_SUBSCRIBE_PUBLIC_KEY",
            "PUSH_PRODUCTION_VAPID_PRIVATE_KEY",
            "PUSH_PRODUCTION_VAPID_SUBJECT",
            "PUSH_PRODUCTION_ANDROID_FCM_PROJECT_ID",
            "PUSH_PRODUCTION_ANDROID_FCM_CLIENT_EMAIL",
            "PUSH_PRODUCTION_ANDROID_FCM_PRIVATE_KEY",
            "PUSH_PRODUCTION_ANDROID_GOOGLE_SERVICES_JSON_BASE64",
            "PUSH_PRODUCTION_IOS_APNS_TEAM_ID",
            "PUSH_PRODUCTION_IOS_APNS_KEY_ID",
            "PUSH_PRODUCTION_IOS_APNS_PRIVATE_KEY",
            "PUSH_PRODUCTION_IOS_APNS_BUNDLE_ID"
        )
        Write-Host "  Syncing secrets..." -ForegroundColor Gray
        foreach ($name in $secrets) {
            $value = Get-EnvValue -Values $baseEnvValues -Keys @($name)
            Set-GhSecret -Name $name -Value $value -Repository $ghRepo -WhatIfOnly:$DryRun
        }

        # Hardcoded list of non-sensitive configuration synced as GitHub Actions variables.
        # Variables are plaintext and visible to anyone with repo access.
        # Includes: Terraform routing vars, Auth0 configuration,
        # and app-specific settings (API modes, CORS origins, domain cookies).
        # See ENVIRONMENT_SETUP.md "Syncing Secrets & Variables" for the complete categorization rationale.
        $variables = @(
            "API_UPSTREAM_MODE",
            "AUTH0_API_AUDIENCE",
            "AUTH0_API_AUDIENCE_STAGING",
            "COOKIE_BASE_DOMAIN",
            "AUTH0_ROLES_CLAIM_NAMESPACE",
            "TF_VAR_TURSO_ORGANIZATION",
            "TF_VAR_ROUTE_PATTERN_STAGING",
            "TF_VAR_ROUTE_PATTERN_PRODUCTION",
            "TF_VAR_WORKER_NAME_STAGING",
            "TF_VAR_WORKER_NAME_PRODUCTION",
            "TF_VAR_MANAGE_APEX_DNS_RECORD_STAGING",
            "TF_VAR_MANAGE_APEX_DNS_RECORD_PRODUCTION",
            "TF_VAR_APEX_DNS_RECORD_CONTENT_STAGING",
            "TF_VAR_APEX_DNS_RECORD_CONTENT_PRODUCTION",
            "TF_VAR_WORKSPACE_URL_STAGING",
            "TF_VAR_WORKSPACE_URL_PRODUCTION",
            "TF_VAR_API_MANAGEMENT_ALLOWED_ORIGINS_STAGING",
            "TF_VAR_API_MANAGEMENT_ALLOWED_ORIGINS_PRODUCTION"
        )
        Write-Host "  Syncing variables..." -ForegroundColor Gray
        foreach ($name in $variables) {
            $value = Get-EnvValue -Values $baseEnvValues -Keys @($name)
            Set-GhVariable -Name $name -Value $value -Repository $ghRepo -WhatIfOnly:$DryRun
        }
        Write-Host "`nGitHub secrets and variables synced." -ForegroundColor Green
    }
}


# --- Function definitions ---
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

function Get-EnvValueOrThrow {
    param(
        [hashtable]$Values,
        [string[]]$Keys,
        [string]$ErrorMessage
    )

    $value = Get-EnvValue -Values $Values -Keys $Keys
    if ([string]::IsNullOrWhiteSpace($value)) {
        throw $ErrorMessage
    }
    return $value
}

function Test-IsPlaceholderValue {
    param([string]$Value)

    if ([string]::IsNullOrWhiteSpace($Value)) {
        return $false
    }

    return $Value.Trim() -match '^<[^>]+>$'
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
    if (Test-IsPlaceholderValue -Value $Value) {
        throw "Refusing to sync placeholder value for GitHub secret $Name. Resolve the value in .env.dev first."
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
    if (Test-IsPlaceholderValue -Value $Value) {
        throw "Refusing to sync placeholder value for GitHub variable $Name. Resolve the value in .env.dev first."
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
    Write-Host "[DEBUG] Set-WorkerSecret called for $Name (Config: $ConfigPath)" -ForegroundColor Cyan
    if ([string]::IsNullOrWhiteSpace($Value)) {
        Write-Warning "Skipping Worker secret $Name for $ConfigPath - value is empty"
        return
    }
    if (Test-IsPlaceholderValue -Value $Value) {
        throw "Refusing to sync placeholder value for Worker secret $Name. Resolve the value in .env.dev first."
    }
    Write-Host "[DEBUG] Would run command: npx wrangler secret put $Name --config $ConfigPath" -ForegroundColor Yellow
    if ($WhatIfOnly) {
        Write-Host "  [dry-run] wrangler secret put $Name --config $ConfigPath" -ForegroundColor Yellow
        return
    }
    $processInfo = New-Object System.Diagnostics.ProcessStartInfo
    $processInfo.FileName = "npx"
    $processInfo.Arguments = "wrangler secret put $Name --config $ConfigPath"
    $processInfo.RedirectStandardInput = $true
    $processInfo.RedirectStandardOutput = $true
    $processInfo.RedirectStandardError = $true
    $processInfo.UseShellExecute = $false
    $processInfo.CreateNoWindow = $true
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $processInfo
    $process.Start() | Out-Null
    $process.StandardInput.WriteLine($Value)
    $process.StandardInput.Close()
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) {
        Write-Host $stdout -ForegroundColor Red
        Write-Host $stderr -ForegroundColor Red
        throw "Failed to set Worker secret $Name via $ConfigPath"
    }
    Write-Host $stdout -ForegroundColor Green
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

function Assert-NoConflictingOverlayValues {
    param(
        [hashtable]$BaseValues,
        [hashtable]$OverlayValues,
        [string[]]$Keys,
        [string]$OverlayPath,
        [string]$TargetLabel
    )

    if ($null -eq $OverlayValues -or $OverlayValues.Count -eq 0) {
        return
    }

    $conflicts = @()
    foreach ($key in $Keys) {
        if (-not $BaseValues.ContainsKey($key) -or -not $OverlayValues.ContainsKey($key)) {
            continue
        }

        $baseValue = [string]$BaseValues[$key]
        $overlayValue = [string]$OverlayValues[$key]

        if ([string]::IsNullOrWhiteSpace($baseValue) -or [string]::IsNullOrWhiteSpace($overlayValue)) {
            continue
        }

        if ($baseValue -ne $overlayValue) {
            $conflicts += $key
        }
    }

    if ($conflicts.Count -gt 0) {
        $joined = $conflicts -join ", "
        throw "Conflicting $TargetLabel env values detected between .env.dev and $OverlayPath for keys: $joined. Protocol: keep canonical sync values in .env.dev; if duplicated in overlay files, they must match exactly."
    }
}

# --- Main script logic ---
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot ".."))
$baseEnvPath = Join-Path $repoRoot ".env.dev"
$stagingEnvPath = Join-Path $repoRoot ".env.staging"
$productionEnvPath = Join-Path $repoRoot ".env.production"
$stagingWranglerConfig = Join-Path $repoRoot "web/wrangler.jsonc --env staging"
$productionWranglerConfig = Join-Path $repoRoot "web/wrangler.jsonc --env production"
$stagingSchedulerWranglerConfig = Join-Path $repoRoot "scheduler-worker/wrangler.jsonc --env staging"
$productionSchedulerWranglerConfig = Join-Path $repoRoot "scheduler-worker/wrangler.jsonc --env production"

$baseEnvValues = if (Test-Path $baseEnvPath) { Parse-EnvFile -Path $baseEnvPath } else { @{} }
$stagingOverlayValues = if (Test-Path $stagingEnvPath) { Parse-EnvFile -Path $stagingEnvPath } else { @{} }
$productionOverlayValues = if (Test-Path $productionEnvPath) { Parse-EnvFile -Path $productionEnvPath } else { @{} }

Main @PSBoundParameters

# --- DEBUG: Show all parameter values at script start ---
Write-Host "[DEBUG] Script parameters: Target='$Target' SyncCloudflareWorkerSecrets='$SyncCloudflareWorkerSecrets' DryRun='$DryRun'" -ForegroundColor Magenta
Write-Host "[DEBUG] PSBoundParameters: $($PSBoundParameters | Out-String)" -ForegroundColor Magenta






