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
# | Build version (#168)         | Stamped, never committed   | Stamped, never committed      | Same as full deploy                 | Same as full deploy                 |
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
. "$PSScriptRoot/lib/EnvFile.ps1"
. "$PSScriptRoot/lib/WorkerSettingsVerification.ps1"
. "$PSScriptRoot/lib/TursoHeadroom.ps1"
# Set when a Terraform apply starts / when wrangler deploy succeeds; read by
# Write-DeployIncompleteAfterTerraformWarning in the deploy scripts' finally blocks.
$script:DeployTerraformApplyStarted = $false
# Last staging/production EmDash token binding from Set-TursoBuildEnv (Value, Source, Fallback).
# Read by Confirm-DeployStagingEmdashTursoToken (#140). Never printed.
$script:DeployTursoTokenBinding = $null
$script:DeployWorkerDeployCompleted = $false
# Must be script-scoped: dotsourcing inside Initialize-DeployEnvironment would define
# Resolve-TerraformExecutable only in that function's local scope, then drop it on return
# (production -WorkerOnly then failed on the post-deploy Get-DeployWorkerName print).
. "$PSScriptRoot/ensure-windows-cli-path.ps1"
$script:DeployWebBuildStartedAt = $null
# #116: the EmDash Turso URL the Worker was built with (Sync-DeployTursoBuildEnvAfterTerraform).
$script:DeployWebBuildTursoUrl = $null

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
    Initialize-LinuxNvmNodePath
    $script:DeployTerraformLockfileWasClean = $null
    $script:DeploySkipTursoMutate = $false
    # Set by Assert-DeployFreshEmDashTursoBackup (-UseFreshTursoCheckpoint).
    $script:DeployFreshBackupMetadata = $null
    # Set by deploy-staging-local.ps1 -TursoBranchBackup (deploy-worker.yml: no .db export in CI).
    $script:DeployStagingBackupAsBranch = $false
    # Set when the live production Worker predates /api/deploy-provenance.json (#142 bootstrap).
    $script:DeployLiveProvenanceBootstrap = $false
}

function Set-DeploySkipTursoMutate {
    param(
        [switch]$SkipTursoBackup,
        [switch]$WorkerOnly,
        [switch]$WorkersOnly
    )

    # Operator -SkipTursoBackup on a Worker-only hotfix: do not export, branch,
    # or run emdash migrate. Full deploy still migrates after skipping backup.
    $script:DeploySkipTursoMutate = [bool]($SkipTursoBackup -and ($WorkerOnly -or $WorkersOnly))
}

function Initialize-LinuxNvmNodePath {
    # Cloud VM: default node can be 22.14; /exec-daemon/node stays first on PATH
    # after `nvm use`, so npm ci hits EBADENGINE. Prepend nvm 22.22.2.
    if ($IsWindows -eq $true) {
        return
    }
    if ($IsLinux -ne $true) {
        return
    }

    $nvmRoot = if (-not [string]::IsNullOrWhiteSpace($env:NVM_DIR)) { $env:NVM_DIR } else { Join-Path $env:HOME ".nvm" }
    $binDir = Join-Path $nvmRoot "versions/node/v22.22.2/bin"
    $execDaemonOnPath = @($env:PATH -split [IO.Path]::PathSeparator | Where-Object { $_ -match "exec-daemon" }).Count -gt 0
    if (-not (Test-Path -LiteralPath (Join-Path $binDir "node"))) {
        $msg = "nvm Node v22.22.2 not found at $binDir. /exec-daemon/node can shadow nvm and leave npm on 22.14 (EBADENGINE). Install with nvm, then re-run deploy — do not rely on ``nvm use`` alone."
        if ($execDaemonOnPath) {
            throw $msg
        }
        Write-Warning $msg
        return
    }

    $segments = @($env:PATH -split [IO.Path]::PathSeparator | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    $env:PATH = $binDir + [IO.Path]::PathSeparator + (($segments | Where-Object { $_ -ne $binDir }) -join [IO.Path]::PathSeparator)
    Write-Host "Prepended nvm Node v22.22.2 ahead of PATH (beats /exec-daemon/node)." -ForegroundColor DarkGray
}

function Test-DeployTerraformPluginCacheMismatch {
    param([string[]]$Output)

    $text = ($Output | Out-String)
    if ([string]::IsNullOrWhiteSpace($text)) {
        return $false
    }

    return ($text -match "Required plugins are not installed") -or
        ($text -match "does not match any of the checksums recorded in the dependency lock file")
}

function Invoke-DeployTerraformInit {
    Write-DeployStep "terraform init $($script:DeployEnvironment) (provider plugins / .terraform)"
    $arguments = @(
        "-File", $script:DeployTerraformRunScript,
        "-Environment", $script:DeployEnvironment,
        "-Operation", "init",
        "-LoadEnvFiles"
    )
    $init = Invoke-DeployChildPwsh -CaptureOutput -Arguments $arguments
    $init.Output | ForEach-Object { $_ }
    if ($init.ExitCode -ne 0) {
        throw "Terraform init failed (exit $($init.ExitCode))."
    }
}

function Restore-DeployTerraformLockfileIfCleanStart {
    param([bool]$LockfileWasClean)

    if (-not $LockfileWasClean) {
        Write-DeployStep "Leaving .terraform.lock.hcl as-is (it was already dirty before deploy)"
        return
    }

    $lockRel = "infra/terraform/environments/$($script:DeployEnvironment)/.terraform.lock.hcl"
    Push-Location $script:DeployRepoRoot
    try {
        $status = & git status --porcelain -- $lockRel 2>$null
        if ([string]::IsNullOrWhiteSpace($status)) {
            return
        }

        Write-DeployStep "Reverting Linux-only hash changes in $lockRel (do not commit unless asked)"
        & git checkout -- $lockRel
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "git checkout -- $lockRel failed (exit $LASTEXITCODE). Revert the lockfile hash-only diff manually."
        }
    }
    finally {
        Pop-Location
    }
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
        $value = & terraform output -raw $Name
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to read terraform output '$Name' from $($script:DeployTerraformEnvDir) (exit $LASTEXITCODE). If the lockfile was reverted, terraform CLI can no longer load providers — restore lockfile only after the last terraform output."
        }
        $trimmed = if ($null -eq $value) { "" } else { ([string]$value).Trim() }
        if ([string]::IsNullOrWhiteSpace($trimmed)) {
            throw "Failed to read terraform output '$Name' from $($script:DeployTerraformEnvDir)."
        }
        return $trimmed
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

    # Overwrite semantics (every key, last occurrence wins). Parser: scripts/lib/EnvFile.ps1.
    foreach ($entry in (Read-EnvFileEntries -Path $Path)) {
        [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, "Process")
    }
}

function Set-DeployTursoBuildEnvFromEnvDev {
    if ([string]::IsNullOrWhiteSpace($script:DeployBaseEnvPath)) {
        return
    }
    # Fill-missing only: process values win; a missing .env.dev is a no-op.
    $null = Import-EnvFileFillMissing -Path $script:DeployBaseEnvPath -Keys @("TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN")
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
    # Same Select-Staging* / production-shadow rules as Worker build + migrate.
    # Do not clobber TURSO_AUTH_TOKEN with an empty Terraform output (that used
    # to leave process production JWT paired with a staging URL).
    . "$script:DeployCommonScriptRoot/resolve-turso-build-credentials.ps1"
    $script:DeployTursoTokenBinding = (Set-TursoBuildEnv -Environment $script:DeployEnvironment -RepoRoot $script:DeployRepoRoot).Token
}

function Test-DeployCloudflareApiTokenPlausible {
    param([string]$Token)

    # Cloudflare API tokens used by Wrangler are typically 40+ characters.
    # Cursor Cloud has injected a ~31-character CLOUDFLARE_API_TOKEN stub that
    # shadows TF_VAR_CLOUDFLARE_API_TOKEN; wrangler then fails with
    # Authorization header 6111 / API 9106.
    if ([string]::IsNullOrWhiteSpace($Token)) {
        return $false
    }

    $trimmed = $Token.Trim()
    if ($trimmed.Length -lt 40) {
        return $false
    }

    if ($trimmed -match "\s") {
        return $false
    }

    return $true
}

