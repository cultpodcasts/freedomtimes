# Shared local rebuild / worker deploy for staging and production.
# Wrappers: staging-rebuild-local.ps1, production-rebuild-local.ps1,
#           deploy-staging-worker-local.ps1, deploy-production-worker-local.ps1
# (deploy-staging-workers-only.ps1 stays separate — web + scheduler, .env.dev only, no Terraform)
#
# | Step                         | Staging (full rebuild)     | Production (full rebuild)   | Worker-only (-SkipTerraform)        |
# |------------------------------|----------------------------|-------------------------------|-------------------------------------|
# | Push preflight               | Staging VAPID + shared FCM | Production VAPID + shared FCM | Same as full rebuild                |
# | Terraform apply              | Yes                        | Yes                           | Skipped                             |
# | Auth0 .env.dev               | Verify after terraform-run | Write from output + verify    | Skipped                             |
# | Publish-only collections     | Yes (EmDash SQL)           | No                            | No                                  |
# | Secret sync                  | Always                     | Always (-AllowProduction)     | Only with -SyncCloudflareWorkerSecrets |
# | CLOUDFLARE_ACCOUNT_ID bootstrap | Yes                     | No                            | Staging only, when syncing secrets  |
# | Version bump default         | Bump unless -SkipVersionBump | No bump unless -BumpVersion | Same as full rebuild for env        |
# | Turso build creds            | Terraform outputs          | Terraform outputs             | Prod: resolve-turso-build-credentials; Staging: Terraform outputs |
# | wrangler deploy              | --env staging              | --env production              | Same                                |
# | Post-deploy secret verify    | Yes (web worker)           | Yes (web worker)              | Yes when deploy runs (not -DryRun)  |
#
# Troubleshooting: web/docs/DEPLOY_TROUBLESHOOTING.md
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("staging", "production")]
    [string]$Environment,

    [switch]$SkipTerraform,
    [switch]$SkipVersionBump,
    [switch]$BumpVersion,
    [switch]$SyncCloudflareWorkerSecrets,
    [switch]$AllowProduction,
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ($Environment -eq "production" -and $SkipTerraform -and -not $AllowProduction) {
    throw "Refusing production worker deploy without -AllowProduction."
}

if ($BumpVersion -and $SkipVersionBump) {
    throw "Cannot combine -BumpVersion and -SkipVersionBump."
}

$repoRoot = Split-Path $PSScriptRoot -Parent
$isStaging = $Environment -eq "staging"
$terraformRunScript = Join-Path $PSScriptRoot "terraform-run.ps1"
$secretSyncScript = Join-Path $PSScriptRoot "set-github-secrets.ps1"
$terraformEnvDir = Join-Path $repoRoot "infra/terraform/environments/$Environment"
$baseEnvPath = Join-Path $repoRoot ".env.dev"

. "$PSScriptRoot/ensure-windows-cli-path.ps1"
Initialize-WindowsCliPath
. "$PSScriptRoot/assert-push-secrets-ready.ps1"

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

