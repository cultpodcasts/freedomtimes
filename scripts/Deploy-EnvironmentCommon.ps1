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
# | Turso build creds            | Terraform outputs          | Terraform outputs             | resolve-turso-build-credentials     | .env.dev / resolve-turso            |
# | EmDash core migrate          | After backup + build       | After backup + build          | After backup + build                | After backup + build                |
# | wrangler deploy              | --env staging              | --env production              | Web only                            | Web (+ staging vars) + scheduler    |
# | EmDash migrate --check       | After wrangler             | After wrangler                | After wrangler                      | After wrangler                      |
# | Post-deploy secret verify    | Yes (web worker)           | Yes (web worker; also -DryRun)| Yes                                 | No                                  |
# | Turso EmDash backup          | Export before migrate      | Rollback branch before migrate| Same as full deploy                 | Same as full deploy                 |
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

. "$PSScriptRoot/assert-push-secrets-ready.ps1"
# Must be script-scoped: dotsourcing inside Initialize-DeployEnvironment would define
# Resolve-TerraformExecutable only in that function's local scope, then drop it on return
# (production -WorkerOnly then failed on the post-deploy Get-DeployWorkerName print).
. "$PSScriptRoot/ensure-windows-cli-path.ps1"
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

    Initialize-WindowsCliPath
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

function Ensure-DeployCloudflareWranglerAuthFromEnv {
    Ensure-DeployCloudflareAccountIdFromEnv

    if (-not [string]::IsNullOrWhiteSpace($env:CLOUDFLARE_API_TOKEN)) {
        return
    }

    $token = Get-DeployFirstNonEmpty -Values @(
        ([Environment]::GetEnvironmentVariable("TF_VAR_CLOUDFLARE_API_TOKEN", "Process")),
        (Get-DeployEnvFileValue -Path $script:DeployBaseEnvPath -Key "TF_VAR_CLOUDFLARE_API_TOKEN")
    )
    if (-not [string]::IsNullOrWhiteSpace($token)) {
        $env:CLOUDFLARE_API_TOKEN = $token
    }
}

function Get-DeployWorkerName {
    param([switch]$WorkerOnly)

    if (-not $WorkerOnly) {
        return Get-DeployTerraformOutputRaw -Name "worker_name"
    }

    # -WorkerOnly must not require Terraform. Prefer env / .env.dev, then a
    # best-effort terraform probe, then the known script name.
    $envKey = if ($script:DeployIsStaging) { "TF_VAR_WORKER_NAME_STAGING" } else { "TF_VAR_WORKER_NAME_PRODUCTION" }
    $defaultName = if ($script:DeployIsStaging) { "freedomtimes-staging" } else { "freedomtimes" }

    $fromEnv = Get-DeployFirstNonEmpty -Values @(
        ([Environment]::GetEnvironmentVariable($envKey, "Process")),
        (Get-DeployEnvFileValue -Path $script:DeployBaseEnvPath -Key $envKey)
    )
    if (-not [string]::IsNullOrWhiteSpace($fromEnv)) {
        return $fromEnv
    }

    try {
        . "$script:DeployCommonScriptRoot/resolve-turso-build-credentials.ps1"
        $terraformExe = Resolve-TerraformExecutable
        $workerName = Try-TerraformOutputRaw -TerraformExe $terraformExe -TerraformEnvDir $script:DeployTerraformEnvDir -OutputName "worker_name"
        if (-not [string]::IsNullOrWhiteSpace($workerName)) {
            return $workerName
        }
    }
    catch {
        # Fall through to the known Worker name. Callers print this after deploy.
    }

    return $defaultName
}

function Invoke-DeployPushSecretsPreflight {
    if ($script:DeployIsStaging) {
        Assert-StagingPushSecretsReady -EnvPath $script:DeployBaseEnvPath
    }
    else {
        Assert-ProductionPushSecretsReady -EnvPath $script:DeployBaseEnvPath
    }
}

function Test-DeployShouldUseWslTurso {
    if ($IsLinux) {
        return $false
    }

    return $null -ne (Get-Command wsl -ErrorAction SilentlyContinue)
}

function Get-DeployNativeTursoExe {
    $cmd = Get-Command turso -ErrorAction SilentlyContinue
    if ($cmd) {
        return $cmd.Source
    }

    $homeTurso = Join-Path $HOME ".turso/turso"
    if (Test-Path $homeTurso) {
        return $homeTurso
    }

    return $null
}

function Get-DeployTursoAuthLoginHint {
    if (Test-DeployShouldUseWslTurso) {
        return 'wsl bash -lic "turso auth login"'
    }

    return "turso auth login"
}