function Ensure-DeployCloudflareWranglerAuthFromEnv {
    Ensure-DeployCloudflareAccountIdFromEnv

    $tfToken = Get-DeployFirstNonEmpty -Values @(
        ([Environment]::GetEnvironmentVariable("TF_VAR_CLOUDFLARE_API_TOKEN", "Process")),
        (Get-DeployEnvFileValue -Path $script:DeployBaseEnvPath -Key "TF_VAR_CLOUDFLARE_API_TOKEN")
    )

    $current = $env:CLOUDFLARE_API_TOKEN
    if (Test-DeployCloudflareApiTokenPlausible -Token $current) {
        return
    }

    if (Test-DeployCloudflareApiTokenPlausible -Token $tfToken) {
        if (-not [string]::IsNullOrWhiteSpace($current)) {
            Write-Warning ("CLOUDFLARE_API_TOKEN is not usable for Wrangler (length {0}); using TF_VAR_CLOUDFLARE_API_TOKEN." -f $current.Trim().Length)
        }
        $env:CLOUDFLARE_API_TOKEN = $tfToken.Trim()
        return
    }

    throw "CLOUDFLARE_API_TOKEN is not usable for Wrangler and TF_VAR_CLOUDFLARE_API_TOKEN is missing or too short. Set TF_VAR_CLOUDFLARE_API_TOKEN (never print it). A short process stub causes Wrangler 6111 / 9106 after Terraform."
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

function Test-DeployTursoTokenLooksLikeDatabaseJwt {
    param([string]$Value)

    if ([string]::IsNullOrWhiteSpace($Value)) {
        return $false
    }

    $v = $Value.Trim()
    return $v.StartsWith("eyJ") -and (@($v.Split(".")).Count -ge 3)
}

function Get-DeployTursoPlatformApiTokenBinding {
    $preferredKeys = @(
        "TURSO_PLATFORM_API_TOKEN",
        "TURSO_API_TOKEN",
        "TF_VAR_turso_api_token"
    )

    foreach ($key in $preferredKeys) {
        $fromProcess = [Environment]::GetEnvironmentVariable($key, "Process")
        if ([string]::IsNullOrWhiteSpace($fromProcess)) {
            $fromProcess = Get-DeployEnvFileValue -Path $script:DeployBaseEnvPath -Key $key
        }
        if (-not [string]::IsNullOrWhiteSpace($fromProcess)) {
            return [pscustomobject]@{ Key = $key; Value = $fromProcess.Trim() }
        }
    }

    $legacy = [Environment]::GetEnvironmentVariable("TURSO_TOKEN", "Process")
    if ([string]::IsNullOrWhiteSpace($legacy)) {
        $legacy = Get-DeployEnvFileValue -Path $script:DeployBaseEnvPath -Key "TURSO_TOKEN"
    }
    if ([string]::IsNullOrWhiteSpace($legacy)) {
        return $null
    }

    $trimmed = $legacy.Trim()
    if (Test-DeployTursoTokenLooksLikeDatabaseJwt -Value $trimmed) {
        Write-Warning "TURSO_TOKEN looks like a libsql database JWT; skipping for turso CLI auth. Use TURSO_PLATFORM_API_TOKEN (never TURSO_AUTH_TOKEN)."
        return $null
    }

    return [pscustomobject]@{ Key = "TURSO_TOKEN"; Value = $trimmed }
}

function Set-DeployNativeTursoCliTokenFromEnv {
    if (Test-DeployShouldUseWslTurso) {
        return $false
    }

    $binding = Get-DeployTursoPlatformApiTokenBinding
    if ($null -eq $binding) {
        return $false
    }

    $exe = Get-DeployNativeTursoExe
    if ([string]::IsNullOrWhiteSpace($exe)) {
        return $false
    }

    $stdoutFile = [System.IO.Path]::GetTempFileName()
    $stderrFile = [System.IO.Path]::GetTempFileName()
    try {
        $proc = Start-Process -FilePath $exe -ArgumentList @("config", "set", "token", $binding.Value) `
            -Wait -PassThru -NoNewWindow `
            -RedirectStandardOutput $stdoutFile -RedirectStandardError $stderrFile
        if ($proc.ExitCode -ne 0) {
            throw "turso config set token failed (exit $($proc.ExitCode)) using $($binding.Key). Token value not logged."
        }
        Write-Host "  Turso CLI token set from $($binding.Key)" -ForegroundColor DarkGray
        return $true
    }
    finally {
        Remove-Item -LiteralPath $stdoutFile, $stderrFile -Force -ErrorAction SilentlyContinue
    }
}

function Convert-DeployWindowsPathToWsl {
    param([Parameter(Mandatory = $true)][string]$Path)

    # WSL turso cannot write to a Windows-style C:\… path; map to /mnt/<drive>/…
    if ($Path -match '^[A-Za-z]:[\\/]') {
        $full = [System.IO.Path]::GetFullPath($Path)
        $drive = $full.Substring(0, 1).ToLowerInvariant()
        $rest = $full.Substring(2) -replace '\\', '/'
        return "/mnt/$drive/$rest"
    }

    return $Path
}

function Invoke-DeployTursoCli {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$TursoArgs,
        [switch]$CaptureOutput
    )

    if (Test-DeployShouldUseWslTurso) {
        $quoted = foreach ($arg in $TursoArgs) {
            $mapped = Convert-DeployWindowsPathToWsl -Path $arg
            "'" + ($mapped -replace "'", "'\''") + "'"
        }
        $bashLine = 'export PATH="$HOME/.turso:$PATH"; turso ' + ($quoted -join " ")
        $lines = & wsl bash -lc $bashLine 2>&1
        $code = $LASTEXITCODE
        if (-not $CaptureOutput) {
            $lines | ForEach-Object { Write-Host $_ }
            $lines = @()
        }
        return [pscustomobject]@{ ExitCode = $code; Output = @($lines) }
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

    $lines = & $exe @TursoArgs 2>&1
    $code = $LASTEXITCODE
    if (-not $CaptureOutput) {
        $lines | ForEach-Object { Write-Host $_ }
        $lines = @()
    }
    return [pscustomobject]@{ ExitCode = $code; Output = @($lines) }
}

function Assert-DeployTursoAuth {
    $loginHint = Get-DeployTursoAuthLoginHint
    $null = Set-DeployNativeTursoCliTokenFromEnv
    $whoami = Invoke-DeployTursoCli -CaptureOutput -TursoArgs @("auth", "whoami")
    $whoamiText = ($whoami.Output | Out-String).Trim()
    $whoamiUser = (
        $whoamiText -split "(`r`n|`n)" |
            Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
            Select-Object -Last 1
    )
    if (Test-DeployTursoTokenLooksLikeDatabaseJwt -Value $whoamiUser) {
        $whoamiUser = "(redacted)"
    }

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
    Write-Host "  Turso $via auth: $whoamiUser" -ForegroundColor DarkGray
}

function Assert-DeployTursoWslAuth {
    Assert-DeployTursoAuth
}

function Get-DeployLibsqlHostname {
    param([string]$Url)

    if ([string]::IsNullOrWhiteSpace($Url)) {
        return ""
    }

    $hostPart = $Url.Trim() -replace "^libsql://", "" -replace "^https://", ""
    $hostPart = ($hostPart -split "\?")[0]
    $at = $hostPart.LastIndexOf("@")
    if ($at -ge 0) {
        $hostPart = $hostPart.Substring($at + 1)
    }

    return $hostPart.TrimEnd("/").ToLowerInvariant()
}

function Test-DeployUrlLooksLikeProductionEmdash {
    param([string]$Url)

    $hostname = Get-DeployLibsqlHostname -Url $Url
    return (-not [string]::IsNullOrWhiteSpace($hostname)) -and ($hostname -match "-emdash-production")
}

function Get-DeployProductionEmdashUrlCandidates {
    $urls = [System.Collections.Generic.List[string]]::new()
    foreach ($candidate in @(
            [Environment]::GetEnvironmentVariable("TURSO_PRODUCTION_EMDASH_DB_URL", "Process"),
            (Get-DeployEnvFileValue -Path $script:DeployBaseEnvPath -Key "TURSO_PRODUCTION_EMDASH_DB_URL"),
            [Environment]::GetEnvironmentVariable("TURSO_DATABASE_URL", "Process")
        )) {
        if ([string]::IsNullOrWhiteSpace($candidate)) {
            continue
        }
        if (-not (Test-DeployUrlLooksLikeProductionEmdash -Url $candidate)) {
            continue
        }
        $urls.Add($candidate.Trim())
    }

    return $urls.ToArray()
}

function Test-DeployRollbackSourceMatchesProductionEmDash {
    param(
        [string]$SourceDatabase,
        [string]$ExpectedDatabase = "",
        [string[]]$ProductionUrls = @()
    )

    if ([string]::IsNullOrWhiteSpace($SourceDatabase)) {
        return $false
    }

    # Literal placeholder left in-repo by redaction — never treat it as a real DB name.
    if ($SourceDatabase -eq "[REDACTED]-emdash-production" -or $SourceDatabase -match "REDACTED") {
        return $false
    }

    $source = $SourceDatabase.Trim()
    if (-not [string]::IsNullOrWhiteSpace($ExpectedDatabase) -and $ExpectedDatabase -notmatch "REDACTED" -and $source -eq $ExpectedDatabase.Trim()) {
        return $true
    }

    $urls = @($ProductionUrls)
    if ($urls.Count -eq 0) {
        $urls = @(Get-DeployProductionEmdashUrlCandidates)
    }

    foreach ($url in $urls) {
        $hostname = Get-DeployLibsqlHostname -Url $url
        if ([string]::IsNullOrWhiteSpace($hostname)) {
            continue
        }
        if ($hostname.StartsWith($source.ToLowerInvariant(), [StringComparison]::Ordinal)) {
            return $true
        }
    }

    return $false
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

    $tursoGroup = Get-DeployTursoDatabaseNameFromEnv `
        -EnvKey "TF_VAR_TURSO_DATABASE_GROUP_PRODUCTION" `
        -DefaultName "freedomtimes-production"

    # NEVER assume freedomtimes-emdash-production — resolve the Worker DB first.
    $backupScript = Join-Path $script:DeployCommonScriptRoot "backup-production-emdash.ps1"
    Write-DeployStep "Creating verified Worker-resolved production EmDash backup (not the named thin DB)"

    $backupArgs = @(
        "-File", $backupScript,
        "-AllowProduction",
        "-TursoGroup", $tursoGroup,
        "-SkipStagingCompare",
        "-Notes", "deploy-production-local.ps1 Worker-resolved EmDash backup"
    )
    if (-not (Test-DeployShouldUseWslTurso)) {
        $backupArgs += "-UseNativeTurso"
    }

    $result = Invoke-DeployChildPwsh -CaptureOutput -Arguments $backupArgs
    $result.Output | ForEach-Object { $_ }

    if ($result.ExitCode -ne 0) {
        throw "Production EmDash backup/verify failed (exit $($result.ExitCode)). Do not migrate. See scripts/backup-production-emdash.ps1."
    }
}

function Get-DeployFreshBackupCutoffUtc {
    return (Get-Date).ToUniversalTime().AddHours(-24)
}

function Get-DeployRollbackMetadataFreshnessUtc {
    param(
        [Parameter(Mandatory = $true)]
        [System.IO.FileInfo]$File,
        [object]$Meta = $null
    )

    $created = $null
    if ($null -ne $Meta) {
        $prop = $Meta.PSObject.Properties["createdAtUtc"]
        if ($null -ne $prop -and -not [string]::IsNullOrWhiteSpace([string]$prop.Value)) {
            $created = [string]$prop.Value
        }
    }
    if ($null -ne $created) {
        try {
            return ([datetime]$created.Trim()).ToUniversalTime()
        }
        catch {
            # Fall through to file mtime.
        }
    }

    $mtime = $File.LastWriteTimeUtc
    # Cloud VM snapshots often stamp git files at Unix epoch. That is not a fresh checkpoint.
    if ($mtime -le [datetime]::UnixEpoch.AddMinutes(1)) {
        return [datetime]::MinValue
    }

    return $mtime
}

function Select-DeployFreshVerifiedProductionBackup {
    <#
    .SYNOPSIS
      Pick the newest production backup metadata that is verified, fresh and complete.

    .DESCRIPTION
      Used by deploy-production-local.ps1 -UseFreshTursoCheckpoint (deploy-worker.yml), which
      takes the backup in an earlier step instead of here. Pure apart from reading the files,
      so scripts/test-deploy-cloud-agent-guards.ps1 can exercise it.

      A candidate counts only when ALL of these hold:
        - kind = production-emdash-content-backup (written by backup-production-emdash.ps1)
        - verificationPass = true (a name match alone is never enough)
        - backupDatabase is a prod-rollback-YYYYMMDD-HHMMSS Turso branch (or prod-backup-*, the
          name backup-production-emdash.ps1 used before 31 Oct 2026)
        - workerTursoHost is set (the migrate-target host check needs it)
        - createdAtUtc (else file mtime) is not older than CutoffUtc

      Returns [pscustomobject]@{ Metadata; File; Rejected } where Metadata/File are $null when
      nothing qualifies, and Rejected lists "<file>: <reason>" for every candidate skipped.
    #>
    param(
        [Parameter(Mandatory = $true)]
        [string]$MetadataDir,
        [Parameter(Mandatory = $true)]
        [datetime]$CutoffUtc
    )

    $rejected = [System.Collections.Generic.List[string]]::new()
    $candidates = @(Get-ChildItem -Path $MetadataDir -Filter "*.json" -File -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -like "*prod-rollback-*.json" -or $_.Name -like "*prod-backup-*.json" } |
            Sort-Object LastWriteTimeUtc -Descending)
    foreach ($candidate in $candidates) {
        try {
            $meta = Get-Content -LiteralPath $candidate.FullName -Raw -ErrorAction Stop | ConvertFrom-Json
        }
        catch {
            $rejected.Add("$($candidate.Name): not valid JSON")
            continue
        }
        if ($null -eq $meta -or $meta -isnot [pscustomobject]) {
            $rejected.Add("$($candidate.Name): not a JSON object")
            continue
        }
        $props = $meta.PSObject.Properties
        $kind = if ($props["kind"]) { [string]$meta.kind } else { "" }
        if ($kind -ne "production-emdash-content-backup") {
            $rejected.Add("$($candidate.Name): kind '$kind' is not production-emdash-content-backup")
            continue
        }
        $verified = $props["verificationPass"] -and ($meta.verificationPass -eq $true)
        if (-not $verified) {
            $rejected.Add("$($candidate.Name): verificationPass is not true")
            continue
        }
        $backupDatabase = if ($props["backupDatabase"]) { [string]$meta.backupDatabase } else { "" }
        if ($backupDatabase -notmatch '^prod-(rollback|backup)-\d{8}-\d{6}$') {
            $rejected.Add("$($candidate.Name): backupDatabase '$backupDatabase' is not a prod-rollback-YYYYMMDD-HHMMSS (or legacy prod-backup-*) branch")
            continue
        }
        $workerHost = if ($props["workerTursoHost"]) { [string]$meta.workerTursoHost } else { "" }
        if ([string]::IsNullOrWhiteSpace($workerHost)) {
            $rejected.Add("$($candidate.Name): workerTursoHost is missing")
            continue
        }
        $freshAt = Get-DeployRollbackMetadataFreshnessUtc -File $candidate -Meta $meta
        if ($freshAt -lt $CutoffUtc) {
            $rejected.Add("$($candidate.Name): created $($freshAt.ToString('o')) is older than the cutoff $($CutoffUtc.ToString('o'))")
            continue
        }
        return [pscustomobject]@{ Metadata = $meta; File = $candidate; Rejected = $rejected.ToArray() }
    }

    return [pscustomobject]@{ Metadata = $null; File = $null; Rejected = $rejected.ToArray() }
}

