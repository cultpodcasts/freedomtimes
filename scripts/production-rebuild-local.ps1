
# Local production rebuild: Terraform apply -> Auth0 .env.dev sync -> Worker secret sync -> build -> wrangler deploy.
# Preflight requires production VAPID + FCM keys in .env.dev (Assert-ProductionPushSecretsReady).
# Troubleshooting (FCM preflight, Turso secrets after worker rename, wrangler cwd, Terraform lifecycle): web/docs/DEPLOY_TROUBLESHOOTING.md
#
# Version bump default: does NOT bump web/package.json by default — production ships the same
# version staging already bumped this release (see docs/DEPLOY_TROUBLESHOOTING.md "Web version
# bump on deploy"). Pass -BumpVersion to bump anyway. -SkipVersionBump kept for backward
# compatibility as a no-op; combining it with -BumpVersion throws.
[CmdletBinding()]
param(
    [switch]$BumpVersion,
    [switch]$SkipVersionBump
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path $PSScriptRoot -Parent
. "$PSScriptRoot/ensure-windows-cli-path.ps1"
Initialize-WindowsCliPath
$terraformRunScript = Join-Path $PSScriptRoot "terraform-run.ps1"
$secretSyncScript = Join-Path $PSScriptRoot "set-github-secrets.ps1"
$productionEnvDir = Join-Path $repoRoot "infra/terraform/environments/production"
$baseEnvPath = Join-Path $repoRoot ".env.dev"

function Write-Step {
    param([string]$Message)
    $timestamp = Get-Date -Format "yyyy-MM-ddTHH:mm:ssK"
    Write-Host "[$timestamp] $Message" -ForegroundColor Cyan
}

function Invoke-ChildPwsh {
    param(
        [string[]]$Arguments,
        [string]$WorkingDirectory = $repoRoot,
        [switch]$CaptureOutput
    )
    Push-Location $WorkingDirectory
    try {
        if ($CaptureOutput) {
            $lines = & pwsh -NoProfile @Arguments 2>&1
            $exitCode = $LASTEXITCODE
            return [pscustomobject]@{ ExitCode = $exitCode; Output = @($lines) }
        }
        & pwsh -NoProfile @Arguments
        return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = @() }
    }
    finally {
        Pop-Location
    }
}

function Invoke-TerraformApplyWithRecovery {
    Write-Step "Applying production Terraform (attempt 1)"
    $arguments = @(
        "-File", $terraformRunScript,
        "-Environment", "production",
        "-Operation", "apply",
        "-LoadEnvFiles",
        "-AutoApprove"
    )

    $apply1 = Invoke-ChildPwsh -CaptureOutput -Arguments $arguments
    $apply1.Output | ForEach-Object { $_ }
    if ($apply1.ExitCode -ne 0) {
        throw "Terraform apply failed (exit $($apply1.ExitCode))."
    }

    if ($apply1.Output -match '(?m)^Error:\s') {
        throw "Terraform apply reported errors in output despite exit code $($apply1.ExitCode)."
    }

    Write-Step "Terraform apply succeeded on first attempt"
    return
}

function Get-TerraformOutputRaw {
    param([string]$Name)
    Push-Location $productionEnvDir
    try {
        $value = (& terraform output -raw $Name).Trim()
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($value)) {
            throw "Failed to read terraform output '$Name'."
        }
        return $value
    }
    finally {
        Pop-Location
    }
}

