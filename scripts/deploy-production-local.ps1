[CmdletBinding()]
param(
    [switch]$WorkerOnly,
    [switch]$BumpVersion,
    [switch]$SkipVersionBump,
    [switch]$SyncCloudflareWorkerSecrets,
    [switch]$AllowProduction,
    [switch]$SkipTursoBackup,
    [switch]$DryRun
)

<#
.SYNOPSIS
  Full production deploy (Terraform + secrets + worker) or worker-only build/deploy.

.DESCRIPTION
  Full deploy (default): Turso rollback checkpoint, Terraform apply, Auth0
  .env.dev sync, secret sync, build, emdash migrate, wrangler deploy,
  emdash migrate --check, post-deploy secret verify.

  -WorkerOnly: skip Terraform; still backup + migrate + deploy the web worker
  unless -SkipTursoBackup. Resolves Turso credentials for core migrate (runtime
  still uses Cloudflare TURSO_* secrets). Requires -AllowProduction when using
  -WorkerOnly.

  -DryRun: skip backup, migrate, build, and deploy. Verifies the live Worker
  has the required secret *names* (including TURSO_*) via wrangler secret list.

  Version bump default: no bump unless -BumpVersion (production ships the version staging already bumped).

  Turso rollback checkpoint runs before migrate for full deploy and -WorkerOnly
  (WSL Turso on Windows; native turso on Linux) unless -SkipTursoBackup.
  -SkipTursoBackup skips the export/rollback branch with no 24h-checkpoint
  requirement. Combined with -WorkerOnly it also skips emdash migrate
  apply/check (Worker hotfix; no Turso mutate). Skipped for -DryRun.

.EXAMPLE
  pwsh ./scripts/deploy-production-local.ps1

.EXAMPLE
  pwsh ./scripts/deploy-production-local.ps1 -SkipTursoBackup

.EXAMPLE
  pwsh ./scripts/deploy-production-local.ps1 -WorkerOnly -AllowProduction -SkipTursoBackup

.EXAMPLE
  pwsh ./scripts/deploy-production-local.ps1 -WorkerOnly -AllowProduction -DryRun
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ($WorkerOnly -and -not $AllowProduction) {
    throw "Refusing production worker deploy without -AllowProduction."
}

if ($BumpVersion -and $SkipVersionBump) {
    throw "Cannot combine -BumpVersion and -SkipVersionBump."
}

. "$PSScriptRoot/Deploy-EnvironmentCommon.ps1"
Initialize-DeployEnvironment -Environment production
Set-DeploySkipTursoMutate -SkipTursoBackup:$SkipTursoBackup -WorkerOnly:$WorkerOnly

$workflowLabel = if ($WorkerOnly) { "worker deploy" } else { "full deploy" }
Write-DeployStep "Starting local production $workflowLabel"

Invoke-DeployPushSecretsPreflight

if (-not $DryRun) {
    Invoke-DeployEmDashTursoBackup -SkipTursoBackup:$SkipTursoBackup
}

if (-not $WorkerOnly) {
    Invoke-DeployTerraformApplyWithRecovery
}

try {
    if (-not $WorkerOnly) {
        Sync-DeployProductionAuth0EnvFromTerraform
        Assert-DeployAuth0SyncToEnv
        Invoke-DeploySecretSync
    }
    elseif ($SyncCloudflareWorkerSecrets) {
        Invoke-DeploySecretSync
    }

    if ($DryRun) {
        Write-DeployStep "Dry run — verifying live Worker secrets (no build or deploy)"
        Invoke-DeployWorkerSecretVerification
        Write-DeployStep "Dry run complete — skipping build and deploy"
        Write-Host "Worker name (display): $(Get-DeployWorkerName -WorkerOnly:$WorkerOnly)" -ForegroundColor Green
        exit 0
    }

    Invoke-DeployWorkerBuild -WorkerOnly:$WorkerOnly -BumpVersion:$BumpVersion -SkipVersionBump:$SkipVersionBump
    Invoke-DeployEmdashCoreMigrate
    Invoke-DeployWorkerDeploy
    Invoke-DeployEmdashCoreMigrateCheck
    Invoke-DeployWorkerSecretVerification

    Write-DeployStep "Production deploy complete"
    Write-Host "Worker: $(Get-DeployWorkerName -WorkerOnly:$WorkerOnly)" -ForegroundColor Green
    Write-DeployGithubCiNoiseNote
    # Native helpers can leave LASTEXITCODE non-zero after a successful wrangler
    # deploy; exit here so a throw above does not fall through to a forced 0.
    exit 0
}
finally {
    Complete-DeployTerraformLockfileRestore
}