function Assert-DeployFreshEmDashTursoBackup {
    <#
    .SYNOPSIS
      -UseFreshTursoCheckpoint gate: require a verified production backup from earlier in the run.

    .DESCRIPTION
      Throws (nothing migrated or deployed) unless Select-DeployFreshVerifiedProductionBackup finds
      a verified, fresh prod-rollback-* (or legacy prod-backup-*) metadata file. Stores it in $script:DeployFreshBackupMetadata so
      Assert-DeployMigrateTargetMatchesBackupHost can compare hosts after the build resolves the
      migrate target.
    #>
    if ($script:DeployIsStaging) {
        throw "Assert-DeployFreshEmDashTursoBackup is production-only (-UseFreshTursoCheckpoint)."
    }

    $metaDir = Join-Path $script:DeployRepoRoot ".release/rollback-branches"
    $selection = Select-DeployFreshVerifiedProductionBackup -MetadataDir $metaDir -CutoffUtc (Get-DeployFreshBackupCutoffUtc)
    foreach ($reason in @($selection.Rejected)) {
        Write-Warning "Ignoring backup metadata $reason"
    }
    if ($null -eq $selection.Metadata) {
        throw @(
            "Refusing to migrate or deploy: -UseFreshTursoCheckpoint needs a verified production backup newer than 24h",
            "(.release/rollback-branches/*.json with kind production-emdash-content-backup, verificationPass true,",
            "a prod-rollback-* (or legacy prod-backup-*) branch and workerTursoHost) and none was found.",
            "Run pwsh ./scripts/backup-production-emdash.ps1 -AllowProduction first, or run deploy-production-local.ps1 without -UseFreshTursoCheckpoint so it takes its own backup."
        ) -join " "
    }

    $script:DeployFreshBackupMetadata = $selection.Metadata
    Write-DeployStep "Using verified production backup $($selection.Metadata.backupDatabase) ($($selection.File.Name)); no second backup taken (-UseFreshTursoCheckpoint)"
}

function Test-DeployMigrateTargetMatchesBackupHost {
    <#
    .SYNOPSIS
      True when the libsql URL emdash migrate will use has the same host as the backed-up DB.
    #>
    param(
        [string]$BackupHost,
        [string]$MigrateUrl
    )

    $backup = ([string]$BackupHost).Trim().TrimEnd("/").ToLowerInvariant()
    $target = Get-DeployLibsqlHostname -Url $MigrateUrl
    if ([string]::IsNullOrWhiteSpace($backup) -or [string]::IsNullOrWhiteSpace($target)) {
        return $false
    }
    return $backup -eq $target
}

function Assert-DeployMigrateTargetMatchesBackupHost {
    <#
    .SYNOPSIS
      Fail closed before emdash migrate when the migrate target is not the DB that was backed up.

    .DESCRIPTION
      Only for -UseFreshTursoCheckpoint, where the backup ran in an earlier step with its own
      credential resolution. Call after Invoke-DeployWorkerBuild (which sets TURSO_DATABASE_URL via
      Set-TursoBuildEnv) and before Invoke-DeployEmdashCoreMigrate. Never prints tokens.
    #>
    if ($null -eq $script:DeployFreshBackupMetadata) {
        throw "Internal: Assert-DeployMigrateTargetMatchesBackupHost called without a selected backup (Assert-DeployFreshEmDashTursoBackup first)."
    }
    $backupHost = [string]$script:DeployFreshBackupMetadata.workerTursoHost
    $migrateUrl = [Environment]::GetEnvironmentVariable("TURSO_DATABASE_URL", "Process")
    $targetHost = Get-DeployLibsqlHostname -Url $migrateUrl
    if (-not (Test-DeployMigrateTargetMatchesBackupHost -BackupHost $backupHost -MigrateUrl $migrateUrl)) {
        throw @(
            "Refusing to migrate or deploy: the backed-up DB host '$backupHost' (backup $($script:DeployFreshBackupMetadata.backupDatabase))",
            "is not the emdash migrate target host '$targetHost'. Fix TURSO_PRODUCTION_EMDASH_DB_URL / _TOKEN so both point at the",
            "DB the production Worker uses (web/docs/DEPLOY.md § Standard path), then re-run. Nothing was migrated or deployed."
        ) -join " "
    }
    Write-DeployStep "Migrate target host matches the backed-up DB host ($targetHost)"
}
# ---------------------------------------------------------------------------------------------
# Live production Worker provenance (issue #142)
# ---------------------------------------------------------------------------------------------
# The production deploy backs up and migrates the DB named by TURSO_PRODUCTION_EMDASH_DB_URL.
# These functions prove the LIVE production Worker reads that same DB, using
# GET /api/deploy-provenance.json (web/src/lib/deploy-provenance.ts), which returns only
# sha256("freedomtimes-turso-host-v1:" + host) and the build commit: never the host or a token.

$script:DeployTursoHostHashDomain = "freedomtimes-turso-host-v1:"
$script:DeployProvenancePath = "/api/deploy-provenance.json"
$script:DeployVersionPath = "/api/version.json"
# Repo path of the route. A live commit whose tree has this file ships the endpoint (#144).
$script:DeployProvenanceRouteFile = "web/src/pages/api/deploy-provenance.json.ts"

function Get-DeployTursoHostProvenanceHash {
    <#
    .SYNOPSIS
      Lower-case hex SHA-256 of the domain-separated Turso host; "" for an empty host.
      Must equal tursoHostProvenanceHash() in web/src/lib/deploy-provenance.ts (shared test vector).
    #>
    param([string]$TursoHost)

    $normalized = ([string]$TursoHost).Trim().ToLowerInvariant()
    if ([string]::IsNullOrWhiteSpace($normalized)) {
        return ""
    }
    $bytes = [System.Text.Encoding]::UTF8.GetBytes("$($script:DeployTursoHostHashDomain)$normalized")
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        return ([System.BitConverter]::ToString($sha.ComputeHash($bytes)) -replace "-", "").ToLowerInvariant()
    }
    finally {
        $sha.Dispose()
    }
}

function Get-DeployProductionSiteOrigin {
    $origin = [Environment]::GetEnvironmentVariable("FT_PRODUCTION_SITE_ORIGIN", "Process")
    if ([string]::IsNullOrWhiteSpace($origin)) {
        $origin = "https://freedomtimes.news"
    }
    return $origin.Trim().TrimEnd("/")
}

