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

function Get-FirstEnvValue {
    param([string[]]$Names)

    foreach ($name in $Names) {
        $value = [System.Environment]::GetEnvironmentVariable($name, "Process")
        if (-not [string]::IsNullOrWhiteSpace([string]$value)) {
            return [string]$value
        }
    }

    return ""
}

function Build-TerraformVarArgs {
    $map = [ordered]@{
        cloudflare_api_token                    = @("TF_VAR_cloudflare_api_token", "TF_VAR_CLOUDFLARE_API_TOKEN")
        cloudflare_account_id                   = @("TF_VAR_cloudflare_account_id", "TF_VAR_CLOUDFLARE_ACCOUNT_ID")
        cloudflare_zone_id                      = @("TF_VAR_cloudflare_zone_id", "TF_VAR_CLOUDFLARE_ZONE_ID")
        auth0_domain                            = @("TF_VAR_auth0_domain", "TF_VAR_AUTH0_DOMAIN")
        auth0_management_client_id              = @("TF_VAR_auth0_management_client_id", "TF_VAR_AUTH0_MANAGEMENT_CLIENT_ID")
        auth0_management_client_secret          = @("TF_VAR_auth0_management_client_secret", "TF_VAR_AUTH0_MANAGEMENT_CLIENT_SECRET")
        route_pattern                           = @("TF_VAR_route_pattern")
        worker_name                             = @("TF_VAR_worker_name")
        manage_apex_dns_record                  = @("TF_VAR_manage_apex_dns_record")
        apex_dns_record_content                 = @("TF_VAR_apex_dns_record_content")
        api_custom_hostname                     = @("TF_VAR_api_custom_hostname")
        workspace_url                           = @("TF_VAR_workspace_url")
        api_management_allowed_origins          = @("TF_VAR_api_management_allowed_origins")
        api_custom_hostname_certificate_base64  = @("TF_VAR_api_custom_hostname_certificate_base64")
        api_custom_hostname_certificate_password = @("TF_VAR_api_custom_hostname_certificate_password")
    }

    $args = New-Object System.Collections.Generic.List[string]
    foreach ($tfVarName in $map.Keys) {
        $value = Get-FirstEnvValue -Names $map[$tfVarName]
        if (-not [string]::IsNullOrWhiteSpace($value)) {
            $args.Add("-var")
            $args.Add("$tfVarName=$value")
        }
    }

    return @($args)
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
    $varArgs = Build-TerraformVarArgs

    if ($Operation -eq "init") {
        $exitCode = Invoke-TerraformCommand -Args @("init", "-input=false", "-no-color")
        exit $exitCode
    }

    if ($Operation -eq "validate") {
        $exitCode = Invoke-TerraformCommand -Args @("validate", "-no-color")
        exit $exitCode
    }

    if ($Operation -eq "plan") {
        $planArgs = @("plan", "-input=false", "-lock-timeout=$LockTimeout", "-no-color", "-out=$PlanFile") + $varArgs
        $exitCode = Invoke-TerraformCommand -Args $planArgs
        exit $exitCode
    }

    if ($Operation -eq "apply") {
        if (Test-Path $PlanFile) {
            $exitCode = Invoke-TerraformCommand -Args @("apply", "-input=false", "-lock-timeout=$LockTimeout", "-no-color", $PlanFile)
            exit $exitCode
        }

        if ($AutoApprove) {
            $applyArgs = @("apply", "-input=false", "-lock-timeout=$LockTimeout", "-no-color", "-auto-approve") + $varArgs
            $exitCode = Invoke-TerraformCommand -Args $applyArgs
            exit $exitCode
        }

        throw "Plan file '$PlanFile' not found. Run plan first or pass -AutoApprove for direct apply."
    }

    if ($Operation -eq "destroy") {
        if (-not $AutoApprove) {
            throw "Destroy requires -AutoApprove to ensure non-interactive execution."
        }

        $destroyArgs = @("destroy", "-input=false", "-lock-timeout=$LockTimeout", "-no-color", "-auto-approve") + $varArgs
        $exitCode = Invoke-TerraformCommand -Args $destroyArgs
        exit $exitCode
    }
}
finally {
    Pop-Location
}
