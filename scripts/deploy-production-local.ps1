[CmdletBinding()]
param(
    [switch]$WorkerOnly,
    [switch]$SyncCloudflareWorkerSecrets,
    [switch]$AllowProduction,
    [switch]$SkipTursoBackup,
    [switch]$UseFreshTursoCheckpoint,
    [switch]$DryRun
)

<#
.SYNOPSIS
  Full production deploy (Terraform + secrets + worker) or worker-only build/deploy.

.DESCRIPTION
  Full deploy (default): Turso rollback checkpoint, build, Terraform apply, Auth0
  .env.dev sync, secret sync, emdash migrate, wrangler deploy,
  emdash migrate --check, post-deploy secret verify.

  -WorkerOnly: skip Terraform; still backup + migrate + deploy the web worker
  unless -SkipTursoBackup. Resolves Turso credentials for core migrate (runtime
  still uses Cloudflare TURSO_* secrets). Requires -AllowProduction when using
  -WorkerOnly.

  -DryRun: skip backup, migrate, build, and deploy. Verifies the live Worker
  has the required secret *names* (including TURSO_*) via wrangler secret list.

  Build version (#168): stamped at build time by scripts/build-provenance-env.ps1 (local runs:
  <base>-local.<sha7>); this script never edits web/package.json.

  Turso rollback checkpoint runs before migrate for full deploy and -WorkerOnly
  (WSL Turso on Windows; native turso on Linux) unless -SkipTursoBackup.
  -SkipTursoBackup skips the export/rollback branch with no 24h-checkpoint
  requirement. Combined with -WorkerOnly it also skips emdash migrate
  apply/check (Worker hotfix; no Turso mutate). Skipped for -DryRun.

  -UseFreshTursoCheckpoint: do not take a new backup here. Require backup metadata
  newer than 24h under .release/rollback-branches/ (written by
  backup-production-emdash.ps1 earlier in the same run) that is kind
  production-emdash-content-backup, verificationPass true, a prod-rollback-* (or older prod-backup-*) branch and
  has workerTursoHost; a name match alone is not accepted. After the build resolves
  the emdash migrate target, refuse to migrate or deploy unless its host equals the
  backed-up workerTursoHost. Used by .github/workflows/deploy-worker.yml, which takes
  the verified prod-rollback-* Turso branch in its own step before this one.
  It also proves the LIVE production Worker reads that host (#142): before build it
  compares GET https://freedomtimes.news/api/deploy-provenance.json (a hash of the
  Worker's Turso host, never the host) with the backed-up host, and again right after
  wrangler deploy against the new version. Mismatch fails closed. A 404 before deploy is
  a bootstrap only if the live commit (/api/version.json) is in this clone's history and
  predates the endpoint (#144; run from a full, fetched clone); then a loud warning, the
  secret-vs-backup host check above still applies, and the post-deploy check is
  mandatory. Any other 404 fails closed. Bootstrap recurs only when the live Worker really
  runs a pre-endpoint build (e.g. after a wrangler rollback past the endpoint's first
  deploy, or a deploy of an older commit).
  Set FT_PRODUCTION_SITE_ORIGIN to override the origin; DEPLOY_PROVENANCE_TOKEN is sent
  as a bearer when set (only needed if the Worker has that secret).

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

if ($UseFreshTursoCheckpoint -and $SkipTursoBackup) {
    throw "Cannot combine -UseFreshTursoCheckpoint and -SkipTursoBackup."
}

. "$PSScriptRoot/Deploy-EnvironmentCommon.ps1"
Initialize-DeployEnvironment -Environment production
Set-DeploySkipTursoMutate -SkipTursoBackup:$SkipTursoBackup -WorkerOnly:$WorkerOnly

$workflowLabel = if ($WorkerOnly) { "worker deploy" } else { "full deploy" }
Write-DeployStep "Starting local production $workflowLabel"

Invoke-DeployPushSecretsPreflight

if (-not $DryRun) {
    if ($UseFreshTursoCheckpoint) {
        Assert-DeployFreshEmDashTursoBackup
        # #142: the LIVE production Worker must read the backed-up DB before anything is built,
        # migrated or deployed (404 = bootstrap only with proof the live Worker predates
        # the endpoint, #144; otherwise fail closed).
        Assert-DeployLiveWorkerTursoHostMatchesBackup -Phase PreDeploy | Out-Null
    }
    else {
        Invoke-DeployEmDashTursoBackup -SkipTursoBackup:$SkipTursoBackup
    }
}

try {
    if (-not $DryRun) {
        # #116: build (and its checks) BEFORE the Terraform apply. The apply re-uploads Terraform's
        # single-module Worker script, which stays live until wrangler deploy below; building first
        # keeps that window to Auth0 sync, secret sync and migrate.
        Invoke-DeployWorkerBuild -WorkerOnly:$WorkerOnly
    }

    if (-not $WorkerOnly) {
        Invoke-DeployTerraformApplyWithRecovery
        if (-not $DryRun) {
            Sync-DeployTursoBuildEnvAfterTerraform
        }
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

    if ($UseFreshTursoCheckpoint) {
        # The backup ran in an earlier step with its own credential resolution: fail closed
        # if the build's migrate target is a different DB from the one that was backed up.
        Assert-DeployMigrateTargetMatchesBackupHost
    }
    Invoke-DeployEmdashCoreMigrate
    Invoke-DeployWorkerDeploy
    if ($UseFreshTursoCheckpoint) {
        # #142: the NEW Worker version must read the same DB that was backed up and migrated.
        # No bootstrap here: a 404 after deploy is a failure.
        Assert-DeployLiveWorkerTursoHostMatchesBackup -Phase PostDeploy | Out-Null
    }
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
    # Terraform applied but wrangler deploy did not finish: loud redeploy warning + live check.
    Write-DeployIncompleteAfterTerraformWarning
    Complete-DeployTerraformLockfileRestore
}
