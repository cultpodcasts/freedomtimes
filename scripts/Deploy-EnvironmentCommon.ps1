# Shared helpers for deploy-staging-local.ps1 and deploy-production-local.ps1.
# Dot-source only — orchestration (which steps run) lives in the caller scripts.
#
# | Step                         | Staging (full deploy)      | Production (full deploy)      | Staging -WorkerOnly                 | Staging -WorkersOnly                |
# |------------------------------|----------------------------|-------------------------------|-------------------------------------|-------------------------------------|
# | Push preflight               | Staging VAPID + shared FCM | Production VAPID + shared FCM | Same as full deploy                 | Same as full deploy                 |
# | Terraform apply              | Yes                        | Yes                           | Skipped                             | Skipped                             |
# | Auth0 .env.dev               | Verify after terraform-run | Write from output + verify    | Skipped                             | Skipped                             |
# | Publish-only collections     | Yes (EmDash SQL)           | No                            | No                                  | No                                  |
# | Secret sync                  | Always                     | Always                        | Only with -SyncCloudflareWorkerSecrets | Only with -SyncCloudflareWorkerSecrets |
# | CLOUDFLARE_ACCOUNT_ID bootstrap | Yes                     | No                            | When syncing secrets                | Load .env.dev; when syncing secrets |
# | Version bump default         | Bump unless -SkipVersionBump | No bump unless -BumpVersion | Same as full deploy                 | Same as full deploy                 |
# | Turso build creds            | Terraform outputs          | Terraform outputs             | Staging: Terraform outputs          | .env.dev only                       |
# | wrangler deploy              | --env staging              | --env production              | Web only                            | Web (+ staging vars) + scheduler    |
# | Post-deploy secret verify    | Yes (web worker)           | Yes (web worker)              | Yes                                 | No                                  |
# | Turso rollback checkpoint    | No (optional manual)       | Yes before Terraform (full)   | Skipped; use -SkipTursoBackup       | Skipped                             |
#
# Production -WorkerOnly: see deploy-production-local.ps1 (resolve-turso-build-credentials; not covered above).
#
# Troubleshooting: web/docs/DEPLOY.md

$script:DeployRepoRoot = $null
$script:DeployEnvironment = $null
$script:DeployIsStaging = $false
$script:DeployTerraformRunScript = $null
$script:DeploySecretSyncScript = $null
$script:DeployTerraformEnvDir = $null
$script:DeployBaseEnvPath = $null
$script:DeployCommonScriptRoot = $PSScriptRoot
$script:DeployWebBuildStartedAt = $null

function Initialize-DeployEnvironment {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet("staging", "production")]
        [string]$Environment
    )

    $script:DeployEnvironment = $Environment
    $script:DeployIsStaging = $Environment -eq "staging"
    $script:DeployRepoRoot = Split-Path $PSScriptRoot -Parent
    $script:DeployTerraformRunScript = Join-Path $PSScriptRoot "terraform-run.ps1"
    $script:DeploySecretSyncScript = Join-Path $PSScriptRoot "set-github-secrets.ps1"
    $script:DeployTerraformEnvDir = Join-Path $script:DeployRepoRoot "infra/terraform/environments/$Environment"
    $script:DeployBaseEnvPath = Join-Path $script:DeployRepoRoot ".env.dev"

    . "$PSScriptRoot/ensure-windows-cli-path.ps1"
    Initialize-WindowsCliPath
    . "$PSScriptRoot/assert-push-secrets-ready.ps1"
}

function Write-DeployStep {
    param([string]$Message)
    $timestamp = Get-Date -Format "yyyy-MM-ddTHH:mm:ssK"
    Write-Host "[$timestamp] $Message" -ForegroundColor Cyan
}