function Get-TerraformOutputRaw {
    param([string]$Name)

    Push-Location $terraformEnvDir
    try {
        $value = (& terraform output -raw $Name).Trim()
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($value)) {
            throw "Failed to read terraform output '$Name' from $terraformEnvDir."
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

    return ($line -split "=", 2)[1].Trim()
}

function Set-TursoBuildEnvFromTerraform {
    $env:TURSO_DATABASE_URL = Get-TerraformOutputRaw -Name "turso_database_url"
    $env:TURSO_AUTH_TOKEN = Get-TerraformOutputRaw -Name "turso_database_auth_token"
}

function Set-TursoBuildEnvForWorkerDeploy {
    if ($isStaging) {
        Write-Step "Reading Turso build credentials from Terraform outputs"
        Set-TursoBuildEnvFromTerraform
        return
    }

    Write-Step "Resolving Turso build credentials (Terraform or .env.dev)"
    . "$PSScriptRoot/resolve-turso-build-credentials.ps1"
    $resolved = Set-TursoBuildEnv -Environment production -RepoRoot $repoRoot
    Write-Host "  TURSO_DATABASE_URL <= $($resolved.Url.Source)" -ForegroundColor DarkGray
    Write-Host "  TURSO_AUTH_TOKEN   <= $($resolved.Token.Source)" -ForegroundColor DarkGray
}

function Get-WorkerNameForDisplay {
    if (-not $SkipTerraform) {
        return Get-TerraformOutputRaw -Name "worker_name"
    }

    if ($isStaging) {
        return Get-TerraformOutputRaw -Name "worker_name"
    }

    . "$PSScriptRoot/resolve-turso-build-credentials.ps1"
    $terraformExe = Resolve-TerraformExecutable
    $workerName = Try-TerraformOutputRaw -TerraformExe $terraformExe -TerraformEnvDir $terraformEnvDir -OutputName "worker_name"
    if (-not [string]::IsNullOrWhiteSpace($workerName)) {
        return $workerName
    }

    $workerFromEnv = [Environment]::GetEnvironmentVariable("TF_VAR_WORKER_NAME_PRODUCTION", "Process")
    if (-not [string]::IsNullOrWhiteSpace($workerFromEnv)) {
        return $workerFromEnv.Trim()
    }

    return "freedomtimes"
}

function Invoke-PushSecretsPreflight {
    if ($isStaging) {
        Assert-StagingPushSecretsReady -EnvPath $baseEnvPath
    }
    else {
        Assert-ProductionPushSecretsReady -EnvPath $baseEnvPath
    }
}

function Invoke-TerraformApplyWithRecovery {
    Write-Step "Applying $Environment Terraform (attempt 1)"
    $arguments = @(
        "-File", $terraformRunScript,
        "-Environment", $Environment,
        "-Operation", "apply",
        "-LoadEnvFiles",
        "-AutoApprove"
    )

    $apply1 = Invoke-ChildPwsh -CaptureOutput -Arguments $arguments
    $apply1.Output | ForEach-Object { $_ }

    if ($apply1.ExitCode -ne 0) {
        throw "Terraform apply failed (exit $($apply1.ExitCode))."
    }

    if ($apply1.Output -match "(?m)^Error:\s") {
        throw "Terraform apply reported errors in output despite exit code $($apply1.ExitCode)."
    }

    Write-Step "Terraform apply succeeded on first attempt"
}

function Sync-ProductionAuth0EnvFromTerraform {
    $prodClientId = Get-TerraformOutputRaw -Name "auth0_app_client_id"
    $prodClientSecret = Get-TerraformOutputRaw -Name "auth0_app_client_secret"

    (Get-Content $baseEnvPath) |
        ForEach-Object {
            if ($_ -match "^AUTH0_LOGIN_APP_CLIENT_ID_PRODUCTION=") {
                "AUTH0_LOGIN_APP_CLIENT_ID_PRODUCTION=$prodClientId"
            }
            elseif ($_ -match "^AUTH0_LOGIN_APP_CLIENT_SECRET_PRODUCTION=") {
                "AUTH0_LOGIN_APP_CLIENT_SECRET_PRODUCTION=$prodClientSecret"
            }
            else {
                $_
            }
        } | Set-Content $baseEnvPath
}

function Assert-Auth0SyncToEnv {
    if ($isStaging) {
        Write-Step "Verifying Terraform-synced Auth0 staging credentials in .env.dev"
        $clientIdKey = "AUTH0_LOGIN_APP_CLIENT_ID_STAGING"
        $clientSecretKey = "AUTH0_LOGIN_APP_CLIENT_SECRET_STAGING"
    }
    else {
        Write-Step "Verifying Terraform-synced Auth0 production credentials in .env.dev"
        $clientIdKey = "AUTH0_LOGIN_APP_CLIENT_ID_PRODUCTION"
        $clientSecretKey = "AUTH0_LOGIN_APP_CLIENT_SECRET_PRODUCTION"
    }

    $clientIdInEnv = Get-EnvFileValue -Path $baseEnvPath -Key $clientIdKey
    $clientSecretInEnv = Get-EnvFileValue -Path $baseEnvPath -Key $clientSecretKey

    if ([string]::IsNullOrWhiteSpace($clientIdInEnv)) {
        throw "Missing $clientIdKey in .env.dev after Terraform apply."
    }

    if ([string]::IsNullOrWhiteSpace($clientSecretInEnv)) {
        throw "Missing $clientSecretKey in .env.dev after Terraform apply."
    }

    $terraformClientId = Get-TerraformOutputRaw -Name "auth0_app_client_id"
    if ($clientIdInEnv -ne $terraformClientId) {
        throw "$clientIdKey in .env.dev does not match Terraform output auth0_app_client_id."
    }
}

function Invoke-EnforceStagingPublishOnlyCollections {
    Write-Step "Enforcing publish-only collection supports for staging"

    Set-TursoBuildEnvFromTerraform
    $env:EMDASH_PUBLISH_ONLY_LABEL = "staging"

    Push-Location (Join-Path $repoRoot "web")
    try {
        & node .\scripts\enforce-publish-only-collections.cjs
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to enforce staging publish-only collection supports."
        }
    }
    finally {
        Pop-Location
        Remove-Item Env:EMDASH_PUBLISH_ONLY_LABEL -ErrorAction SilentlyContinue
    }
}