function Get-EnvFileValue {
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

function Test-IsPlaceholderValue {
    param([string]$Value)

    if ([string]::IsNullOrWhiteSpace($Value)) {
        return $false
    }

    return $Value.Trim() -match '^<[^>]+>$'
}

function Assert-ProductionPushSecretsReady {
    Write-Step "Preflight: validating production push secret inputs in .env.dev"

    $requiredKeys = @(
        "PUSH_PRODUCTION_SUBSCRIBE_PUBLIC_KEY",
        "PUSH_PRODUCTION_VAPID_PRIVATE_KEY",
        "PUSH_PRODUCTION_VAPID_SUBJECT",
        "PUSH_PRODUCTION_ANDROID_FCM_PROJECT_ID",
        "PUSH_PRODUCTION_ANDROID_FCM_CLIENT_EMAIL",
        "PUSH_PRODUCTION_ANDROID_FCM_PRIVATE_KEY"
    )

    $missing = @()
    $placeholders = @()

    foreach ($key in $requiredKeys) {
        $value = Get-EnvFileValue -Path $baseEnvPath -Key $key
        if ([string]::IsNullOrWhiteSpace($value)) {
            $missing += $key
            continue
        }

        if (Test-IsPlaceholderValue -Value $value) {
            $placeholders += $key
        }
    }

    if ($missing.Count -gt 0) {
        throw "Missing required production push secret values in .env.dev: $($missing -join ', ')"
    }

    if ($placeholders.Count -gt 0) {
        throw "Unresolved placeholder production push secret values in .env.dev: $($placeholders -join ', ')"
    }
}

function Assert-Auth0SyncToEnv {
    Write-Step "Verifying Terraform-synced Auth0 production credentials in .env.dev"
    $prodClientIdInEnv = Get-EnvFileValue -Path $baseEnvPath -Key "AUTH0_LOGIN_APP_CLIENT_ID_PRODUCTION"
    $prodClientSecretInEnv = Get-EnvFileValue -Path $baseEnvPath -Key "AUTH0_LOGIN_APP_CLIENT_SECRET_PRODUCTION"
    if ([string]::IsNullOrWhiteSpace($prodClientIdInEnv)) {
        throw "Missing AUTH0_LOGIN_APP_CLIENT_ID_PRODUCTION in .env.dev after Terraform apply."
    }
    if ([string]::IsNullOrWhiteSpace($prodClientSecretInEnv)) {
        throw "Missing AUTH0_LOGIN_APP_CLIENT_SECRET_PRODUCTION in .env.dev after Terraform apply."
    }
    $terraformClientId = Get-TerraformOutputRaw -Name "auth0_app_client_id"
    if ($prodClientIdInEnv -ne $terraformClientId) {
        throw "AUTH0_LOGIN_APP_CLIENT_ID_PRODUCTION in .env.dev does not match Terraform output auth0_app_client_id."
    }
}

function Invoke-SecretSync {
    Write-Step "Syncing Cloudflare Worker secrets for production"
    $result = Invoke-ChildPwsh -CaptureOutput -Arguments @(
        "-File", $secretSyncScript,
        "-Target", "Production",
        "-SyncCloudflareWorkerSecrets",
        "-AllowProduction"
    )
    if ($result.ExitCode -ne 0) {
        throw "Cloudflare Worker secret sync failed."
    }
}

function Invoke-WorkerDeploy {
    Write-Step "Deploying production Worker"
    Push-Location $repoRoot
    try {
        & npx wrangler deploy --config .\web\wrangler.jsonc --env production
        if ($LASTEXITCODE -ne 0) {
            throw "Wrangler worker deploy failed."
        }
    }
    finally {
        Pop-Location
    }
}

function Invoke-WorkerBuild {
    if ($BumpVersion -and $SkipVersionBump) {
        throw "Cannot combine -BumpVersion and -SkipVersionBump."
    }

    if ($BumpVersion) {
        Write-Step "Bumping web version (-BumpVersion)"
        . "$PSScriptRoot/bump-web-version.ps1"
        Invoke-WebVersionBump -RepoRoot $repoRoot | Out-Null
    } else {
        Write-Step "Using current web/package.json version (production default: no bump; staging already bumped this release). Pass -BumpVersion to bump anyway."
    }

    Write-Step "Building production Worker"

    # Set build-time env vars required by astro.config.ts from Terraform outputs
    $env:TURSO_DATABASE_URL = Get-TerraformOutputRaw -Name "turso_database_url"
    $env:TURSO_AUTH_TOKEN   = Get-TerraformOutputRaw -Name "turso_database_auth_token"

    . "$PSScriptRoot/build-provenance-env.ps1"
    Set-BuildProvenanceEnv -RepoRoot $repoRoot

    Push-Location (Join-Path $repoRoot "web")
    try {
        & npm run build
        if ($LASTEXITCODE -ne 0) {
            throw "Worker build failed."
        }
    }
    finally {
        Pop-Location
    }
}

Write-Step "Starting local production rebuild workflow"
Assert-ProductionPushSecretsReady
Invoke-TerraformApplyWithRecovery

# Update .env.dev with latest Auth0 values from Terraform outputs
$prodClientId = Get-TerraformOutputRaw -Name "auth0_app_client_id"
$prodClientSecret = Get-TerraformOutputRaw -Name "auth0_app_client_secret"

# Update .env.dev in place
(Get-Content $baseEnvPath) |
    ForEach-Object {
        if ($_ -match "^AUTH0_LOGIN_APP_CLIENT_ID_PRODUCTION=") {
            "AUTH0_LOGIN_APP_CLIENT_ID_PRODUCTION=$prodClientId"
        } elseif ($_ -match "^AUTH0_LOGIN_APP_CLIENT_SECRET_PRODUCTION=") {
            "AUTH0_LOGIN_APP_CLIENT_SECRET_PRODUCTION=$prodClientSecret"
        } else {
            $_
        }
    } | Set-Content $baseEnvPath

Assert-Auth0SyncToEnv
Invoke-SecretSync
Invoke-WorkerBuild
Invoke-WorkerDeploy

Write-Step "Production rebuild complete"
Write-Host "Worker: $(Get-TerraformOutputRaw -Name 'worker_name')"