function Invoke-DeployChildPwsh {
    param(
        [string[]]$Arguments,
        [string]$WorkingDirectory = $script:DeployRepoRoot,
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

function Get-DeployTerraformOutputRaw {
    param([string]$Name)

    Push-Location $script:DeployTerraformEnvDir
    try {
        $value = (& terraform output -raw $Name).Trim()
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($value)) {
            throw "Failed to read terraform output '$Name' from $($script:DeployTerraformEnvDir)."
        }
        return $value
    }
    finally {
        Pop-Location
    }
}

function Get-DeployEnvFileValue {
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

function Get-DeployFirstNonEmpty {
    param([string[]]$Values)

    foreach ($value in $Values) {
        if (-not [string]::IsNullOrWhiteSpace($value)) {
            return $value.Trim()
        }
    }

    return ""
}

function Import-DeployEnvFile {
    param(
        [string]$Path = $script:DeployBaseEnvPath
    )

    if (-not (Test-Path $Path)) {
        throw "Missing $Path. Add TURSO_DATABASE_URL and TURSO_AUTH_TOKEN for Astro build."
    }

    Get-Content $Path | ForEach-Object {
        $line = $_.Trim()
        if ([string]::IsNullOrWhiteSpace($line) -or $line.StartsWith("#")) { return }
        if ($line -match '^[A-Za-z_][A-Za-z0-9_]*=') {
            $parts = $line -split '=', 2
            $key = $parts[0].Trim().Trim([char]0xFEFF)
            $value = $parts[1].Trim().Trim([char]0xFEFF)
            [Environment]::SetEnvironmentVariable($key, $value, "Process")
        }
    }
}

function Set-DeployTursoBuildEnvFromEnvDev {
    foreach ($key in @("TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN")) {
        $fromProcess = [Environment]::GetEnvironmentVariable($key, "Process")
        if (-not [string]::IsNullOrWhiteSpace($fromProcess)) {
            continue
        }

        $fromFile = Get-DeployEnvFileValue -Path $script:DeployBaseEnvPath -Key $key
        if (-not [string]::IsNullOrWhiteSpace($fromFile)) {
            [Environment]::SetEnvironmentVariable($key, $fromFile, "Process")
        }
    }
}

function Assert-DeployRequiredBuildEnv {
    $missing = @()
    foreach ($key in @("TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN")) {
        $value = [Environment]::GetEnvironmentVariable($key, "Process")
        if ([string]::IsNullOrWhiteSpace($value)) {
            $missing += $key
        }
    }

    if ($missing.Count -gt 0) {
        throw "Missing required values in .env.dev (or empty after load): $($missing -join ', ')"
    }
}

function Assert-DeployFreshWebBuild {
    param(
        [string]$DistDir,
        [datetime]$BuildStartedAt
    )

    if (-not (Test-Path $DistDir)) {
        throw "Web build output missing at $DistDir. Deploy aborted."
    }

    $serverDir = Join-Path $DistDir "server"
    if (-not (Test-Path $serverDir)) {
        throw "Web build incomplete: missing $serverDir. Deploy aborted."
    }

    $newestFile = Get-ChildItem -Path $DistDir -Recurse -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1

    if ($null -eq $newestFile) {
        throw "Web build output directory is empty at $DistDir. Deploy aborted."
    }

    $staleMargin = [TimeSpan]::FromSeconds(2)
    if ($newestFile.LastWriteTime -lt ($BuildStartedAt - $staleMargin)) {
        throw @(
            "Web build output appears stale (newest file $($newestFile.FullName) at $($newestFile.LastWriteTime) predates build started at $BuildStartedAt).",
            "Deploy aborted; fix the build before deploying the web worker."
        ) -join " "
    }
}

function Get-DeployStagingWebWranglerVarArgs {
    $audience = Get-DeployFirstNonEmpty -Values @(
        ([Environment]::GetEnvironmentVariable("AUTH0_API_AUDIENCE_STAGING", "Process")),
        (Get-DeployEnvFileValue -Path $script:DeployBaseEnvPath -Key "AUTH0_API_AUDIENCE_STAGING"),
        ([Environment]::GetEnvironmentVariable("AUTH0_API_AUDIENCE", "Process")),
        (Get-DeployEnvFileValue -Path $script:DeployBaseEnvPath -Key "AUTH0_API_AUDIENCE"),
        "https://api.freedomtimes.news"
    )

    $rolesClaim = Get-DeployFirstNonEmpty -Values @(
        ([Environment]::GetEnvironmentVariable("AUTH0_ROLES_CLAIM_NAMESPACE", "Process")),
        (Get-DeployEnvFileValue -Path $script:DeployBaseEnvPath -Key "AUTH0_ROLES_CLAIM_NAMESPACE"),
        "https://freedomtimes.news/roles"
    )

    $pairs = [ordered]@{
        AUTH0_API_AUDIENCE            = $audience
        API_BASE_URL                  = "https://api-staging.freedomtimes.news/editorial"
        COOKIE_BASE_DOMAIN            = "freedomtimes.news"
        AUTH0_ROLES_CLAIM_NAMESPACE   = $rolesClaim
        API_UPSTREAM_MODE             = "apim"
    }

    $wranglerVarList = New-Object System.Collections.Generic.List[string]
    foreach ($entry in $pairs.GetEnumerator()) {
        $wranglerVarList.Add("--var")
        $wranglerVarList.Add("$($entry.Key):$($entry.Value)")
    }

    return $wranglerVarList.ToArray()
}

function Set-DeployTursoBuildEnvFromTerraform {
    $env:TURSO_DATABASE_URL = Get-DeployTerraformOutputRaw -Name "turso_database_url"
    $env:TURSO_AUTH_TOKEN = Get-DeployTerraformOutputRaw -Name "turso_database_auth_token"
}

function Set-DeployTursoBuildEnvForWorkerOnly {
    if ($script:DeployIsStaging) {
        Write-DeployStep "Reading Turso build credentials from Terraform outputs"
        Set-DeployTursoBuildEnvFromTerraform
        return
    }

    Write-DeployStep "Resolving Turso build credentials (Terraform or .env.dev)"
    . "$script:DeployCommonScriptRoot/resolve-turso-build-credentials.ps1"
    $resolved = Set-TursoBuildEnv -Environment production -RepoRoot $script:DeployRepoRoot
    Write-Host "  TURSO_DATABASE_URL <= $($resolved.Url.Source)" -ForegroundColor DarkGray
    Write-Host "  TURSO_AUTH_TOKEN   <= $($resolved.Token.Source)" -ForegroundColor DarkGray
}

function Get-DeployWorkerName {
    param([switch]$WorkerOnly)

    if (-not $WorkerOnly) {
        return Get-DeployTerraformOutputRaw -Name "worker_name"
    }

    if ($script:DeployIsStaging) {
        return Get-DeployTerraformOutputRaw -Name "worker_name"
    }

    . "$script:DeployCommonScriptRoot/resolve-turso-build-credentials.ps1"
    $terraformExe = Resolve-TerraformExecutable
    $workerName = Try-TerraformOutputRaw -TerraformExe $terraformExe -TerraformEnvDir $script:DeployTerraformEnvDir -OutputName "worker_name"
    if (-not [string]::IsNullOrWhiteSpace($workerName)) {
        return $workerName
    }

    $workerFromEnv = [Environment]::GetEnvironmentVariable("TF_VAR_WORKER_NAME_PRODUCTION", "Process")
    if (-not [string]::IsNullOrWhiteSpace($workerFromEnv)) {
        return $workerFromEnv.Trim()
    }

    return "freedomtimes"
}

function Invoke-DeployPushSecretsPreflight {
    if ($script:DeployIsStaging) {
        Assert-StagingPushSecretsReady -EnvPath $script:DeployBaseEnvPath
    }
    else {
        Assert-ProductionPushSecretsReady -EnvPath $script:DeployBaseEnvPath
    }
}

function Assert-DeployTursoWslAuth {
    if ($null -eq (Get-Command wsl -ErrorAction SilentlyContinue)) {
        throw "wsl is required for Turso rollback checkpoints. Install WSL and Turso CLI — see docs/CLI_PATHS_WINDOWS.md"
    }

    $whoamiLines = & wsl bash -lic "turso auth whoami" 2>&1
    $exitCode = $LASTEXITCODE
    $whoamiText = ($whoamiLines | Out-String).Trim()

    if ($exitCode -ne 0 -or [string]::IsNullOrWhiteSpace($whoamiText)) {
        throw @(
            "Turso CLI is not authenticated in WSL.",
            "Run: wsl bash -lic `"turso auth login`"",
            "Complete login, then retry deploy.",
            "See docs/CLI_PATHS_WINDOWS.md and AGENTS.md."
        ) -join " "
    }

    if ($whoamiText -match '(?i)not logged in|login required|unauthenticated|error') {
        throw @(
            "Turso CLI is not authenticated in WSL (whoami: $whoamiText).",
            "Run: wsl bash -lic `"turso auth login`"",
            "Complete login, then retry deploy."
        ) -join " "
    }

    Write-Host "  Turso WSL auth: $whoamiText" -ForegroundColor DarkGray
}

function Get-DeployTursoDatabaseNameFromEnv {
    param(
        [string]$EnvKey,
        [string]$DefaultName
    )

    $fromProcess = [Environment]::GetEnvironmentVariable($EnvKey, "Process")
    if (-not [string]::IsNullOrWhiteSpace($fromProcess)) {
        return $fromProcess.Trim()
    }

    $fromFile = Get-DeployEnvFileValue -Path $script:DeployBaseEnvPath -Key $EnvKey
    if (-not [string]::IsNullOrWhiteSpace($fromFile)) {
        return $fromFile
    }

    return $DefaultName
}

function Invoke-DeployTursoRollbackCheckpoint {
    param(
        [switch]$SkipTursoBackup
    )

    if ($SkipTursoBackup) {
        Write-DeployStep "Skipping Turso rollback checkpoint (-SkipTursoBackup)"
        return
    }

    Assert-DeployTursoWslAuth

    $databaseName = Get-DeployTursoDatabaseNameFromEnv `
        -EnvKey "TF_VAR_TURSO_DATABASE_NAME_PRODUCTION" `
        -DefaultName "freedomtimes-emdash-production"
    $tursoGroup = Get-DeployTursoDatabaseNameFromEnv `
        -EnvKey "TF_VAR_TURSO_DATABASE_GROUP_PRODUCTION" `
        -DefaultName "freedomtimes-production"

    $rollbackScript = Join-Path $script:DeployCommonScriptRoot "turso-create-rollback-branch.ps1"
    Write-DeployStep "Creating Turso production rollback checkpoint from '$databaseName' (group: $tursoGroup)"

    $rollbackArgs = @(
        "-File", $rollbackScript,
        "-ProductionDatabaseName", $databaseName,
        "-TursoGroup", $tursoGroup,
        "-AllowProduction",
        "-Notes", "deploy-production-local.ps1 full deploy"
    )

    $result = Invoke-DeployChildPwsh -CaptureOutput -Arguments $rollbackArgs
    $result.Output | ForEach-Object { $_ }

    if ($result.ExitCode -ne 0) {
        throw "Turso rollback checkpoint failed (exit $($result.ExitCode))."
    }

    $metadataLine = $result.Output | Where-Object { $_ -match '^Rollback metadata saved:' } | Select-Object -Last 1
    if ($metadataLine) {
        Write-Host $metadataLine -ForegroundColor Green
    }
    else {
        Write-Warning "Turso rollback checkpoint completed but metadata path was not found in script output."
    }
}

function Invoke-DeployTerraformApplyWithRecovery {
    Write-DeployStep "Applying $($script:DeployEnvironment) Terraform (attempt 1)"
    $arguments = @(
        "-File", $script:DeployTerraformRunScript,
        "-Environment", $script:DeployEnvironment,
        "-Operation", "apply",
        "-LoadEnvFiles",
        "-AutoApprove"
    )

    $apply1 = Invoke-DeployChildPwsh -CaptureOutput -Arguments $arguments
    $apply1.Output | ForEach-Object { $_ }

    if ($apply1.ExitCode -ne 0) {
        throw "Terraform apply failed (exit $($apply1.ExitCode))."
    }

    if ($apply1.Output -match "(?m)^Error:\s") {
        throw "Terraform apply reported errors in output despite exit code $($apply1.ExitCode)."
    }

    Write-DeployStep "Terraform apply succeeded on first attempt"
}

function Sync-DeployProductionAuth0EnvFromTerraform {
    $prodClientId = Get-DeployTerraformOutputRaw -Name "auth0_app_client_id"
    $prodClientSecret = Get-DeployTerraformOutputRaw -Name "auth0_app_client_secret"

    (Get-Content $script:DeployBaseEnvPath) |
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
        } | Set-Content $script:DeployBaseEnvPath
}

function Assert-DeployAuth0SyncToEnv {
    if ($script:DeployIsStaging) {
        Write-DeployStep "Verifying Terraform-synced Auth0 staging credentials in .env.dev"
        $clientIdKey = "AUTH0_LOGIN_APP_CLIENT_ID_STAGING"
        $clientSecretKey = "AUTH0_LOGIN_APP_CLIENT_SECRET_STAGING"
    }
    else {
        Write-DeployStep "Verifying Terraform-synced Auth0 production credentials in .env.dev"
        $clientIdKey = "AUTH0_LOGIN_APP_CLIENT_ID_PRODUCTION"
        $clientSecretKey = "AUTH0_LOGIN_APP_CLIENT_SECRET_PRODUCTION"
    }

    $clientIdInEnv = Get-DeployEnvFileValue -Path $script:DeployBaseEnvPath -Key $clientIdKey
    $clientSecretInEnv = Get-DeployEnvFileValue -Path $script:DeployBaseEnvPath -Key $clientSecretKey

    if ([string]::IsNullOrWhiteSpace($clientIdInEnv)) {
        throw "Missing $clientIdKey in .env.dev after Terraform apply."
    }

    if ([string]::IsNullOrWhiteSpace($clientSecretInEnv)) {
        throw "Missing $clientSecretKey in .env.dev after Terraform apply."
    }

    $terraformClientId = Get-DeployTerraformOutputRaw -Name "auth0_app_client_id"
    if ($clientIdInEnv -ne $terraformClientId) {
        throw "$clientIdKey in .env.dev does not match Terraform output auth0_app_client_id."
    }
}

function Invoke-DeployEnforceStagingPublishOnlyCollections {
    Write-DeployStep "Enforcing publish-only collection supports for staging"

    Set-DeployTursoBuildEnvFromTerraform
    $env:EMDASH_PUBLISH_ONLY_LABEL = "staging"

    Push-Location (Join-Path $script:DeployRepoRoot "web")
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

function Ensure-DeployCloudflareAccountIdFromEnv {
    if (-not [string]::IsNullOrWhiteSpace($env:CLOUDFLARE_ACCOUNT_ID)) {
        return
    }

    $accountId = Get-DeployEnvFileValue -Path $script:DeployBaseEnvPath -Key "TF_VAR_CLOUDFLARE_ACCOUNT_ID"
    if ($accountId) {
        $env:CLOUDFLARE_ACCOUNT_ID = $accountId
    }
}

function Invoke-DeploySecretSync {
    Write-DeployStep "Syncing Cloudflare Worker secrets for $($script:DeployEnvironment)"

    if ($script:DeployIsStaging) {
        Ensure-DeployCloudflareAccountIdFromEnv
        $arguments = @(
            "-File", $script:DeploySecretSyncScript,
            "-Target", "Staging",
            "-SyncCloudflareWorkerSecrets"
        )
    }
    else {
        $arguments = @(
            "-File", $script:DeploySecretSyncScript,
            "-Target", "Production",
            "-SyncCloudflareWorkerSecrets",
            "-AllowProduction"
        )
    }

    $result = Invoke-DeployChildPwsh -CaptureOutput -Arguments $arguments
    $result.Output | ForEach-Object { $_ }

    if ($result.ExitCode -ne 0) {
        throw "Cloudflare Worker secret sync failed."
    }
}

function Invoke-DeployWorkerBuild {
    param(
        [switch]$WorkerOnly,
        [switch]$WorkersOnly,
        [switch]$SkipVersionBump,
        [switch]$BumpVersion
    )

    if ($script:DeployIsStaging) {
        if ($SkipVersionBump) {
            Write-DeployStep "Skipping web version bump (-SkipVersionBump)"
        }
        else {
            . "$script:DeployCommonScriptRoot/bump-web-version.ps1"
            Invoke-WebVersionBump -RepoRoot $script:DeployRepoRoot | Out-Null
        }
    }
    else {
        if ($BumpVersion) {
            Write-DeployStep "Bumping web version (-BumpVersion)"
            . "$script:DeployCommonScriptRoot/bump-web-version.ps1"
            Invoke-WebVersionBump -RepoRoot $script:DeployRepoRoot | Out-Null
        }
        else {
            Write-DeployStep "Using current web/package.json version (production default: no bump; staging already bumped this release). Pass -BumpVersion to bump anyway."
        }
    }

    Write-DeployStep "Building $($script:DeployEnvironment) Worker"

    if ($WorkersOnly) {
        Set-DeployTursoBuildEnvFromEnvDev
        Assert-DeployRequiredBuildEnv
    }
    elseif ($WorkerOnly) {
        Set-DeployTursoBuildEnvForWorkerOnly
    }
    else {
        Set-DeployTursoBuildEnvFromTerraform
    }

    . "$script:DeployCommonScriptRoot/build-provenance-env.ps1"
    Set-BuildProvenanceEnv -RepoRoot $script:DeployRepoRoot

    $script:DeployWebBuildStartedAt = Get-Date

    Push-Location (Join-Path $script:DeployRepoRoot "web")
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

function Invoke-DeployWorkerDeploy {
    param(
        [string[]]$WranglerVarArgs = @()
    )

    Write-DeployStep "Deploying $($script:DeployEnvironment) Worker"
    Push-Location $script:DeployRepoRoot
    try {
        & npx wrangler deploy --config .\web\wrangler.jsonc --env $script:DeployEnvironment @WranglerVarArgs
        if ($LASTEXITCODE -ne 0) {
            throw "Wrangler worker deploy failed."
        }
    }
    finally {
        Pop-Location
    }
}

function Invoke-DeploySchedulerWorkerDeploy {
    if (-not $script:DeployIsStaging) {
        throw "Scheduler worker deploy is staging-only."
    }

    Write-DeployStep "Deploying scheduler worker (freedomtimes-scheduler-staging)"
    Push-Location (Join-Path $script:DeployRepoRoot "scheduler-worker")
    try {
        & npx wrangler deploy --config wrangler.jsonc --env staging
        if ($LASTEXITCODE -ne 0) {
            throw "Scheduler worker wrangler deploy failed."
        }
    }
    finally {
        Pop-Location
    }
}

function Invoke-DeployWorkerSecretVerification {
    Write-DeployStep "Verifying $($script:DeployEnvironment) Worker secrets"
    Push-Location $script:DeployRepoRoot
    try {
        $secretOutput = & npx wrangler secret list --config .\web\wrangler.jsonc --env $script:DeployEnvironment
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to list $($script:DeployEnvironment) worker secrets."
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
