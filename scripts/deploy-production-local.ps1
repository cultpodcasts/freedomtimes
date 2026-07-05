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
  Full deploy (default): Terraform apply, Auth0 .env.dev sync, secret sync,
  build, wrangler deploy, post-deploy secret verify.

  -WorkerOnly: skip Terraform; resolve Turso build creds from Terraform outputs or .env.dev.
  Requires -AllowProduction when using -WorkerOnly.

  Version bump default: no bump unless -BumpVersion (production ships the version staging already bumped).

  Full deploy creates a Turso rollback checkpoint before Terraform apply (WSL Turso CLI).
  Skipped for -WorkerOnly, -DryRun, or -SkipTursoBackup.

.EXAMPLE
  pwsh ./scripts/deploy-production-local.ps1

.EXAMPLE
  pwsh ./scripts/deploy-production-local.ps1 -SkipTursoBackup

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

$workflowLabel = if ($WorkerOnly) { "worker deploy" } else { "full deploy" }
Write-DeployStep "Starting local production $workflowLabel"

Invoke-DeployPushSecretsPreflight

if (-not $WorkerOnly) {
    if (-not $DryRun) {
        Invoke-DeployTursoRollbackCheckpoint -SkipTursoBackup:$SkipTursoBackup
    }
    Invoke-DeployTerraformApplyWithRecovery
    Sync-DeployProductionAuth0EnvFromTerraform
    Assert-DeployAuth0SyncToEnv
    Invoke-DeploySecretSync
}
elseif ($SyncCloudflareWorkerSecrets) {
    Invoke-DeploySecretSync
}

if ($DryRun) {
    Write-DeployStep "Dry run complete — skipping build and deploy"
    Write-Host "Worker name (display): $(Get-DeployWorkerName -WorkerOnly:$WorkerOnly)" -ForegroundColor Green
    return
}

Invoke-DeployWorkerBuild -WorkerOnly:$WorkerOnly -BumpVersion:$BumpVersion -SkipVersionBump:$SkipVersionBump
Invoke-DeployWorkerDeploy
Invoke-DeployWorkerSecretVerification

Write-DeployStep "Production deploy complete"
Write-Host "Worker: $(Get-DeployWorkerName -WorkerOnly:$WorkerOnly)" -ForegroundColor Green
