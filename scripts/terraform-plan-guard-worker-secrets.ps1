[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("staging", "production")]
    [string]$Environment,
    [switch]$LoadEnvFiles,
    [string]$PlanFile = "tfplan",
    [switch]$SkipTursoPreflight,
    [switch]$RunPlan
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path $PSScriptRoot -Parent
$runScript = Join-Path $PSScriptRoot "terraform-run.ps1"
$envDir = Join-Path $repoRoot "infra/terraform/environments/$Environment"
. "$PSScriptRoot/ensure-windows-cli-path.ps1"
Initialize-WindowsCliPath

function Test-TursoWorkerSecretChangesInPlanText {
    param([string]$PlanText)

    $violations = New-Object System.Collections.Generic.List[string]
    $patterns = @(
        '(?m)^\s*\+ resource "cloudflare_workers_secret" "script_secrets"\["TURSO_(DATABASE_URL|AUTH_TOKEN)"\]',
        '(?m)^\s*~\s*resource "cloudflare_workers_secret" "script_secrets"\["TURSO_(DATABASE_URL|AUTH_TOKEN)"\]',
        '(?m)^\s*-/\+ resource "cloudflare_workers_secret" "script_secrets"\["TURSO_(DATABASE_URL|AUTH_TOKEN)"\]',
        '(?m)^\s*- resource "cloudflare_workers_secret" "script_secrets"\["TURSO_(DATABASE_URL|AUTH_TOKEN)"\]'
    )

    foreach ($pattern in $patterns) {
        foreach ($match in [regex]::Matches($PlanText, $pattern)) {
            [void]$violations.Add($match.Value.Trim())
        }
    }

    return ,@($violations | Select-Object -Unique)
}

if ($RunPlan) {
    $planArgs = @{
        Environment = $Environment
        Operation   = "plan"
        PlanFile    = $PlanFile
    }
    if ($LoadEnvFiles) {
        $planArgs["LoadEnvFiles"] = $true
    }
    if ($SkipTursoPreflight) {
        $planArgs["SkipTursoPreflight"] = $true
    }

    & $runScript @planArgs
    if ($LASTEXITCODE -ne 0) {
        throw "terraform plan failed with exit code $LASTEXITCODE"
    }
}

$resolvedPlanFile = if ([System.IO.Path]::IsPathRooted($PlanFile)) {
    $PlanFile
}
else {
    Join-Path $envDir $PlanFile
}

if (-not (Test-Path -LiteralPath $resolvedPlanFile)) {
    throw "Plan file not found: $resolvedPlanFile. Run with -RunPlan or pass an existing -PlanFile."
}

Push-Location $envDir
try {
    $planText = & terraform show -no-color $resolvedPlanFile 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) {
        throw "terraform show failed: $planText"
    }
}
finally {
    Pop-Location
}

if ($Environment -ne "production") {
    Write-Host "Turso worker secret guard skipped for $Environment (production-only policy)." -ForegroundColor DarkGray
    exit 0
}

$violations = Test-TursoWorkerSecretChangesInPlanText -PlanText $planText
if ($violations.Count -gt 0) {
    Write-Error @"
BLOCKED: terraform plan would create, update, replace, or destroy TURSO_* worker secrets on the production web worker.
Never apply production plans that mutate EmDash Turso secrets — use switch-production-turso-secrets.ps1 instead.

Detected:
$($violations -join [Environment]::NewLine)

Ensure production worker_secrets excludes TURSO_* and run terraform-unmanage-worker-turso-secrets.ps1 if state still tracks them.
State script_name must be freedomtimes (not freedomtimes-holding).
Re-run:
  pwsh scripts/terraform-run.ps1 -Environment production -Operation plan -LoadEnvFiles
  pwsh scripts/terraform-plan-guard-worker-secrets.ps1 -Environment production -PlanFile $PlanFile
"@
    exit 1
}

Write-Host "Turso worker secret safety check passed for $Environment (0 TURSO_* worker secret mutations)." -ForegroundColor Green
exit 0
