[CmdletBinding()]
param(
    [switch]$WorkerOnly,
    [switch]$WorkersOnly,
    [switch]$SkipVersionBump,
    [switch]$SyncCloudflareWorkerSecrets,
    [switch]$SkipTursoBackup
)

<#
.SYNOPSIS
  Full staging deploy (Terraform + secrets + worker), web-only, or web + scheduler without Terraform.

.DESCRIPTION
  Full deploy (default): Terraform apply, Auth0 verify, publish-only collections,
  secret sync, Turso EmDash export, build, emdash migrate, wrangler deploy,
  emdash migrate --check, post-deploy secret verify.

  -WorkerOnly: skip Terraform and infra steps; still backup + migrate + deploy
  the web worker. Resolves Turso credentials for core migrate (runtime still uses
  Cloudflare TURSO_* secrets). Pass -SyncCloudflareWorkerSecrets to re-sync
  Cloudflare secrets first.

  -WorkersOnly: skip Terraform; same backup -> migrate -> deploy -> check for web,
  then deploy the scheduler worker.

  -SkipTursoBackup: skip the staging export only when a fresh (<24h) export
  already exists under .release/backups/.

  -WorkerOnly and -WorkersOnly are mutually exclusive.

.EXAMPLE
  pwsh ./scripts/deploy-staging-local.ps1

.EXAMPLE
  pwsh ./scripts/deploy-staging-local.ps1 -WorkerOnly -SkipVersionBump

.EXAMPLE
  pwsh ./scripts/deploy-staging-local.ps1 -WorkersOnly -SyncCloudflareWorkerSecrets
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ($WorkerOnly -and $WorkersOnly) {
    throw "Pass -WorkerOnly or -WorkersOnly, not both."
}

. "$PSScriptRoot/Deploy-EnvironmentCommon.ps1"
Initialize-DeployEnvironment -Environment staging

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

if (-not $skipTerraform) {
    Invoke-DeployTerraformApplyWithRecovery
}

try {
    if (-not $skipTerraform) {
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

    Invoke-DeployWorkerBuild -WorkerOnly:$WorkerOnly -WorkersOnly:$WorkersOnly -SkipVersionBump:$SkipVersionBump

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
    Complete-DeployTerraformLockfileRestore
}