function Resolve-DeployLiveWorkerProvenanceVerdict {
    <#
    .SYNOPSIS
      Pure decision for one provenance response. Outcome is one of:
        Match      live Worker host hash equals the expected host hash (PreBackup: the backup
                   source host, #148; PreDeploy/PostDeploy: the backed-up host)
        Mismatch   live Worker reads another DB (fail closed)
        BootstrapCandidate  PreBackup/PreDeploy 404. NOT a pass: Assert-DeployLiveWorkerTursoHostMatchesBackup
                   allows a bootstrap only with positive evidence that the live Worker
                   predates the endpoint (Resolve-DeployProvenanceBootstrapEvidence, #144)
        Retry      transient (network, 5xx; PostDeploy also 404 or old commit still serving)
        Fail       anything else (fail closed)
    #>
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet("PreBackup", "PreDeploy", "PostDeploy")]
        [string]$Phase,
        [int]$StatusCode,
        [string]$Body,
        [string]$ExpectedHash,
        [string]$ExpectedCommitSha
    )

    $verdict = { param($Outcome, $Message) [pscustomobject]@{ Outcome = $Outcome; Message = $Message } }
    $expectedLabel = if ($Phase -eq "PreBackup") { "backup source" } else { "backed-up" }

    if ([string]::IsNullOrWhiteSpace($ExpectedHash)) {
        if ($Phase -eq "PreBackup") {
            return (& $verdict "Fail" "The backup source has no Turso host, so there is nothing to compare the live Worker with.")
        }
        return (& $verdict "Fail" "The backup metadata has no workerTursoHost, so there is nothing to compare the live Worker with.")
    }
    if ($StatusCode -eq 404) {
        if ($Phase -ne "PostDeploy") {
            return (& $verdict "BootstrapCandidate" "The live production Worker returned 404 for $($script:DeployProvenancePath).")
        }
        return (& $verdict "Retry" "The deployed Worker still returns 404 for $($script:DeployProvenancePath).")
    }
    if ($StatusCode -eq 401 -or $StatusCode -eq 403) {
        return (& $verdict "Fail" "$($script:DeployProvenancePath) refused the request ($StatusCode). If the Worker has a DEPLOY_PROVENANCE_TOKEN secret, the GitHub secret DEPLOY_PROVENANCE_TOKEN must hold the same value.")
    }
    if ($StatusCode -eq 0 -or $StatusCode -ge 500) {
        return (& $verdict "Retry" "$($script:DeployProvenancePath) was unreachable or failed (status $StatusCode).")
    }
    if ($StatusCode -ne 200) {
        return (& $verdict "Fail" "$($script:DeployProvenancePath) returned unexpected status $StatusCode.")
    }

    try {
        $payload = $Body | ConvertFrom-Json -ErrorAction Stop
    }
    catch {
        return (& $verdict "Fail" "$($script:DeployProvenancePath) returned a body that is not JSON.")
    }
    if ($payload -isnot [pscustomobject]) {
        return (& $verdict "Fail" "$($script:DeployProvenancePath) returned JSON that is not an object.")
    }
    $props = $payload.PSObject.Properties

    $liveCommit = if ($props["commitSha"]) { [string]$payload.commitSha } else { "" }
    if ($Phase -eq "PostDeploy" -and -not [string]::IsNullOrWhiteSpace($ExpectedCommitSha) -and $liveCommit -ne $ExpectedCommitSha) {
        return (& $verdict "Retry" "The previous Worker version (commit '$liveCommit') is still serving; waiting for $ExpectedCommitSha.")
    }

    $liveHash = if ($props["tursoHostSha256"]) { ([string]$payload.tursoHostSha256).Trim().ToLowerInvariant() } else { "" }
    if ([string]::IsNullOrWhiteSpace($liveHash)) {
        return (& $verdict "Fail" "The live Worker reported no Turso host hash (no TURSO_DATABASE_URL Worker secret?).")
    }
    if ($liveHash -ne $ExpectedHash.Trim().ToLowerInvariant()) {
        $than = if ($Phase -eq "PreBackup") { "the backup source (TURSO_PRODUCTION_EMDASH_DB_URL / resolved Worker host)" } else { "the one backed up" }
        return (& $verdict "Mismatch" "The live production Worker reads a different Turso DB host than $than (host hash $($liveHash.Substring(0, [Math]::Min(12, $liveHash.Length)))… vs $expectedLabel $($ExpectedHash.Substring(0, [Math]::Min(12, $ExpectedHash.Length)))…).")
    }
    return (& $verdict "Match" "The live production Worker reads the $expectedLabel DB host (commit '$liveCommit').")
}

