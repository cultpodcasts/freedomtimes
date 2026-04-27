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

if ($TerraformMode -eq "apply") {
    Write-Host "Reminder: create a Turso rollback branch checkpoint before production apply." -ForegroundColor Yellow
}

Write-Host "Dispatching terraform-production.yml (production_terraform_apply=$applyFlag)" -ForegroundColor Cyan
Invoke-Gh -Arguments @(
    "workflow", "run", "terraform-production.yml",
    "--repo", $Repository,
    "-f", "production_terraform_apply=$applyFlag"
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