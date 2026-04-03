[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("staging", "production")]
    [string]$Environment,
    [Parameter(Mandatory = $true)]
    [ValidateSet("init", "validate", "plan", "apply", "destroy")]
    [string]$Operation,
    [switch]$LoadEnvFiles,
    [string]$LockTimeout = "5m",
    [string]$PlanFile = "tfplan",
    [switch]$AutoApprove
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path $PSScriptRoot -Parent
$envDir = Join-Path $repoRoot "infra/terraform/environments/$Environment"
$preflightScript = Join-Path $PSScriptRoot "terraform-preflight.ps1"

function Invoke-TerraformCommand {
    param([string[]]$Args)

    & terraform @Args

    $lastExit = Get-Variable -Name LASTEXITCODE -Scope Global -ErrorAction SilentlyContinue
    if ($null -ne $lastExit) {
        return [int]$lastExit.Value
    }

    if ($?) {
        return 0
    }

    return 1
}

if (-not (Test-Path $envDir)) {
    throw "Environment directory not found: $envDir"
}
if (-not (Test-Path $preflightScript)) {
    throw "Preflight script not found: $preflightScript"
}

$preflightArgs = @{
    Environment = $Environment
}
if ($LoadEnvFiles) {
    $preflightArgs["LoadEnvFiles"] = $true
}

& $preflightScript @preflightArgs
$preflightExit = Get-Variable -Name LASTEXITCODE -Scope Global -ErrorAction SilentlyContinue
if ($null -ne $preflightExit -and [int]$preflightExit.Value -ne 0) {
    exit [int]$preflightExit.Value
}

Push-Location $envDir
try {
    if ($Operation -eq "init") {
        $exitCode = Invoke-TerraformCommand -Args @("init", "-input=false", "-no-color")
        exit $exitCode
    }

    if ($Operation -eq "validate") {
        $exitCode = Invoke-TerraformCommand -Args @("validate", "-no-color")
        exit $exitCode
    }

    if ($Operation -eq "plan") {
        $exitCode = Invoke-TerraformCommand -Args @("plan", "-input=false", "-lock-timeout=$LockTimeout", "-no-color", "-out=$PlanFile")
        exit $exitCode
    }

    if ($Operation -eq "apply") {
        if (Test-Path $PlanFile) {
            $exitCode = Invoke-TerraformCommand -Args @("apply", "-input=false", "-lock-timeout=$LockTimeout", "-no-color", $PlanFile)
            exit $exitCode
        }

        if ($AutoApprove) {
            $exitCode = Invoke-TerraformCommand -Args @("apply", "-input=false", "-lock-timeout=$LockTimeout", "-no-color", "-auto-approve")
            exit $exitCode
        }

        throw "Plan file '$PlanFile' not found. Run plan first or pass -AutoApprove for direct apply."
    }

    if ($Operation -eq "destroy") {
        if (-not $AutoApprove) {
            throw "Destroy requires -AutoApprove to ensure non-interactive execution."
        }

        $exitCode = Invoke-TerraformCommand -Args @("destroy", "-input=false", "-lock-timeout=$LockTimeout", "-no-color", "-auto-approve")
        exit $exitCode
    }
}
finally {
    Pop-Location
}