function Invoke-DeployProductionSiteGet {
    <#
    .SYNOPSIS
      GET one production-site path once (cache-busting nonce, no-cache). Returns @{ StatusCode; Body };
      StatusCode 0 on a network error. No redirects followed (a 3xx is returned as-is).
    #>
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [string]$BearerToken = ""
    )
    $uri = "$(Get-DeployProductionSiteOrigin)$($Path)?ci=$([guid]::NewGuid().ToString('N'))"
    $headers = @{ "Cache-Control" = "no-cache" }
    if (-not [string]::IsNullOrWhiteSpace($BearerToken)) {
        $headers["Authorization"] = "Bearer $($BearerToken.Trim())"
    }
    try {
        $response = Invoke-WebRequest -Uri $uri -Headers $headers -Method Get -MaximumRedirection 0 `
            -SkipHttpErrorCheck -TimeoutSec 20 -UseBasicParsing -ErrorAction Stop
        $body = if ($response.Content -is [byte[]]) { [System.Text.Encoding]::UTF8.GetString($response.Content) } else { [string]$response.Content }
        return [pscustomobject]@{ StatusCode = [int]$response.StatusCode; Body = $body }
    }
    catch {
        return [pscustomobject]@{ StatusCode = 0; Body = "" }
    }
}

function Invoke-DeployLiveWorkerProvenanceRequest {
    <#
    .SYNOPSIS
      GET the production provenance endpoint once. Sends DEPLOY_PROVENANCE_TOKEN as a bearer when set.
    #>
    $token = [Environment]::GetEnvironmentVariable("DEPLOY_PROVENANCE_TOKEN", "Process")
    return (Invoke-DeployProductionSiteGet -Path $script:DeployProvenancePath -BearerToken ([string]$token))
}

function Invoke-DeployLiveWorkerVersionRequest {
    <#
    .SYNOPSIS
      GET the production /api/version.json once (public; build commit only).
    #>
    return (Invoke-DeployProductionSiteGet -Path $script:DeployVersionPath)
}

function Get-DeployGitProvenanceEvidenceOps {
    <#
    .SYNOPSIS
      Git lookups used by Resolve-DeployProvenanceBootstrapEvidence, as injectable scriptblocks.
      Every lookup returns a value or throws; callers treat a throw as "no evidence" (fail closed).
    #>
    param([string]$RepoRoot = $script:DeployRepoRoot)

    if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
        $RepoRoot = Split-Path $PSScriptRoot -Parent
    }
    $root = $RepoRoot
    return @{
        IsShallow          = {
            $out = & git -C $root rev-parse --is-shallow-repository 2>$null
            if ($LASTEXITCODE -ne 0) { throw "git rev-parse --is-shallow-repository failed." }
            return ([string]$out).Trim() -eq "true"
        }.GetNewClosure()
        CommitExists       = {
            param([string]$Sha)
            & git -C $root cat-file -e "$Sha^{commit}" 2>$null
            return $LASTEXITCODE -eq 0
        }.GetNewClosure()
        TreeHasPath        = {
            param([string]$Sha, [string]$Path)
            & git -C $root cat-file -e "$($Sha):$Path" 2>$null
            return $LASTEXITCODE -eq 0
        }.GetNewClosure()
        IntroducingCommits = {
            param([string]$Path)
            $out = & git -C $root log --format=%H --diff-filter=A HEAD -- $Path 2>$null
            if ($LASTEXITCODE -ne 0) { throw "git log for $Path failed." }
            return @($out | ForEach-Object { ([string]$_).Trim() } | Where-Object { $_ -ne "" })
        }.GetNewClosure()
        IsAncestor         = {
            param([string]$Ancestor, [string]$Descendant)
            & git -C $root merge-base --is-ancestor $Ancestor $Descendant 2>$null
            switch ($LASTEXITCODE) {
                0 { return $true }
                1 { return $false }
                default { throw "git merge-base --is-ancestor failed (exit $LASTEXITCODE)." }
            }
        }.GetNewClosure()
    }
}

function Resolve-DeployProvenanceBootstrapEvidence {
    <#
    .SYNOPSIS
      Issue #144: is a pre-deploy 404 from /api/deploy-provenance.json the legitimate
      bootstrap (the live Worker predates the endpoint)? Returns @{ Allowed; LiveCommit; Message }.

    .DESCRIPTION
      Allowed only with positive evidence, all of:
        - /api/version.json answered 200 with a JSON object whose commitSha is a full 40-hex SHA;
        - this checkout has full history (not shallow) and contains that commit;
        - the live commit's tree does NOT contain the provenance route file;
        - no commit that added the route (git log --diff-filter=A on HEAD) is an ancestor of it
          (git merge-base --is-ancestor).
      Anything else (lookup failure, redirect, non-JSON, "unknown" commit, commit not in history,
      a live commit that already ships the endpoint, any git error) is Allowed = $false: the
      404 then fails the run closed.
    #>
    param(
        [int]$VersionStatusCode,
        [string]$VersionBody,
        [Parameter(Mandatory = $true)]
        [hashtable]$Git
    )

    $result = { param($Allowed, $LiveCommit, $Message) [pscustomobject]@{ Allowed = [bool]$Allowed; LiveCommit = $LiveCommit; Message = $Message } }
    $versionPath = $script:DeployVersionPath
    $route = $script:DeployProvenanceRouteFile

    if ($VersionStatusCode -ne 200) {
        $what = if ($VersionStatusCode -eq 0) { "was unreachable" } elseif ($VersionStatusCode -ge 300 -and $VersionStatusCode -lt 400) { "redirected ($VersionStatusCode)" } else { "returned status $VersionStatusCode" }
        return (& $result $false "" "Cannot prove the live Worker predates the endpoint: $versionPath $what.")
    }
    try {
        $payload = $VersionBody | ConvertFrom-Json -ErrorAction Stop
    }
    catch {
        return (& $result $false "" "Cannot prove the live Worker predates the endpoint: $versionPath is not JSON.")
    }
    if ($payload -isnot [pscustomobject]) {
        return (& $result $false "" "Cannot prove the live Worker predates the endpoint: $versionPath is not a JSON object.")
    }
    $live = if ($payload.PSObject.Properties["commitSha"]) { ([string]$payload.commitSha).Trim().ToLowerInvariant() } else { "" }
    if ($live -notmatch '^[0-9a-f]{40}$') {
        $shown = if ([string]::IsNullOrWhiteSpace($live)) { "missing" } else { "'$live'" }
        return (& $result $false "" "Cannot prove the live Worker predates the endpoint: its commit is $shown (needs a full SHA).")
    }

    try {
        if (& $Git.IsShallow) {
            return (& $result $false $live "Cannot check live commit $live against history: this checkout is shallow (CI needs actions/checkout fetch-depth: 0).")
        }
        if (-not (& $Git.CommitExists $live)) {
            return (& $result $false $live "Live commit $live is not in this checkout's history (unknown or unpushed build; run git fetch origin locally).")
        }
        if (& $Git.TreeHasPath $live $route) {
            return (& $result $false $live "Live commit $live already contains $route, yet the endpoint returns 404 (route regression, a build without the page, or a misrouted origin).")
        }
        $introducing = @(& $Git.IntroducingCommits $route)
        if ($introducing.Count -eq 0) {
            return (& $result $false $live "Cannot find the commit that added $route in this checkout's history.")
        }
        foreach ($commit in $introducing) {
            if (& $Git.IsAncestor $commit $live) {
                return (& $result $false $live "Live commit $live already includes $commit, which added the endpoint, yet the endpoint returns 404.")
            }
        }
        $first = $introducing[-1]
        return (& $result $true $live "Live commit $live predates the provenance endpoint (added in $first).")
    }
    catch {
        return (& $result $false $live "Cannot check live commit $live against git history: $($_.Exception.Message)")
    }
}

function Assert-DeployLiveWorkerTursoHostMatchesBackup {
    <#
    .SYNOPSIS
      Fail closed unless the live production Worker reads the expected DB host.

    .DESCRIPTION
      PreBackup (#148): in backup-production-emdash.ps1, before any Turso branch or export, against
      -ExpectedTursoHost (the resolved backup source host, i.e. TURSO_PRODUCTION_EMDASH_DB_URL on CI).
      Same rules as PreDeploy (404 = bootstrap only with #144 evidence); failures say nothing was
      backed up. Returns "Match" or "Bootstrap".
      PreDeploy: before build/migrate/deploy, against the selected backup's workerTursoHost. Mismatch, missing hash or any unexpected response
      throws (nothing migrated or deployed). A 404 is a bootstrap ONLY when
      Resolve-DeployProvenanceBootstrapEvidence proves the live Worker predates the endpoint
      (#144: its /api/version.json commit is known and does not contain the route); then a loud
      ::warning:: and the secret-vs-backup host assertion (Assert-DeployMigrateTargetMatchesBackupHost)
      is the only check for this one run. Without that proof the 404 fails closed.
      PostDeploy: right after wrangler deploy, against the NEW version (waits for its commit).
      Here 404 is a hard failure once retries run out: there is no bootstrap after deploy.
      -Fetch / -FetchVersion are injectable for tests; they must return @{ StatusCode; Body }.
      -GitOps is injectable for tests (shape: Get-DeployGitProvenanceEvidenceOps).
    #>
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet("PreBackup", "PreDeploy", "PostDeploy")]
        [string]$Phase,
        # PreBackup only: the Turso host the backup is about to read.
        [string]$ExpectedTursoHost = "",
        [scriptblock]$Fetch = { Invoke-DeployLiveWorkerProvenanceRequest },
        [scriptblock]$FetchVersion = { Invoke-DeployLiveWorkerVersionRequest },
        [hashtable]$GitOps = $null,
        [int]$MaxAttempts = 0,
        [int]$DelaySeconds = 5
    )

    $preBackup = $Phase -eq "PreBackup"
    if ($preBackup) {
        if ([string]::IsNullOrWhiteSpace($ExpectedTursoHost)) {
            throw "Refusing to back up (live Worker provenance, #148): no backup source host to compare with the live Worker. Nothing was backed up, migrated or deployed."
        }
    }
    elseif ($null -eq $script:DeployFreshBackupMetadata) {
        throw "Internal: Assert-DeployLiveWorkerTursoHostMatchesBackup called without a selected backup (Assert-DeployFreshEmDashTursoBackup first)."
    }
    if ($MaxAttempts -le 0) {
        $MaxAttempts = if ($Phase -eq "PostDeploy") { 24 } else { 4 }
    }
    $expectedHost = if ($preBackup) { $ExpectedTursoHost } else { [string]$script:DeployFreshBackupMetadata.workerTursoHost }
    $expectedHash = Get-DeployTursoHostProvenanceHash -TursoHost $expectedHost
    $expectedCommit = [Environment]::GetEnvironmentVariable("FT_BUILD_COMMIT_SHA", "Process")
    $backupName = if ($preBackup) { "" } else { [string]$script:DeployFreshBackupMetadata.backupDatabase }
    $nothingDone = if ($preBackup) { "Nothing was backed up, migrated or deployed." } else { "Nothing was migrated or deployed." }
    $failurePrefix = if ($preBackup) {
        "Refusing to back up (live Worker provenance, #148):"
    }
    elseif ($Phase -eq "PreDeploy") {
        "Refusing to migrate or deploy (live Worker provenance, #142):"
    }
    else {
        "Production deploy FAILED its post-deploy provenance check (#142): the new Worker is live and EmDash was migrated. Roll back per web/docs/DEPLOY.md § If the production job fails."
    }
    $fixHint = "Point TURSO_PRODUCTION_EMDASH_DB_URL / _TOKEN at the DB the production Worker uses (web/docs/DEPLOY.md § Standard path), then re-run."

    $summary = {
        param([string]$Line)
        if (-not [string]::IsNullOrWhiteSpace($env:GITHUB_STEP_SUMMARY)) {
            Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY -Value $Line -ErrorAction SilentlyContinue
        }
    }

    $last = $null
    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
        $response = & $Fetch
        $last = Resolve-DeployLiveWorkerProvenanceVerdict -Phase $Phase -StatusCode ([int]$response.StatusCode) `
            -Body ([string]$response.Body) -ExpectedHash $expectedHash -ExpectedCommitSha $expectedCommit
        switch ($last.Outcome) {
            "Match" {
                if ($preBackup) {
                    Write-Host "Live Worker provenance ($Phase): $($last.Message)" -ForegroundColor Green
                    & $summary "- Live Worker provenance ($Phase, #148): match (backup source Turso host hash = live Worker)"
                }
                else {
                    Write-DeployStep "Live Worker provenance ($Phase): $($last.Message) Backup $backupName."
                    & $summary "- Live Worker provenance ($Phase, #142): match (Turso host hash = backup ``$backupName``)"
                }
                return "Match"
            }
            "BootstrapCandidate" {
                # #144: a 404 is only the bootstrap with proof that the live Worker predates the endpoint.
                $ops = if ($null -ne $GitOps) { $GitOps } else { Get-DeployGitProvenanceEvidenceOps }
                $versionResponse = & $FetchVersion
                $evidence = Resolve-DeployProvenanceBootstrapEvidence -VersionStatusCode ([int]$versionResponse.StatusCode) `
                    -VersionBody ([string]$versionResponse.Body) -Git $ops
                if (-not $evidence.Allowed) {
                    throw "$failurePrefix $($last.Message) Not a provenance bootstrap (#144): $($evidence.Message) $nothingDone"
                }
                $message = if ($preBackup) {
                    "$($last.Message) $($evidence.Message) Bootstrap: the backup source cannot be proven live this run; the deploy step's checks still apply."
                }
                else {
                    "$($last.Message) $($evidence.Message) Bootstrap: this run relies on the secret-vs-backup host check only; the post-deploy check against the new Worker is mandatory."
                }
                $issue = if ($preBackup) { "#148" } else { "#142" }
                if ($env:GITHUB_ACTIONS -eq "true") {
                    Write-Host "::warning title=Live Worker provenance bootstrap ($issue)::$message"
                }
                Write-Warning $message
                if (-not $preBackup) {
                    $script:DeployLiveProvenanceBootstrap = $true
                }
                $summaryTail = if ($preBackup) {
                    "backup source not proven; the deploy step re-checks the live Worker before migrating"
                }
                else {
                    "secret-vs-backup host check only"
                }
                & $summary "- Live Worker provenance ($Phase, $issue): **bootstrap** (live commit ``$($evidence.LiveCommit)`` predates the endpoint; $summaryTail)"
                return "Bootstrap"
            }
            "Mismatch" {
                $tail = if ($Phase -ne "PostDeploy") { "$nothingDone $fixHint" } else { $fixHint }
                throw "$failurePrefix $($last.Message) $tail"
            }
            "Fail" {
                $tail = if ($Phase -ne "PostDeploy") { $nothingDone } else { "" }
                throw "$failurePrefix $($last.Message) $tail".Trim()
            }
            default {
                if ($attempt -lt $MaxAttempts -and $DelaySeconds -gt 0) {
                    Start-Sleep -Seconds $DelaySeconds
                }
            }
        }
    }
    $tail = if ($Phase -ne "PostDeploy") { $nothingDone } else { "" }
    throw "$failurePrefix gave up after $MaxAttempts attempts: $($last.Message) $tail".Trim()
}

function Write-DeployBackupSourceCaveats {
    <#
    .SYNOPSIS
      #148: how backup-production-emdash.ps1 reports resolver caveats (env fallback, proxy resolve
      failed, "named DB stale/thin", "source is the named production DB").
      LiveProvenance "match": the live Worker's host hash already proved the source, so the caveats
      collapse into ONE informational line (a ::notice:: on GitHub Actions). "bootstrap"/"skipped":
      nothing proved the source, so each caveat stays a warning, as before.
    #>
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet("match", "bootstrap", "skipped")]
        [string]$LiveProvenance,
        [string[]]$ResolverWarnings = @(),
        [string]$SourceDatabase = "",
        [string]$ResolveSource = ""
    )

    $caveats = [System.Collections.Generic.List[string]]::new()
    foreach ($w in @($ResolverWarnings)) {
        if (-not [string]::IsNullOrWhiteSpace($w)) { $caveats.Add([string]$w) }
    }
    if ($SourceDatabase -eq "freedomtimes-emdash-production") { # pragma: allowlist secret
        $caveats.Add("Source is the named production DB. Confirm Worker host is correct before treating this as the live corpus.")
    }

    if ($LiveProvenance -eq "match") {
        $line = "Backup source verified by live Worker provenance (#148): the live production Worker reads this DB host (resolved via $ResolveSource). $($caveats.Count) resolver caveat(s) superseded."
        if ($env:GITHUB_ACTIONS -eq "true") {
            Write-Host "::notice title=Backup source verified (#148)::$line"
        }
        else {
            Write-Host $line -ForegroundColor Green
        }
        return
    }
    foreach ($c in $caveats) {
        Write-Warning $c
    }
}

function Invoke-DeployStagingTursoExport {
    Assert-DeployTursoAuth

    $databaseName = Get-DeployTursoDatabaseNameFromEnv `
        -EnvKey "TF_VAR_TURSO_DATABASE_NAME_STAGING" `
        -DefaultName "freedomtimes-emdash-staging" # pragma: allowlist secret

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

function Invoke-DeployStagingTursoBranchBackup {
    <#
    .SYNOPSIS
      Staging backup as a Turso branch (staging-rollback-YYYYMMDD-HHMMSS; staging-backup-* before
      31 Oct 2026); writes no .db file.

    .DESCRIPTION
      Used by deploy-worker.yml through deploy-staging-local.ps1 -TursoBranchBackup: the repo is
      public, so CI never exports or uploads a database file. Restore = point the staging Worker at
      the branch, or copy it back with turso db create --from-db (web/docs/DEPLOY.md).
      The group is TF_VAR_TURSO_DATABASE_GROUP_STAGING when set, else the Turso org default group.
    #>
    Assert-DeployTursoAuth

    $databaseName = Get-DeployTursoDatabaseNameFromEnv `
        -EnvKey "TF_VAR_TURSO_DATABASE_NAME_STAGING" `
        -DefaultName "freedomtimes-emdash-staging" # pragma: allowlist secret
    $group = Get-DeployTursoDatabaseNameFromEnv -EnvKey "TF_VAR_TURSO_DATABASE_GROUP_STAGING" -DefaultName ""

    $stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMdd-HHmmss")
    $branchName = "staging-rollback-$stamp"
    Assert-TursoDatabaseHeadroom -RepoRoot (Split-Path $PSScriptRoot -Parent)
    Write-DeployStep "Creating staging EmDash backup branch '$branchName' from '$databaseName' (no .db export)"

    $createArgs = @("db", "create", $branchName, "--from-db", $databaseName)
    if (-not [string]::IsNullOrWhiteSpace($group)) {
        $createArgs += @("--group", $group)
    }
    $create = Invoke-DeployTursoCli -TursoArgs $createArgs
    if ($create.ExitCode -ne 0) {
        throw "Staging EmDash backup branch create failed (exit $($create.ExitCode)). Nothing migrated or deployed."
    }
    $script:DeployStagingBackupBranch = $branchName
    Write-Host "Staging EmDash backup branch: $branchName" -ForegroundColor Green
    if (-not [string]::IsNullOrWhiteSpace($env:GITHUB_STEP_SUMMARY)) {
        Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY -Value @(
            "### Staging EmDash backup",
            "- Turso branch: ``$branchName`` (from ``$databaseName``; no .db exported or uploaded)"
        )
    }
}

function Invoke-DeployEmDashTursoBackup {
    param(
        [switch]$SkipTursoBackup
    )

    if ($SkipTursoBackup) {
        Write-DeployStep "Skipping Turso EmDash backup (-SkipTursoBackup); not creating an export or rollback branch"
        return
    }

    if ($script:DeployIsStaging) {
        if ($script:DeployStagingBackupAsBranch) {
            Invoke-DeployStagingTursoBranchBackup
        }
        else {
            Invoke-DeployStagingTursoExport
        }
        return
    }

    Invoke-DeployTursoRollbackCheckpoint
}

function Ensure-DeployEmdashTargetFingerprintFromStatus {
    $existing = [Environment]::GetEnvironmentVariable("EMDASH_TARGET_FINGERPRINT", "Process")
    if (-not [string]::IsNullOrWhiteSpace($existing)) {
        Write-DeployStep "EMDASH_TARGET_FINGERPRINT already set in process env (not writing .env.dev)"
        return
    }

    Write-DeployStep "Pinning EMDASH_TARGET_FINGERPRINT from same-run emdash migrate --status --json (local deploy; not a Cursor secret)"
    Push-Location (Join-Path $script:DeployRepoRoot "web")
    $stderrFile = Join-Path ([IO.Path]::GetTempPath()) ("emdash-print-fingerprint-{0}.err" -f [guid]::NewGuid())
    try {
        $raw = & node (Join-Path "scripts" "emdash-core-migrate.mjs") print-fingerprint 2>$stderrFile
        $errText = ""
        if (Test-Path -LiteralPath $stderrFile) {
            $errText = ((Get-Content -LiteralPath $stderrFile -Raw -ErrorAction SilentlyContinue) ?? "").Trim()
        }
        if ($LASTEXITCODE -ne 0) {
            throw "emdash-core-migrate.mjs print-fingerprint failed (exit $LASTEXITCODE). $errText"
        }
        $fp = ([string]$raw).Trim()
        if ($fp -notmatch '^[0-9a-f]{64}$') {
            throw "print-fingerprint did not return a 64-character SHA-256 hex digest. $errText"
        }
        $env:EMDASH_TARGET_FINGERPRINT = $fp
        if (-not $script:DeployIsStaging) {
            $env:EMDASH_TARGET_FINGERPRINT_PRODUCTION = $fp
        }
        Write-Host "Pinned EMDASH_TARGET_FINGERPRINT from --status (process env only)." -ForegroundColor DarkGray
    }
    finally {
        Remove-Item -LiteralPath $stderrFile -Force -ErrorAction SilentlyContinue
        Pop-Location
    }
}

# ---------------------------------------------------------------------------------------------
# Staging EmDash token check (issue #140)
# ---------------------------------------------------------------------------------------------
# The staging resolver prefers the Terraform output turso_database_auth_token (CI parity). Before
# migrate, prove the selected token with a read-only `emdash-core-migrate.mjs print-fingerprint`
# (emdash migrate --status --json). Only a Terraform token that Turso rejects with an auth-class
# error falls back to the resolver's next candidate (process / .env.dev); anything else fails
# closed before migrate. Never prints token values.

function Get-DeployTursoAuthErrorClass {
    param([string]$Text)
    $t = [string]$Text
    if ($t -match '(?i)auth role not found') { return "auth-role-not-found" }
    if ($t -match '(?i)\b401\b|unauthori[sz]ed') { return "unauthorized" }
    if ($t -match '(?i)\b403\b|forbidden') { return "forbidden" }
    if ($t -match '(?i)\b404\b') { return "not-found" }
    if ($t -match '(?i)\bjwt\b|invalid token|token (is )?(expired|invalid)') { return "invalid-jwt" }
    return ""
}

function Hide-DeployTokenValues {
    param([string]$Text, [string[]]$Values)
    $out = [string]$Text
    foreach ($v in @($Values)) {
        $trimmed = ([string]$v).Trim()
        if ($trimmed.Length -ge 8) {
            $out = $out.Replace($trimmed, "[redacted]")
        }
    }
    return $out
}

function Invoke-DeployEmdashTokenProbe {
    param([scriptblock]$Probe)
    if ($null -ne $Probe) {
        return & $Probe
    }
    Push-Location (Join-Path $script:DeployRepoRoot "web")
    $outFile = Join-Path ([IO.Path]::GetTempPath()) ("emdash-token-probe-{0}.out" -f [guid]::NewGuid())
    $errFile = Join-Path ([IO.Path]::GetTempPath()) ("emdash-token-probe-{0}.err" -f [guid]::NewGuid())
    try {
        # Classify a non-zero exit instead of letting a caller's $true preference throw it (#140).
        $PSNativeCommandUseErrorActionPreference = $false
        & node (Join-Path "scripts" "emdash-core-migrate.mjs") print-fingerprint 1>$outFile 2>$errFile
        $code = $LASTEXITCODE
        $text = ((Get-Content -LiteralPath $errFile -Raw -ErrorAction SilentlyContinue) ?? "") + "`n" +
            ((Get-Content -LiteralPath $outFile -Raw -ErrorAction SilentlyContinue) ?? "")
        return [pscustomobject]@{ Ok = ($code -eq 0); Output = $text.Trim() }
    }
    finally {
        Remove-Item -LiteralPath $outFile, $errFile -Force -ErrorAction SilentlyContinue
        Pop-Location
    }
}

function Confirm-DeployStagingEmdashTursoToken {
    <#
    .SYNOPSIS
      Staging only: read-only check that Turso accepts the resolved EmDash token; fall back from a
      rejected Terraform-output token to the next resolver candidate (#140). -Probe is for tests.
    #>
    param([scriptblock]$Probe)

    if (-not $script:DeployIsStaging) {
        return
    }

    $binding = $script:DeployTursoTokenBinding
    $current = [Environment]::GetEnvironmentVariable("TURSO_AUTH_TOKEN", "Process")
    if ($null -eq $binding -or ([string]$binding.Value).Trim() -ne ([string]$current).Trim()) {
        # Token set outside Set-TursoBuildEnv: check it, but there is no known fallback.
        $binding = @{ Value = $current; Source = "TURSO_AUTH_TOKEN (process)"; Fallback = $null }
    }
    $fallback = $binding.Fallback
    $secretValues = @($binding.Value, $(if ($null -ne $fallback) { $fallback.Value } else { "" }))

    Write-DeployStep "Checking the staging EmDash Turso token from $($binding.Source) (read-only emdash migrate --status)"
    $first = Invoke-DeployEmdashTokenProbe -Probe $Probe
    if ($first.Ok) {
        return
    }

    $class = Get-DeployTursoAuthErrorClass -Text $first.Output
    $detail = Hide-DeployTokenValues -Text $first.Output -Values $secretValues
    $isTerraform = ([string]$binding.Source) -like "terraform output *"
    # A bare 404 (wrong TURSO_DATABASE_URL / deleted database) is not proof the token is stale.
    $isAuthRejection = -not [string]::IsNullOrEmpty($class) -and $class -ne "not-found"
    if (-not $isTerraform -or -not $isAuthRejection -or $null -eq $fallback) {
        $why = if (-not $isTerraform) { "the token is not the Terraform output" }
            elseif (-not $isAuthRejection) { "the error is not an auth rejection" }
            else { "there is no other staging token candidate (.env.dev TURSO_AUTH_TOKEN)" }
        $label = if ([string]::IsNullOrEmpty($class)) { "non-auth error" } else { $class }
        throw "The staging EmDash Turso token from $($binding.Source) failed a read-only emdash migrate --status ($label). No fallback: $why. Nothing was migrated. $detail"
    }

    $env:TURSO_AUTH_TOKEN = $fallback.Value
    $second = Invoke-DeployEmdashTokenProbe -Probe $Probe
    if (-not $second.Ok) {
        $env:TURSO_AUTH_TOKEN = $binding.Value
        $secondClass = Get-DeployTursoAuthErrorClass -Text $second.Output
        $secondDetail = Hide-DeployTokenValues -Text $second.Output -Values $secretValues
        throw "Turso rejected both staging EmDash tokens: $($binding.Source) ($class) and $($fallback.Source) ($(if ($secondClass) { $secondClass } else { 'non-auth error' })). Mint a staging token (AGENTS.md CA-21). Nothing was migrated. $secondDetail"
    }

    Write-Warning "Turso rejected the Terraform output turso_database_auth_token ($class). Using $($fallback.Source) for emdash migrate in this run. The Terraform token in state is stale: re-mint it with a reviewed staging Terraform apply using -replace=turso_database_token.emdash (AGENTS.md CA-21, #140)."
    $script:DeployTursoTokenBinding = @{ Value = $fallback.Value; Source = $fallback.Source; Fallback = $null }
}

function Invoke-DeployEmdashCoreMigrate {
    if ($script:DeploySkipTursoMutate) {
        Write-DeployStep "Skipping EmDash core migrate (-WorkerOnly -SkipTursoBackup); Worker hotfix does not touch Turso"
        return
    }

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

    # #140: a stale Terraform-output staging token must not beat a good .env.dev token.
    Confirm-DeployStagingEmdashTursoToken

    # Local deploy always pins process env from same-run --status (CI GitHub
    # secrets are not Cursor secrets). Production-looking hosts refuse apply
    # without a pin; staging is harmless if already covered by migrate.mjs.
    Ensure-DeployEmdashTargetFingerprintFromStatus

    Push-Location (Join-Path $script:DeployRepoRoot "web")
    try {
        & node (Join-Path "scripts" "emdash-core-migrate.mjs") apply
        if ($LASTEXITCODE -ne 0) {
            throw "EmDash core migrate apply failed (exit $LASTEXITCODE)."
        }
    }
    finally {
        Pop-Location
    }
}

function Invoke-DeployEmdashCoreMigrateCheck {
    if ($script:DeploySkipTursoMutate) {
        Write-DeployStep "Skipping EmDash core migrate --check (-WorkerOnly -SkipTursoBackup)"
        return
    }

    Write-DeployStep "Checking EmDash core migrations (npx emdash migrate --check)"

    Push-Location (Join-Path $script:DeployRepoRoot "web")
    try {
        & node (Join-Path "scripts" "emdash-core-migrate.mjs") check
        if ($LASTEXITCODE -ne 0) {
            throw "EmDash core migrate --check failed (exit $LASTEXITCODE)."
        }
    }
    finally {
        Pop-Location
    }
}

function Invoke-DeployTerraformApplyWithRecovery {
    # Before the apply: a failed or partial apply may already have re-uploaded the Worker script.
    $script:DeployTerraformApplyStarted = $true
    $lockRel = "infra/terraform/environments/$($script:DeployEnvironment)/.terraform.lock.hcl"
    $lockfileWasClean = $true
    Push-Location $script:DeployRepoRoot
    try {
        $status = & git status --porcelain -- $lockRel 2>$null
        $lockfileWasClean = [string]::IsNullOrWhiteSpace($status)
    }
    finally {
        Pop-Location
    }

    $script:DeployTerraformLockfileWasClean = $lockfileWasClean

    $terraformDir = Join-Path $script:DeployTerraformEnvDir ".terraform"
    if (-not (Test-Path -LiteralPath $terraformDir)) {
        Write-DeployStep "No .terraform for $($script:DeployEnvironment); running terraform init first"
        Invoke-DeployTerraformInit
    }

    Write-DeployStep "Applying $($script:DeployEnvironment) Terraform (attempt 1)"
    $arguments = @(
        "-File", $script:DeployTerraformRunScript,
        "-Environment", $script:DeployEnvironment,
        "-Operation", "apply",
        "-LoadEnvFiles",
        "-AutoApprove"
    )

    # terraform-run.ps1 defers its post-apply Worker settings check: this pipeline always runs
    # wrangler deploy later in the same run (after secret sync and migrate; the build already ran
    # before the apply, issue #116),
    # restoring the real bundle, placement and vars from wrangler.jsonc, and verifies after it.
    $previousWranglerFollows = $env:FT_WRANGLER_DEPLOY_FOLLOWS
    $env:FT_WRANGLER_DEPLOY_FOLLOWS = "1"
    try {
        $apply1 = Invoke-DeployChildPwsh -CaptureOutput -Arguments $arguments
        $apply1.Output | ForEach-Object { $_ }

        if ($apply1.ExitCode -ne 0) {
            $providersDir = Join-Path $script:DeployTerraformEnvDir ".terraform/providers"
            $pluginMismatch = Test-DeployTerraformPluginCacheMismatch -Output @($apply1.Output)
            $providersMissing = -not (Test-Path -LiteralPath $providersDir)
            if ($pluginMismatch -or $providersMissing) {
                Write-Warning "Terraform apply failed: provider plugin cache does not match the lockfile (or providers are missing). Running terraform init, then retrying apply once. Leave the lockfile dirty through this retry."
                Invoke-DeployTerraformInit
                Write-DeployStep "Applying $($script:DeployEnvironment) Terraform (attempt 2 after init)"
                $apply1 = Invoke-DeployChildPwsh -CaptureOutput -Arguments $arguments
                $apply1.Output | ForEach-Object { $_ }
            }
        }
    }
    finally {
        $env:FT_WRANGLER_DEPLOY_FOLLOWS = $previousWranglerFollows
    }

    if ($apply1.ExitCode -ne 0) {
        throw "Terraform apply failed (exit $($apply1.ExitCode))."
    }

    if ($apply1.Output -match "(?m)^Error:\s") {
        throw "Terraform apply reported errors in output despite exit code $($apply1.ExitCode)."
    }

    Write-DeployStep "Terraform apply succeeded"
}

function Complete-DeployTerraformLockfileRestore {
    if ($null -eq $script:DeployTerraformLockfileWasClean) {
        return
    }

    Restore-DeployTerraformLockfileIfCleanStart -LockfileWasClean $script:DeployTerraformLockfileWasClean
    $script:DeployTerraformLockfileWasClean = $null
}

function Write-DeployGithubCiNoiseNote {
    Write-Host "Standard Worker deploy path is GitHub Actions (.github/workflows/deploy-worker.yml: PR -> staging, merge to main -> production backup + deploy). This local script is the fallback (web/docs/DEPLOY.md)." -ForegroundColor DarkGray
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
        & node (Join-Path "scripts" "enforce-publish-only-collections.cjs")
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

function Test-DeployProductionWorkerSecretOverlayPresent {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot
    )
    Test-Path (Join-Path $RepoRoot ".env.production")
}

function Invoke-DeploySecretSync {
    if (-not $script:DeployIsStaging -and -not (Test-DeployProductionWorkerSecretOverlayPresent -RepoRoot $script:DeployRepoRoot)) {
        Write-Warning "CA-25: .env.production is missing. Skipping Cloudflare Worker secret sync (set-github-secrets.ps1 reads that file, not process EMDASH_AUTH_SECRET_PRODUCTION). Live Worker secrets stay as-is. Continue with wrangler deploy."
        return
    }

    Write-DeployStep "Syncing Cloudflare Worker secrets for $($script:DeployEnvironment)"
    Ensure-DeployCloudflareWranglerAuthFromEnv

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

function Get-DeployWebInstallMismatches {
    param(
        [Parameter(Mandatory = $true)]
        [string]$WebDir
    )

    $packagePath = Join-Path $WebDir "package.json"
    $lockPath = Join-Path $WebDir "package-lock.json"
    if (-not (Test-Path -LiteralPath $packagePath) -or -not (Test-Path -LiteralPath $lockPath)) {
        throw "Refusing to build. Missing package.json or package-lock.json under $WebDir."
    }

    $packageJson = Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json
    # package-lock.json packages[""] is the root entry. ConvertFrom-Json rejects that key unless -AsHashtable.
    $lockJson = Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json -AsHashtable
    $names = New-Object System.Collections.Generic.List[string]
    foreach ($section in @("dependencies", "devDependencies")) {
        $block = $packageJson.PSObject.Properties[$section]
        if ($null -eq $block -or $null -eq $block.Value) {
            continue
        }
        foreach ($prop in @($block.Value.PSObject.Properties)) {
            if (-not $names.Contains($prop.Name)) {
                [void]$names.Add($prop.Name)
            }
        }
    }

    $mismatches = New-Object System.Collections.Generic.List[object]
    foreach ($name in $names) {
        $lockedVersion = ""
        $packages = $lockJson["packages"]
        $lockKey = "node_modules/$name"
        if ($null -ne $packages -and $packages.Contains($lockKey)) {
            $lockedNode = $packages[$lockKey]
            if ($null -ne $lockedNode -and $lockedNode.Contains("version")) {
                $lockedVersion = [string]$lockedNode["version"]
            }
        }

        $installedPath = Join-Path $WebDir "node_modules/$name/package.json"
        $installedVersion = ""
        $installed = Test-Path -LiteralPath $installedPath
        if ($installed) {
            $installedJson = Get-Content -LiteralPath $installedPath -Raw | ConvertFrom-Json
            $installedVersion = [string]$installedJson.version
        }

        if (-not $installed -or [string]::IsNullOrWhiteSpace($lockedVersion) -or $installedVersion -ne $lockedVersion) {
            $mismatches.Add([pscustomobject]@{
                Name      = $name
                Installed = $(if ($installed) { $installedVersion } else { "(not installed)" })
                Lockfile  = $(if (-not [string]::IsNullOrWhiteSpace($lockedVersion)) { $lockedVersion } else { "(not in lockfile)" })
            }) | Out-Null
        }
    }

    return @($mismatches.ToArray())
}

function Assert-DeployInstalledPackagesMatchLockfile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$WebDir
    )

    foreach ($name in @("emdash", "@emdash-cms/cloudflare", "@emdash-cms/plugin-embeds")) {
        $installedPath = Join-Path $WebDir "node_modules/$name/package.json"
        if (Test-Path -LiteralPath $installedPath) {
            $installedVersion = [string](Get-Content -LiteralPath $installedPath -Raw | ConvertFrom-Json).version
            Write-Host "Installed $name $installedVersion"
        }
        else {
            Write-Host "Installed $name MISSING"
        }
    }

    $mismatches = @(Get-DeployWebInstallMismatches -WebDir $WebDir)
    if ($mismatches.Count -eq 0) {
        Write-Host "web/node_modules matches web/package-lock.json"
        return
    }

    $lines = foreach ($mismatch in $mismatches) {
        "  $($mismatch.Name): installed $($mismatch.Installed), lockfile $($mismatch.Lockfile)"
    }
    throw (@(
        "Refusing to build. web/node_modules does not match web/package-lock.json.",
        ($lines -join [Environment]::NewLine),
        "Run 'npm ci' in web/ and deploy again.",
        "A stale install still produces a Worker deploy that exits 0. Production 2026-10-04 shipped EmDash 1.0.1 while the lockfile required 1.1.0."
    ) -join [Environment]::NewLine)
}

function Invoke-DeployWorkerBuild {
    param(
        [switch]$WorkerOnly,
        [switch]$WorkersOnly
    )

    # #168: no version bump here. Set-BuildProvenanceEnv stamps FT_BUILD_VERSION from the
    # web/package.json base (scripts/build-provenance-env.ps1); nothing is written back.
    Write-DeployStep "Checking web/node_modules against package-lock.json before build"
    Assert-DeployInstalledPackagesMatchLockfile -WebDir (Join-Path $script:DeployRepoRoot "web")

    Write-DeployStep "Building $($script:DeployEnvironment) Worker"

    # Core migrate needs a real Turso URL in .emdash/migrations.json. Always
    # resolve credentials (Terraform outputs or .env.dev) — including -WorkerOnly.
    . "$script:DeployCommonScriptRoot/resolve-turso-build-credentials.ps1"
    $script:DeployTursoTokenBinding = (Set-TursoBuildEnv -Environment $script:DeployEnvironment -RepoRoot $script:DeployRepoRoot).Token
    Assert-DeployRequiredBuildEnv
    # #116: the build runs before the Terraform apply; Sync-DeployTursoBuildEnvAfterTerraform
    # compares this URL with the one resolved after the apply.
    $script:DeployWebBuildTursoUrl = $env:TURSO_DATABASE_URL

    . "$script:DeployCommonScriptRoot/build-provenance-env.ps1"
    $null = Set-BuildProvenanceEnv -RepoRoot $script:DeployRepoRoot -Environment $script:DeployEnvironment

    $script:DeployWebBuildStartedAt = Get-Date

    Push-Location (Join-Path $script:DeployRepoRoot "web")
    try {
        $previousNativeErrorAction = $null
        $nativeErrorActionSet = Get-Variable -Name PSNativeCommandUseErrorActionPreference -Scope Global -ErrorAction SilentlyContinue
        if ($null -ne $nativeErrorActionSet) {
            $previousNativeErrorAction = $PSNativeCommandUseErrorActionPreference
            $PSNativeCommandUseErrorActionPreference = $false
        }
        try {
            & npm run build
            $npmExit = $LASTEXITCODE
        }
        finally {
            if ($null -ne $nativeErrorActionSet) {
                $PSNativeCommandUseErrorActionPreference = $previousNativeErrorAction
            }
        }
        if ($npmExit -ne 0) {
            throw "WORKER BUILD FAILED (npm exit $npmExit). The Worker was not deployed. The npm error is above this line."
        }
    }
    finally {
        Pop-Location
    }
}

# Issue #116: deploy-*-local.ps1 build the Worker BEFORE the Terraform apply, so the live Worker
# runs Terraform's single-module re-upload only for Auth0 sync, secret sync and migrate, not the
# minutes of npm run build. Call right after Invoke-DeployTerraformApplyWithRecovery. It resolves
# the Turso build credentials again (a token Terraform rotated reaches emdash migrate) and fails
# closed if the EmDash DB URL changed, because the bundle and .emdash/migrations.json were built
# against the old one. Never prints tokens. -Resolve is for tests (sets TURSO_* in the process).
function Sync-DeployTursoBuildEnvAfterTerraform {
    param([scriptblock]$Resolve)
    $builtUrl = [string]$script:DeployWebBuildTursoUrl
    if ([string]::IsNullOrWhiteSpace($builtUrl)) {
        throw "Internal: Sync-DeployTursoBuildEnvAfterTerraform called before Invoke-DeployWorkerBuild."
    }
    if ($null -eq $Resolve) {
        . "$script:DeployCommonScriptRoot/resolve-turso-build-credentials.ps1"
        $script:DeployTursoTokenBinding = (Set-TursoBuildEnv -Environment $script:DeployEnvironment -RepoRoot $script:DeployRepoRoot).Token
    }
    else {
        $null = & $Resolve
    }
    Assert-DeployRequiredBuildEnv
    $currentUrl = [string]$env:TURSO_DATABASE_URL
    if (-not (Test-TursoLibsqlUrlsEqual -Left $builtUrl -Right $currentUrl)) {
        throw @(
            "The Terraform apply changed the $($script:DeployEnvironment) EmDash Turso DB URL after the Worker was built",
            "(built for host '$(Get-DeployLibsqlHostname -Url $builtUrl)', now '$(Get-DeployLibsqlHostname -Url $currentUrl)').",
            "Nothing was migrated or deployed. Re-run the deploy so the build uses the new URL (issue #116)."
        ) -join " "
    }
    Write-DeployStep "Turso build credentials re-resolved after Terraform apply; the EmDash DB URL is unchanged"
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
        $script:DeployWorkerDeployCompleted = $true
    }
    finally {
        Pop-Location
    }
    Invoke-DeployWorkerSettingsVerification
}

