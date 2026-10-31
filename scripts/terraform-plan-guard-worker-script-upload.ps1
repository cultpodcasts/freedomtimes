# Pre-apply guard: refuse a plan that would create/update/replace the web Worker script
# (cloudflare_workers_script.holding_page) unless the deploy pipeline runs wrangler deploy later in
# the same run (FT_WRANGLER_DEPLOY_FOLLOWS=1; the gap until then is issue #116) or -AllowWorkerScriptUpload (break-glass) is passed.
# Called by terraform-run.ps1 before every staging/production apply (-UsePlanFile and -AutoApprove), and by
# the Terraform GitHub workflows on every plan, which never set FT_WRANGLER_DEPLOY_FOLLOWS (CI applies that
# touch the Worker are refused; report-only on plan-only runs).
# Exit codes: 0 allowed, 1 blocked. See NON_TERRAFORM_RESOURCES.md#terraform-holding-page-drift.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("staging", "production")]
    [string]$Environment,
    [string]$PlanFile = "tfplan",
    # Test seam / offline use: read `terraform show -json` output from this file instead of running terraform.
    [string]$PlanJsonFile,
    [switch]$AllowWorkerScriptUpload
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path $PSScriptRoot -Parent
. "$PSScriptRoot/lib/TerraformWorkerScriptUploadGuard.ps1"

if (-not [string]::IsNullOrWhiteSpace($PlanJsonFile)) {
    $planJson = Get-Content -Raw -LiteralPath $PlanJsonFile
}
else {
    . "$PSScriptRoot/ensure-windows-cli-path.ps1"
    Initialize-WindowsCliPath
    $envDir = Join-Path $repoRoot "infra/terraform/environments/$Environment"
    $resolvedPlanFile = if ([System.IO.Path]::IsPathRooted($PlanFile)) { $PlanFile } else { Join-Path $envDir $PlanFile }
    if (-not (Test-Path -LiteralPath $resolvedPlanFile)) {
        Write-Host "Plan file not found: $resolvedPlanFile" -ForegroundColor Red
        exit 1
    }
    Push-Location $envDir
    try {
        $PSNativeCommandUseErrorActionPreference = $false
        # stderr kept separate so it cannot corrupt the JSON; plan JSON contains no secret values
        # (sensitive attributes are redacted to true in *_sensitive), but it is never printed.
        $planJson = (& terraform show -json $resolvedPlanFile 2>$null) -join "`n"
        $showExit = $LASTEXITCODE
    }
    finally {
        Pop-Location
    }
    if ($showExit -ne 0) {
        Write-Host "terraform show -json failed (exit $showExit); refusing to apply an unchecked plan." -ForegroundColor Red
        exit 1
    }
}

try {
    $changes = Get-WorkerScriptUploadChanges -PlanJson $planJson
}
catch {
    Write-Host "Could not parse the plan JSON ($($_.Exception.Message)); refusing to apply an unchecked plan." -ForegroundColor Red
    exit 1
}

if ($changes.Count -eq 0) {
    Write-Host "Worker script upload guard passed for $Environment (plan does not touch cloudflare_workers_script.holding_page)." -ForegroundColor Green
    exit 0
}

if ($env:FT_WRANGLER_DEPLOY_FOLLOWS -eq "1") {
    Write-Host "Worker script upload guard: allowed for $Environment because the deploy pipeline runs wrangler deploy later in this run (FT_WRANGLER_DEPLOY_FOLLOWS=1): $($changes -join '; ')" -ForegroundColor DarkGray
    exit 0
}

if ($AllowWorkerScriptUpload) {
    Write-Host "BREAK-GLASS: applying a plan that re-uploads the $Environment Worker script ($($changes -join '; ')). Redeploy with Wrangler afterwards: $(if ($Environment -eq 'production') { 'pwsh scripts/deploy-production-local.ps1 -WorkerOnly' } else { 'pwsh scripts/deploy-staging-local.ps1 -WorkerOnly' })" -ForegroundColor Yellow
    exit 0
}

Write-Host (Get-WorkerScriptUploadGuardMessage -Environment $Environment -Changes $changes) -ForegroundColor Red
exit 1