function Invoke-DeployTursoCli {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$TursoArgs,
        [switch]$CaptureOutput
    )

    if (Test-DeployShouldUseWslTurso) {
        $quoted = foreach ($arg in $TursoArgs) {
            "'" + ($arg -replace "'", "'\''") + "'"
        }
        $bashLine = 'export PATH="$HOME/.turso:$PATH"; turso ' + ($quoted -join " ")
        if ($CaptureOutput) {
            $lines = & wsl bash -lc $bashLine 2>&1
            return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = @($lines) }
        }

        & wsl bash -lc $bashLine
        return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = @() }
    }

    $exe = Get-DeployNativeTursoExe
    if ([string]::IsNullOrWhiteSpace($exe)) {
        throw @(
            "Turso CLI is not installed (no turso on PATH and no `$HOME/.turso/turso).",
            "Install: curl -sSfL https://get.tur.so/install.sh | bash",
            "Then: turso auth login",
            "See docs/CLI_PATHS_WINDOWS.md and AGENTS.md."
        ) -join " "
    }

    if ($CaptureOutput) {
        $lines = & $exe @TursoArgs 2>&1
        return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = @($lines) }
    }

    & $exe @TursoArgs
    return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = @() }
}

function Assert-DeployTursoAuth {
    $loginHint = Get-DeployTursoAuthLoginHint
    $whoami = Invoke-DeployTursoCli -CaptureOutput -TursoArgs @("auth", "whoami")
    $whoamiText = ($whoami.Output | Out-String).Trim()

    if ($whoami.ExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($whoamiText)) {
        throw @(
            "Turso CLI is not authenticated.",
            "Run: $loginHint",
            "Complete login, then retry deploy.",
            "See docs/CLI_PATHS_WINDOWS.md and AGENTS.md."
        ) -join " "
    }

    if ($whoamiText -match '(?i)not logged in|login required|unauthenticated|error') {
        throw @(
            "Turso CLI is not authenticated (whoami: $whoamiText).",
            "Run: $loginHint",
            "Complete login, then retry deploy."
        ) -join " "
    }

    $via = if (Test-DeployShouldUseWslTurso) { "WSL" } else { "native" }
    Write-Host "  Turso $via auth: $whoamiText" -ForegroundColor DarkGray
}

function Assert-DeployTursoWslAuth {
    Assert-DeployTursoAuth
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

    Assert-DeployTursoAuth

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
        "-Notes", "deploy-production-local.ps1 EmDash core migrate backup"
    )
    if (-not (Test-DeployShouldUseWslTurso)) {
        $rollbackArgs += "-UseNativeTurso"
    }

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

function Get-DeployFreshBackupCutoffUtc {
    return (Get-Date).ToUniversalTime().AddHours(-24)
}

function Assert-DeployFreshEmDashTursoBackup {
    $cutoff = Get-DeployFreshBackupCutoffUtc

    if ($script:DeployIsStaging) {
        $backupDir = Join-Path $script:DeployRepoRoot ".release/backups"
        $newest = Get-ChildItem -Path $backupDir -Filter "emdash-staging-*.db" -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTimeUtc -Descending |
            Select-Object -First 1
        if ($null -eq $newest -or $newest.LastWriteTimeUtc -lt $cutoff) {
            throw @(
                "Refusing -SkipTursoBackup: no staging EmDash export newer than 24h under .release/backups/emdash-staging-*.db.",
                "Create one (see web/CONTENT_PROMOTION_RUNBOOK.md) or omit -SkipTursoBackup."
            ) -join " "
        }
        Write-DeployStep "Using existing staging EmDash export $($newest.Name) (SkipTursoBackup)"
        return
    }

    $metaDir = Join-Path $script:DeployRepoRoot ".release/rollback-branches"
    $newestMeta = Get-ChildItem -Path $metaDir -Filter "*.json" -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTimeUtc -Descending |
        Select-Object -First 1
    if ($null -eq $newestMeta -or $newestMeta.LastWriteTimeUtc -lt $cutoff) {
        throw @(
            "Refusing -SkipTursoBackup: no production rollback metadata newer than 24h under .release/rollback-branches/.",
            "Run scripts/turso-create-rollback-branch.ps1 -AllowProduction or omit -SkipTursoBackup."
        ) -join " "
    }
    Write-DeployStep "Using existing production rollback metadata $($newestMeta.Name) (SkipTursoBackup)"
}

function Invoke-DeployStagingTursoExport {
    Assert-DeployTursoAuth

    $databaseName = Get-DeployTursoDatabaseNameFromEnv `
        -EnvKey "TF_VAR_TURSO_DATABASE_NAME_STAGING" `
        -DefaultName ""
    if ([string]::IsNullOrWhiteSpace($databaseName)) {
        throw "Set TF_VAR_TURSO_DATABASE_NAME_STAGING in .env.dev (or the process environment) for the staging EmDash export."
    }

    $stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMdd-HHmmss")
    $backupDir = Join-Path $script:DeployRepoRoot ".release/backups"
    if (-not (Test-Path $backupDir)) {
        New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
    }
    $outputRel = ".release/backups/emdash-staging-$stamp.db"
    $outputAbs = Join-Path $script:DeployRepoRoot $outputRel

    Write-DeployStep "Exporting staging EmDash Turso '$databaseName' → $outputRel"

    $export = Invoke-DeployTursoCli -TursoArgs @("db", "export", $databaseName, "--output-file", $outputAbs)
    if ($export.ExitCode -ne 0) {
        throw "Staging EmDash Turso export failed (exit $($export.ExitCode))."
    }

    if (-not (Test-Path $outputAbs)) {
        throw "Staging EmDash Turso export reported success but $outputAbs is missing."
    }
    Write-Host "Staging EmDash backup saved: $outputAbs" -ForegroundColor Green
}

