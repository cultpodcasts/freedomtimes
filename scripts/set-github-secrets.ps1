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
            $stagingEnvValues = Merge-EnvValues -Base $baseEnvValues -Override $stagingOverlayValues
            $stagingAuth0Domain = Get-EnvValue -Values $stagingEnvValues -Keys @("AUTH0_DOMAIN", "TF_VAR_auth0_domain")
            Write-Host "[LOG] Setting AUTH0_DOMAIN for staging: '$stagingAuth0Domain'" -ForegroundColor Magenta
            $stagingClientId = Get-EnvValueOrThrow -Values $stagingEnvValues -Keys @("AUTH0_LOGIN_APP_CLIENT_ID_STAGING") -ErrorMessage "Missing AUTH0_LOGIN_APP_CLIENT_ID_STAGING for staging Worker secret sync."
            $stagingClientSecret = Get-EnvValueOrThrow -Values $stagingEnvValues -Keys @("AUTH0_LOGIN_APP_CLIENT_SECRET_STAGING") -ErrorMessage "Missing AUTH0_LOGIN_APP_CLIENT_SECRET_STAGING for staging Worker secret sync."
            Write-Host "[DEBUG] Will set AUTH0_CLIENT_ID and AUTH0_CLIENT_SECRET for staging" -ForegroundColor Yellow
            Set-WorkerSecret -ConfigPath $stagingWranglerConfig -Name "AUTH0_DOMAIN" -Value $stagingAuth0Domain -WhatIfOnly:$DryRun
            Set-WorkerSecret -ConfigPath $stagingWranglerConfig -Name "AUTH0_CLIENT_ID" -Value $stagingClientId -WhatIfOnly:$DryRun
            Set-WorkerSecret -ConfigPath $stagingWranglerConfig -Name "AUTH0_CLIENT_SECRET" -Value $stagingClientSecret -WhatIfOnly:$DryRun
        }
        elseif ($Target -eq "Production") {
            Write-Host "\nSyncing Cloudflare Worker secrets for PRODUCTION..." -ForegroundColor Red
            Write-Host "Reading credentials from local env: .env.production" -ForegroundColor Gray
            $productionEnvValues = Merge-EnvValues -Base $baseEnvValues -Override $productionOverlayValues
            $productionAuth0Domain = Get-EnvValue -Values $productionEnvValues -Keys @("AUTH0_DOMAIN", "TF_VAR_auth0_domain")
            Write-Host "[LOG] Setting AUTH0_DOMAIN for production: '$productionAuth0Domain'" -ForegroundColor Magenta
            $productionClientId = Get-EnvValueOrThrow -Values $productionEnvValues -Keys @("AUTH0_LOGIN_APP_CLIENT_ID_PRODUCTION") -ErrorMessage "Missing AUTH0_LOGIN_APP_CLIENT_ID_PRODUCTION for production Worker secret sync."
            $productionClientSecret = Get-EnvValueOrThrow -Values $productionEnvValues -Keys @("AUTH0_LOGIN_APP_CLIENT_SECRET_PRODUCTION") -ErrorMessage "Missing AUTH0_LOGIN_APP_CLIENT_SECRET_PRODUCTION for production Worker secret sync."
            Write-Host "[DEBUG] Will set AUTH0_CLIENT_ID and AUTH0_CLIENT_SECRET for production" -ForegroundColor Yellow
            Set-WorkerSecret -ConfigPath $productionWranglerConfig -Name "AUTH0_DOMAIN" -Value $productionAuth0Domain -WhatIfOnly:$DryRun
            Set-WorkerSecret -ConfigPath $productionWranglerConfig -Name "AUTH0_CLIENT_ID" -Value $productionClientId -WhatIfOnly:$DryRun
            Set-WorkerSecret -ConfigPath $productionWranglerConfig -Name "AUTH0_CLIENT_SECRET" -Value $productionClientSecret -WhatIfOnly:$DryRun
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
        # Includes: Azure credentials (Terraform provider), Cloudflare API tokens, Auth0 management client,
        # TLS certificates for custom domains, and Auth0 login app credentials for each environment.
        # See ENVIRONMENT_SETUP.md "Syncing Secrets & Variables" for the complete categorization rationale.
        $secrets = @(
            "ARM_CLIENT_ID",
            "ARM_CLIENT_SECRET",
            "ARM_SUBSCRIPTION_ID",
            "ARM_TENANT_ID",
            "TF_VAR_CLOUDFLARE_API_TOKEN",
            "TF_VAR_CLOUDFLARE_ACCOUNT_ID",
            "TF_VAR_CLOUDFLARE_ZONE_ID",
            "TF_VAR_AUTH0_DOMAIN",
            "TF_VAR_AUTH0_MANAGEMENT_CLIENT_ID",
            "TF_VAR_AUTH0_MANAGEMENT_CLIENT_SECRET",
            "TF_VAR_API_CUSTOM_HOSTNAME_CERTIFICATE_BASE64_STAGING",
            "TF_VAR_API_CUSTOM_HOSTNAME_CERTIFICATE_PASSWORD_STAGING",
            "TF_VAR_API_CUSTOM_HOSTNAME_CERTIFICATE_BASE64_PRODUCTION",
            "TF_VAR_API_CUSTOM_HOSTNAME_CERTIFICATE_PASSWORD_PRODUCTION",
            "AUTH0_LOGIN_APP_CLIENT_ID_STAGING",
            "AUTH0_LOGIN_APP_CLIENT_SECRET_STAGING",
            "AUTH0_LOGIN_APP_CLIENT_ID_PRODUCTION",
            "AUTH0_LOGIN_APP_CLIENT_SECRET_PRODUCTION",
            "TURSO_TOKEN",
            "EMDASH_AUTH_SECRET_STAGING",
            "EMDASH_PREVIEW_SECRET_STAGING",
            "EMDASH_AUTH_SECRET_PRODUCTION",
            "EMDASH_PREVIEW_SECRET_PRODUCTION"
        )
        Write-Host "  Syncing secrets..." -ForegroundColor Gray
        foreach ($name in $secrets) {
            $value = Get-EnvValue -Values $baseEnvValues -Keys @($name)
            Set-GhSecret -Name $name -Value $value -Repository $ghRepo -WhatIfOnly:$DryRun
        }

        # Hardcoded list of non-sensitive configuration synced as GitHub Actions variables.
        # Variables are plaintext and visible to anyone with repo access.
        # Includes: Terraform vars (Azure location, DNS routing, custom domains), Auth0 configuration,
        # and app-specific settings (API modes, CORS origins, domain cookies).
        # See ENVIRONMENT_SETUP.md "Syncing Secrets & Variables" for the complete categorization rationale.
        $variables = @(
            "TF_VAR_AZURE_LOCATION",
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
            "TF_VAR_API_CUSTOM_HOSTNAME_STAGING",
            "TF_VAR_API_CUSTOM_HOSTNAME_PRODUCTION",
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
    Write-Host "[DEBUG] Set-WorkerSecret called for $Name (Config: $ConfigPath)" -ForegroundColor Cyan
    if ([string]::IsNullOrWhiteSpace($Value)) {
        Write-Warning "Skipping Worker secret $Name for $ConfigPath - value is empty"
        return
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

# --- Main script logic ---
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot ".."))
$baseEnvPath = Join-Path $repoRoot ".env.dev"
$stagingEnvPath = Join-Path $repoRoot ".env.staging"
$productionEnvPath = Join-Path $repoRoot ".env.production"
$stagingWranglerConfig = Join-Path $repoRoot "web/wrangler.jsonc --env staging"
$productionWranglerConfig = Join-Path $repoRoot "web/wrangler.jsonc --env production"

$baseEnvValues = if (Test-Path $baseEnvPath) { Parse-EnvFile -Path $baseEnvPath } else { @{} }
$stagingOverlayValues = if (Test-Path $stagingEnvPath) { Parse-EnvFile -Path $stagingEnvPath } else { @{} }
$productionOverlayValues = if (Test-Path $productionEnvPath) { Parse-EnvFile -Path $productionEnvPath } else { @{} }

Main @PSBoundParameters

# --- DEBUG: Show all parameter values at script start ---
Write-Host "[DEBUG] Script parameters: Target='$Target' SyncCloudflareWorkerSecrets='$SyncCloudflareWorkerSecrets' DryRun='$DryRun'" -ForegroundColor Magenta
Write-Host "[DEBUG] PSBoundParameters: $($PSBoundParameters | Out-String)" -ForegroundColor Magenta






