[CmdletBinding()]
param(
    [ValidateSet("plan", "apply")]
    [string]$TerraformMode = "apply",
    [switch]$Watch,
    [string]$Repository = "cultpodcasts/freedomtimes",
    [switch]$AllowProduction
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $AllowProduction) {
    throw "Production release is guardrailed. Re-run with -AllowProduction after approval."
}

function Test-CommandAvailable {
    param([string]$CommandName)

    $cmd = Get-Command $CommandName -ErrorAction SilentlyContinue
    return $null -ne $cmd
}

function Invoke-Gh {
    param([string[]]$Arguments)

    & gh @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "gh command failed: gh $($Arguments -join ' ')"
    }
}

if (-not (Test-CommandAvailable -CommandName "gh")) {
    throw "GitHub CLI (gh) is required. Install gh and authenticate with 'gh auth login'."
}

$applyFlag = if ($TerraformMode -eq "apply") { "true" } else { "false" }
$workerDeploy = if ($TerraformMode -eq "apply") { "true" } else { "false" }

if ($TerraformMode -eq "apply") {
    Write-Host "Warning: CI never applies a plan that re-uploads the Worker script. While the holding_page drift exists (after every local wrangler deploy), this run stops at 'Guard Worker Script Upload Plan' before anything is applied, migrated or deployed. Deploy with: pwsh ./scripts/deploy-production-local.ps1 (NON_TERRAFORM_RESOURCES.md#terraform-holding-page-drift)." -ForegroundColor Yellow
    Write-Host "Reminder: this dispatch sets production_worker_deploy=true. CI creates a Turso rollback branch (metadata artifact + job summary), then emdash migrate (requires secret EMDASH_TARGET_FINGERPRINT_PRODUCTION) → wrangler → emdash migrate --check. Push to main and -TerraformMode plan do not mutate EmDash/SQL/wrangler." -ForegroundColor Yellow
    Write-Host "Reminder: terraform-production.yml builds web/ from committed main without the deploy-time version stamp (/api/version.json version: unknown; commitSha is still set). Do not bump or commit web/package.json for a release (#168, web/docs/DEPLOY.md#build-version-stamped-at-deploy-time)." -ForegroundColor Yellow
}

Write-Host "Dispatching terraform-production.yml (production_terraform_apply=$applyFlag, production_worker_deploy=$workerDeploy)" -ForegroundColor Cyan
Invoke-Gh -Arguments @(
    "workflow", "run", "terraform-production.yml",
    "--repo", $Repository,
    "-f", "production_terraform_apply=$applyFlag",
    "-f", "production_worker_deploy=$workerDeploy"
)

Write-Host "Workflow dispatched successfully." -ForegroundColor Green

if (-not $Watch) {
    Write-Host "Use this to follow the run: gh run list --repo $Repository --workflow terraform-production.yml --limit 5"
    exit 0
}

Write-Host "Resolving latest production workflow run id..." -ForegroundColor Cyan
$runListJson = gh run list --repo $Repository --workflow terraform-production.yml --limit 1 --json databaseId,url,status,conclusion,createdAt
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($runListJson)) {
    throw "Unable to fetch latest production workflow run."
}

$runs = $runListJson | ConvertFrom-Json
if ($null -eq $runs -or $runs.Count -eq 0) {
    throw "No production workflow runs found after dispatch."
}

$runId = [string]$runs[0].databaseId
$runUrl = [string]$runs[0].url

if ([string]::IsNullOrWhiteSpace($runId)) {
    throw "Failed to determine workflow run id."
}

Write-Host "Watching run $runId" -ForegroundColor Cyan
Write-Host "Run URL: $runUrl" -ForegroundColor DarkGray

& gh run watch $runId --repo $Repository --exit-status
if ($LASTEXITCODE -ne 0) {
    throw "Production workflow run failed. Review: $runUrl"
}

Write-Host "Production workflow completed successfully." -ForegroundColor Green