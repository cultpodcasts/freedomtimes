[CmdletBinding()]
param(
    [switch]$WorkerOnly,
    [switch]$WorkersOnly,
    [switch]$SkipVersionBump,
    [switch]$SyncCloudflareWorkerSecrets,
    [switch]$SkipTursoBackup,
    [switch]$TursoBranchBackup
)

<#
.SYNOPSIS
  Full staging deploy (Terraform + secrets + worker), web-only, or web + scheduler without Terraform.

.DESCRIPTION
  Full deploy (default): Turso EmDash export, build, Terraform apply, Auth0 verify,
  publish-only collections, secret sync, emdash migrate, wrangler deploy,
  emdash migrate --check, post-deploy secret verify.

  -WorkerOnly: skip Terraform and infra steps; still backup + migrate + deploy
  the web worker unless -SkipTursoBackup. Resolves Turso credentials for core
  migrate (runtime still uses Cloudflare TURSO_* secrets). Pass
  -SyncCloudflareWorkerSecrets to re-sync Cloudflare secrets first.

  -WorkersOnly: skip Terraform; same backup -> migrate -> deploy -> check for web,
  then deploy the scheduler worker (unless -SkipTursoBackup, which skips backup
  and migrate).

  -SkipTursoBackup: skip the staging Turso export. With -WorkerOnly / -WorkersOnly
  also skip emdash migrate apply/check (Worker hotfix; no Turso mutate).

  -TursoBranchBackup: take the pre-migrate staging backup as a Turso branch
  (staging-backup-YYYYMMDD-HHMMSS) instead of a .db export. Used by
  .github/workflows/deploy-worker.yml: the repo is public, so CI never writes or
  uploads a database file. Cannot combine with -SkipTursoBackup.

  -WorkerOnly and -WorkersOnly are mutually exclusive.

.EXAMPLE
  pwsh ./scripts/deploy-staging-local.ps1

.EXAMPLE
  pwsh ./scripts/deploy-staging-local.ps1 -WorkerOnly -SkipVersionBump -SkipTursoBackup

.EXAMPLE
  pwsh ./scripts/deploy-staging-local.ps1 -WorkersOnly -SyncCloudflareWorkerSecrets
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ($WorkerOnly -and $WorkersOnly) {
    throw "Pass -WorkerOnly or -WorkersOnly, not both."
}

if ($TursoBranchBackup -and $SkipTursoBackup) {
    throw "Cannot combine -TursoBranchBackup and -SkipTursoBackup."
}

. "$PSScriptRoot/Deploy-EnvironmentCommon.ps1"
Initialize-DeployEnvironment -Environment staging
Set-DeploySkipTursoMutate -SkipTursoBackup:$SkipTursoBackup -WorkerOnly:$WorkerOnly -WorkersOnly:$WorkersOnly
$script:DeployStagingBackupAsBranch = [bool]$TursoBranchBackup

$skipTerraform = $WorkerOnly -or $WorkersOnly
$workflowLabel = if ($WorkersOnly) { "workers deploy" } elseif ($WorkerOnly) { "worker deploy" } else { "full deploy" }
Write-DeployStep "Starting local staging $workflowLabel"

Invoke-DeployPushSecretsPreflight
Invoke-DeployEmDashTursoBackup -SkipTursoBackup:$SkipTursoBackup

if ($WorkersOnly) {
    Write-DeployStep "Loading .env.dev for Turso build credentials"
    Import-DeployEnvFile
    Assert-DeployRequiredBuildEnv
    Ensure-DeployCloudflareAccountIdFromEnv
}

try {
    # #116: build (and its checks) BEFORE the Terraform apply. The apply re-uploads Terraform's
    # single-module Worker script, which stays live until wrangler deploy below; building first
    # keeps that window to Auth0 checks, publish-only enforcement, secret sync and migrate.
    Invoke-DeployWorkerBuild -WorkerOnly:$WorkerOnly -WorkersOnly:$WorkersOnly -SkipVersionBump:$SkipVersionBump

    if (-not $skipTerraform) {
        Invoke-DeployTerraformApplyWithRecovery
        Sync-DeployTursoBuildEnvAfterTerraform
        Assert-DeployAuth0SyncToEnv
        Invoke-DeployEnforceStagingPublishOnlyCollections
        Invoke-DeploySecretSync
    }
    elseif ($SyncCloudflareWorkerSecrets) {
        if (-not $WorkersOnly) {
            Ensure-DeployCloudflareAccountIdFromEnv
        }
        Invoke-DeploySecretSync
    }

    if ($WorkersOnly) {
        $webDistDir = Join-Path $script:DeployRepoRoot "web" "dist"
        Assert-DeployFreshWebBuild -DistDir $webDistDir -BuildStartedAt $script:DeployWebBuildStartedAt
        $webVarArgs = Get-DeployStagingWebWranglerVarArgs
        Invoke-DeployEmdashCoreMigrate
        Invoke-DeployWorkerDeploy -WranglerVarArgs $webVarArgs
        Invoke-DeployEmdashCoreMigrateCheck
        Invoke-DeploySchedulerWorkerDeploy

        Write-DeployStep "Staging deploy complete"
        Write-Host "Web worker:    $(Get-DeployWorkerName -WorkerOnly:$true)" -ForegroundColor Green
        Write-Host "Scheduler:     deployed (staging env)" -ForegroundColor Green
        Write-DeployGithubCiNoiseNote
    }
    else {
        Invoke-DeployEmdashCoreMigrate
        Invoke-DeployWorkerDeploy
        Invoke-DeployEmdashCoreMigrateCheck
        Invoke-DeployWorkerSecretVerification

        Write-DeployStep "Staging deploy complete"
        Write-Host "Worker: $(Get-DeployWorkerName -WorkerOnly:$WorkerOnly)" -ForegroundColor Green
        Write-DeployGithubCiNoiseNote
    }
}
finally {
    # Terraform applied but wrangler deploy did not finish: loud redeploy warning + live check.
    Write-DeployIncompleteAfterTerraformWarning
    Complete-DeployTerraformLockfileRestore
}

