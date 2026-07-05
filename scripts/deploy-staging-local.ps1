[CmdletBinding()]
param(
    [switch]$WorkerOnly,
    [switch]$WorkersOnly,
    [switch]$SkipVersionBump,
    [switch]$SyncCloudflareWorkerSecrets
)

<#
.SYNOPSIS
  Full staging deploy (Terraform + secrets + worker), web-only, or web + scheduler without Terraform.

.DESCRIPTION
  Full deploy (default): Terraform apply, Auth0 verify, publish-only collections,
  secret sync, build, wrangler deploy, post-deploy secret verify.

  -WorkerOnly: skip Terraform and infra steps; build and deploy the web worker only.
  Turso build creds read from Terraform outputs. Pass -SyncCloudflareWorkerSecrets to
  re-sync Cloudflare secrets first.

  -WorkersOnly: skip Terraform; load Turso build creds from .env.dev only; build and
  deploy web + scheduler workers (freedomtimes-staging, freedomtimes-scheduler-staging).
  Pass -SyncCloudflareWorkerSecrets to re-sync Cloudflare secrets first.

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

if ($WorkersOnly) {
    Write-DeployStep "Loading .env.dev for Turso build credentials"
    Import-DeployEnvFile
    Assert-DeployRequiredBuildEnv
    Ensure-DeployCloudflareAccountIdFromEnv
}

if (-not $skipTerraform) {
    Invoke-DeployTerraformApplyWithRecovery
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
    $webDistDir = Join-Path $script:DeployRepoRoot "web\dist"
    Assert-DeployFreshWebBuild -DistDir $webDistDir -BuildStartedAt $script:DeployWebBuildStartedAt
    $webVarArgs = Get-DeployStagingWebWranglerVarArgs
    Invoke-DeployWorkerDeploy -WranglerVarArgs $webVarArgs
    Invoke-DeploySchedulerWorkerDeploy

    Write-DeployStep "Staging deploy complete"
    Write-Host "Web worker:    freedomtimes-staging" -ForegroundColor Green
    Write-Host "Scheduler:     freedomtimes-scheduler-staging" -ForegroundColor Green
    Write-Host "Staging site:  https://staging.freedomtimes.news" -ForegroundColor Green
}
else {
    Invoke-DeployWorkerDeploy
    Invoke-DeployWorkerSecretVerification

    Write-DeployStep "Staging deploy complete"
    Write-Host "Worker: $(Get-DeployWorkerName -WorkerOnly:$WorkerOnly)" -ForegroundColor Green
}