function Ensure-CloudflareAccountIdFromEnv {
    if (-not [string]::IsNullOrWhiteSpace($env:CLOUDFLARE_ACCOUNT_ID)) {
        return
    }

    $accountId = Get-EnvFileValue -Path $baseEnvPath -Key "TF_VAR_CLOUDFLARE_ACCOUNT_ID"
    if ($accountId) {
        $env:CLOUDFLARE_ACCOUNT_ID = $accountId
    }
}

function Invoke-SecretSync {
    Write-Step "Syncing Cloudflare Worker secrets for $Environment"

    if ($isStaging) {
        Ensure-CloudflareAccountIdFromEnv
        $arguments = @(
            "-File", $secretSyncScript,
            "-Target", "Staging",
            "-SyncCloudflareWorkerSecrets"
        )
    }
    else {
        $arguments = @(
            "-File", $secretSyncScript,
            "-Target", "Production",
            "-SyncCloudflareWorkerSecrets",
            "-AllowProduction"
        )
    }

    $result = Invoke-ChildPwsh -CaptureOutput -Arguments $arguments
    $result.Output | ForEach-Object { $_ }

    if ($result.ExitCode -ne 0) {
        throw "Cloudflare Worker secret sync failed."
    }
}

function Invoke-WorkerBuild {
    if ($isStaging) {
        if ($SkipVersionBump) {
            Write-Step "Skipping web version bump (-SkipVersionBump)"
        }
        else {
            . "$PSScriptRoot/bump-web-version.ps1"
            Invoke-WebVersionBump -RepoRoot $repoRoot | Out-Null
        }
    }
    else {
        if ($BumpVersion) {
            Write-Step "Bumping web version (-BumpVersion)"
            . "$PSScriptRoot/bump-web-version.ps1"
            Invoke-WebVersionBump -RepoRoot $repoRoot | Out-Null
        }
        else {
            Write-Step "Using current web/package.json version (production default: no bump; staging already bumped this release). Pass -BumpVersion to bump anyway."
        }
    }

    Write-Step "Building $Environment Worker"

    if ($SkipTerraform) {
        Set-TursoBuildEnvForWorkerDeploy
    }
    else {
        Set-TursoBuildEnvFromTerraform
    }

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

function Invoke-WorkerDeploy {
    Write-Step "Deploying $Environment Worker"
    Push-Location $repoRoot
    try {
        & npx wrangler deploy --config .\web\wrangler.jsonc --env $Environment
        if ($LASTEXITCODE -ne 0) {
            throw "Wrangler worker deploy failed."
        }
    }
    finally {
        Pop-Location
    }
}

function Invoke-Verification {
    Write-Step "Verifying $Environment Worker secrets"
    Push-Location $repoRoot
    try {
        $secretOutput = & npx wrangler secret list --config .\web\wrangler.jsonc --env $Environment
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to list $Environment worker secrets."
        }

        $requiredSecrets = @(
            "AUTH0_DOMAIN",
            "AUTH0_CLIENT_ID",
            "AUTH0_CLIENT_SECRET",
            "EMDASH_AUTH_SECRET",
            "EMDASH_PREVIEW_SECRET"
        )
        foreach ($secretName in $requiredSecrets) {
            if (-not ($secretOutput -match $secretName)) {
                throw "Expected worker secret '$secretName' was not found."
            }
        }
    }
    finally {
        Pop-Location
    }
}

$workflowLabel = if ($SkipTerraform) {
    "$Environment worker deploy (no Terraform)"
}
else {
    "$Environment rebuild"
}
Write-Step "Starting local $workflowLabel"

Invoke-PushSecretsPreflight

if (-not $SkipTerraform) {
    Invoke-TerraformApplyWithRecovery

    if (-not $isStaging) {
        Sync-ProductionAuth0EnvFromTerraform
    }

    Assert-Auth0SyncToEnv

    if ($isStaging) {
        Invoke-EnforceStagingPublishOnlyCollections
    }

    Invoke-SecretSync
}
elseif ($SyncCloudflareWorkerSecrets) {
    if ($isStaging) {
        Ensure-CloudflareAccountIdFromEnv
    }
    Invoke-SecretSync
}

if ($DryRun) {
    Write-Step "Dry run complete — credentials resolved; skipping build and deploy"
    Write-Host "Worker name (display): $(Get-WorkerNameForDisplay)" -ForegroundColor Green
    return
}

Invoke-WorkerBuild
Invoke-WorkerDeploy
Invoke-Verification

$completeLabel = if ($SkipTerraform) {
    "$Environment worker deploy finished"
}
else {
    "$Environment rebuild complete"
}
Write-Step $completeLabel
Write-Host "Worker: $(Get-WorkerNameForDisplay)" -ForegroundColor Green