# Read-only: live Worker placement region, PAGE_CACHE / SITE_ACCESS_MODE vars, ASSETS binding and
# last_deployed_from must match web/wrangler.jsonc, and the env's own origin must serve /favicon.svg
# logged out and not 5xx an unmatched route (the cf-placement header is no longer emitted).
# After a wrangler deploy a mismatch fails the deploy; "could not verify" (exit 2) only warns,
# because Wrangler itself just uploaded the settings from wrangler.jsonc.
function Invoke-DeployWorkerSettingsVerification {
    Write-DeployStep "Verifying $($script:DeployEnvironment) Worker placement and vars (Cloudflare API)"
    $code = Invoke-WorkerSettingsVerifier -RepoRoot $script:DeployRepoRoot -Environment $script:DeployEnvironment
    if ($code -eq 1) {
        throw "Live Worker settings do not match web/wrangler.jsonc after wrangler deploy (see FAIL lines above)."
    }
    if ($code -ne 0) {
        Write-Warning "Could not verify Worker placement/vars (exit $code). Run manually: node web/scripts/verify-worker-placement.mjs --env $($script:DeployEnvironment)"
    }
}

# For the deploy scripts' finally blocks. If Terraform apply started but wrangler deploy did not
# complete (build, migrate, secret sync or Auth0 assert threw in between, or the apply itself
# failed), the live Worker may be the Terraform re-upload (NON_TERRAFORM_RESOURCES.md § Wrangler-owned
# Worker settings). Print a loud warning with the redeploy command and run the verifier. Never throws.
function Write-DeployIncompleteAfterTerraformWarning {
    if (-not $script:DeployTerraformApplyStarted -or $script:DeployWorkerDeployCompleted) { return }
    try {
        $hint = Get-WorkerSettingsRedeployHint -Environment $script:DeployEnvironment
        Write-Host ""
        Write-Host "WARNING: Terraform apply ran for $($script:DeployEnvironment) but wrangler deploy did not complete." -ForegroundColor Red
        Write-Host "The live Worker may be Terraform's single-module re-upload, not the Wrangler build. Once the error above is fixed, redeploy now:" -ForegroundColor Red
        Write-Host "  $hint" -ForegroundColor Red
        Write-Host "Checking the live Worker (non-fatal):" -ForegroundColor Red
        $code = Invoke-WorkerSettingsVerifier -RepoRoot $script:DeployRepoRoot -Environment $script:DeployEnvironment
        if ($code -ne 0) {
            Write-Host "Live Worker check exit $code (1 = settings differ, 2 = could not verify). Redeploy: $hint" -ForegroundColor Red
        }
    }
    catch {
        Write-Host "WARNING: could not run the live Worker check ($($_.Exception.Message)). Redeploy: $(Get-WorkerSettingsRedeployHint -Environment $script:DeployEnvironment)" -ForegroundColor Red
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