function Invoke-DeployEmDashTursoBackup {
    param(
        [switch]$SkipTursoBackup
    )

    if ($SkipTursoBackup) {
        Write-DeployStep "Skipping Turso EmDash backup (-SkipTursoBackup); requiring a fresh checkpoint"
        Assert-DeployFreshEmDashTursoBackup
        return
    }

    if ($script:DeployIsStaging) {
        Invoke-DeployStagingTursoExport
        return
    }

    Invoke-DeployTursoRollbackCheckpoint
}

function Invoke-DeployEmdashCoreMigrate {
    Write-DeployStep "Applying EmDash core migrations (npx emdash migrate)"

    $url = [Environment]::GetEnvironmentVariable("TURSO_DATABASE_URL", "Process")
    $token = [Environment]::GetEnvironmentVariable("TURSO_AUTH_TOKEN", "Process")
    if ([string]::IsNullOrWhiteSpace($url) -or [string]::IsNullOrWhiteSpace($token)) {
        throw "EmDash core migrate requires TURSO_DATABASE_URL and TURSO_AUTH_TOKEN (load them before build)."
    }

    $manifest = Join-Path $script:DeployRepoRoot "web/.emdash/migrations.json"
    if (-not (Test-Path $manifest)) {
        throw "Missing $manifest after npm run build. Deploy aborted before migrate."
    }

    Push-Location (Join-Path $script:DeployRepoRoot "web")
    try {
        & node .\scripts\emdash-core-migrate.mjs apply
        if ($LASTEXITCODE -ne 0) {
            throw "EmDash core migrate apply failed (exit $LASTEXITCODE)."
        }
    }
    finally {
        Pop-Location
    }
}

function Invoke-DeployEmdashCoreMigrateCheck {
    Write-DeployStep "Checking EmDash core migrations (npx emdash migrate --check)"

    Push-Location (Join-Path $script:DeployRepoRoot "web")
    try {
        & node .\scripts\emdash-core-migrate.mjs check
        if ($LASTEXITCODE -ne 0) {
            throw "EmDash core migrate --check failed (exit $LASTEXITCODE)."
        }
    }
    finally {
        Pop-Location
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

    $accountId = Get-DeployFirstNonEmpty -Values @(
        ([Environment]::GetEnvironmentVariable("TF_VAR_CLOUDFLARE_ACCOUNT_ID", "Process")),
        ([Environment]::GetEnvironmentVariable("CLOUDFLARE_ACCOUNT_ID", "Process")),
        (Get-DeployEnvFileValue -Path $script:DeployBaseEnvPath -Key "TF_VAR_CLOUDFLARE_ACCOUNT_ID")
    )
    if (-not [string]::IsNullOrWhiteSpace($accountId)) {
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

    # Core migrate needs a real Turso URL in .emdash/migrations.json. Always
    # resolve credentials (Terraform outputs or .env.dev) — including -WorkerOnly.
    . "$script:DeployCommonScriptRoot/resolve-turso-build-credentials.ps1"
    $null = Set-TursoBuildEnv -Environment $script:DeployEnvironment -RepoRoot $script:DeployRepoRoot
    Assert-DeployRequiredBuildEnv

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
    Ensure-DeployCloudflareWranglerAuthFromEnv
    $wranglerConfig = Join-Path $script:DeployRepoRoot "web/wrangler.jsonc"
    Push-Location $script:DeployRepoRoot
    try {
        & npx wrangler deploy --config $wranglerConfig --env $script:DeployEnvironment @WranglerVarArgs
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

function Get-DeployRequiredWebWorkerSecretNames {
    # Names only — wrangler secret list does not return values.
    # TURSO_* are runtime Worker secrets; -WorkerOnly builds do not read them locally.
    return @(
        "AUTH0_DOMAIN",
        "AUTH0_CLIENT_ID",
        "AUTH0_CLIENT_SECRET",
        "EMDASH_AUTH_SECRET",
        "EMDASH_PREVIEW_SECRET",
        "TURSO_DATABASE_URL",
        "TURSO_AUTH_TOKEN"
    )
}

function Invoke-DeployWorkerSecretVerification {
    Write-DeployStep "Verifying $($script:DeployEnvironment) Worker secrets"
    Ensure-DeployCloudflareWranglerAuthFromEnv
    $wranglerConfig = Join-Path $script:DeployRepoRoot "web/wrangler.jsonc"
    Push-Location $script:DeployRepoRoot
    try {
        $secretOutput = & npx wrangler secret list --config $wranglerConfig --env $script:DeployEnvironment
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to list $($script:DeployEnvironment) worker secrets."
        }

        foreach ($secretName in (Get-DeployRequiredWebWorkerSecretNames)) {
            if (-not ($secretOutput -match [regex]::Escape($secretName))) {
                throw "Expected worker secret '$secretName' was not found."
            }
        }
    }
    finally {
        Pop-Location
    }
}
