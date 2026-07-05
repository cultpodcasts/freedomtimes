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

function Test-TursoDatabaseDestroyInPlanText {
    param([string]$PlanText)

    $violations = New-Object System.Collections.Generic.List[string]

    if ($PlanText -match '(?ms)# turso_database\.[^\r\n]+ must be replaced') {
        foreach ($match in [regex]::Matches($PlanText, '(?m)^\s*# turso_database\.[^\r\n]+ must be replaced')) {
            [void]$violations.Add($match.Value.Trim())
        }
    }

    if ($PlanText -match '(?ms)-/\+ resource "turso_database"') {
        foreach ($match in [regex]::Matches($PlanText, '(?m)^\s*-/\+ resource "turso_database"')) {
            [void]$violations.Add($match.Value.Trim())
        }
    }

    if ($PlanText -match '(?ms)- resource "turso_database"') {
        foreach ($match in [regex]::Matches($PlanText, '(?m)^\s*- resource "turso_database"')) {
            [void]$violations.Add($match.Value.Trim())
        }
    }

    return ,@($violations | Select-Object -Unique)
}

if ($RunPlan) {
    $planArgs = @{
        Environment  = $Environment
        Operation    = "plan"
        PlanFile     = $PlanFile
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

$violations = Test-TursoDatabaseDestroyInPlanText -PlanText $planText
if ($violations.Count -gt 0) {
    Write-Error @"
BLOCKED: terraform plan would destroy or replace turso_database resources in $Environment.
Never apply production plans that replace Turso databases — data loss is possible.

Detected:
$($violations -join [Environment]::NewLine)

Fix drift (group/name/import/lifecycle ignore_changes) and re-run:
  pwsh scripts/terraform-run.ps1 -Environment $Environment -Operation plan -LoadEnvFiles
  pwsh scripts/terraform-plan-guard-turso.ps1 -Environment $Environment -PlanFile $PlanFile
"@
    exit 1
}

Write-Host "Turso database safety check passed for $Environment (0 turso_database destroy/replace actions)." -ForegroundColor Green
exit 0
