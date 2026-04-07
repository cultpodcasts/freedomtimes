[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("staging", "production", "auth0-shared")]
    [string]$Environment,
    [Parameter(Mandatory = $true)]
    [ValidateSet("init", "validate", "plan", "apply", "destroy", "import", "output")]
    [string]$Operation,
    [switch]$LoadEnvFiles,
    [string]$LockTimeout = "5m",
    [string]$PlanFile = "tfplan",
    [switch]$AutoApprove,
    [switch]$UsePlanFile,
    [string]$ImportAddress,
    [string]$ImportId,
    [string]$OutputName
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path $PSScriptRoot -Parent
$envDir = Join-Path $repoRoot "infra/terraform/environments/$Environment"
$preflightScript = Join-Path $PSScriptRoot "terraform-preflight.ps1"

function Invoke-TerraformCommand {
    param([string[]]$CommandArgs)

    $verb = if ($CommandArgs.Count -gt 0) { $CommandArgs[0] } else { "<none>" }
    Write-Host "DEBUG: Executing terraform $verb with $($CommandArgs.Count - 1) args" -ForegroundColor DarkGray
    $global:LASTEXITCODE = 0
    
    & terraform @CommandArgs

    $lastExit = Get-Variable -Name LASTEXITCODE -Scope Global -ErrorAction SilentlyContinue
    if ($null -ne $lastExit) {
        return [int]$lastExit.Value
    }

    if ($?) {
        return 0
    }

    return 1
}

function Import-EnvFile {
    param([string]$Path)

    if (-not (Test-Path $Path)) { return }

    Get-Content $Path | ForEach-Object {
        $line = $_.Trim()
        if ([string]::IsNullOrWhiteSpace($line) -or $line.StartsWith("#")) { return }
        if ($line -match '^[A-Za-z_][A-Za-z0-9_]*=') {
            $parts = $line -split '=', 2
            $key = $parts[0].Trim().Trim([char]0xFEFF)
            $value = $parts[1].Trim().Trim([char]0xFEFF)
            [System.Environment]::SetEnvironmentVariable($key, $value, "Process")
        }
    }
}

function Invoke-EnvRemapping {
    param([string]$Env)

    # Shared uppercase → lowercase TF_VAR aliases
    $sharedAliases = [ordered]@{
        "TF_VAR_cloudflare_api_token"           = "TF_VAR_CLOUDFLARE_API_TOKEN"
        "TF_VAR_cloudflare_account_id"          = "TF_VAR_CLOUDFLARE_ACCOUNT_ID"
        "TF_VAR_cloudflare_zone_id"             = "TF_VAR_CLOUDFLARE_ZONE_ID"
        "TF_VAR_auth0_domain"                   = "TF_VAR_AUTH0_DOMAIN"
        "TF_VAR_auth0_management_client_id"     = "TF_VAR_AUTH0_MANAGEMENT_CLIENT_ID"
        "TF_VAR_auth0_management_client_secret" = "TF_VAR_AUTH0_MANAGEMENT_CLIENT_SECRET"
        "TF_VAR_azure_location"                 = "TF_VAR_AZURE_LOCATION"
        "TF_VAR_neon_api_key"                   = "TF_VAR_NEON_API_KEY"
    }
    foreach ($target in $sharedAliases.Keys) {
        $src = [System.Environment]::GetEnvironmentVariable($sharedAliases[$target], "Process")
        if (-not [string]::IsNullOrWhiteSpace($src)) {
            [System.Environment]::SetEnvironmentVariable($target, $src, "Process")
        }
    }

    # Environment-specific suffix → unsuffixed TF_VAR names
    if ($Env -eq "staging" -or $Env -eq "production") {
        $suffix = if ($Env -eq "staging") { "_STAGING" } else { "_PRODUCTION" }
        $envSpecific = [ordered]@{
            "TF_VAR_route_pattern"                             = "TF_VAR_ROUTE_PATTERN$suffix"
            "TF_VAR_worker_name"                               = "TF_VAR_WORKER_NAME$suffix"
            "TF_VAR_manage_apex_dns_record"                    = "TF_VAR_MANAGE_APEX_DNS_RECORD$suffix"
            "TF_VAR_apex_dns_record_content"                   = "TF_VAR_APEX_DNS_RECORD_CONTENT$suffix"
            "TF_VAR_apim_function_key"                         = "TF_VAR_APIM_FUNCTION_KEY$suffix"
            "TF_VAR_enable_hyperdrive"                         = "TF_VAR_ENABLE_HYPERDRIVE$suffix"
            "TF_VAR_hyperdrive_name"                           = "TF_VAR_HYPERDRIVE_NAME$suffix"
            "TF_VAR_api_custom_hostname"                       = "TF_VAR_API_CUSTOM_HOSTNAME$suffix"
            "TF_VAR_workspace_url"                             = "TF_VAR_WORKSPACE_URL$suffix"
            "TF_VAR_api_management_allowed_origins"            = "TF_VAR_API_MANAGEMENT_ALLOWED_ORIGINS$suffix"
            "TF_VAR_api_custom_hostname_certificate_base64"    = "TF_VAR_API_CUSTOM_HOSTNAME_CERTIFICATE_BASE64$suffix"
            "TF_VAR_api_custom_hostname_certificate_password"  = "TF_VAR_API_CUSTOM_HOSTNAME_CERTIFICATE_PASSWORD$suffix"
            "TF_VAR_emdash_database_url"                       = "TF_VAR_EMDASH_DATABASE_URL$suffix"
            "TF_VAR_manage_neon_resources"                     = "TF_VAR_MANAGE_NEON_RESOURCES$suffix"
            "TF_VAR_neon_project_id"                           = "TF_VAR_NEON_PROJECT_ID$suffix"
            "TF_VAR_neon_branch_id"                            = "TF_VAR_NEON_BRANCH_ID$suffix"
            "TF_VAR_neon_endpoint_id"                          = "TF_VAR_NEON_ENDPOINT_ID$suffix"
            "TF_VAR_neon_branch_name"                          = "TF_VAR_NEON_BRANCH_NAME$suffix"
            "TF_VAR_neon_role_name"                            = "TF_VAR_NEON_ROLE_NAME$suffix"
            "TF_VAR_neon_database_name"                        = "TF_VAR_NEON_DATABASE_NAME$suffix"
        }
        foreach ($target in $envSpecific.Keys) {
            $src = [System.Environment]::GetEnvironmentVariable($envSpecific[$target], "Process")
            if (-not [string]::IsNullOrWhiteSpace($src)) {
                [System.Environment]::SetEnvironmentVariable($target, $src, "Process")
            }
        }

        # Keep Auth0 API audience environment-specific to avoid staging/prod cross-contamination.
        if ($Env -eq "staging") {
            $audience = Get-FirstEnvValue -Names @("AUTH0_API_AUDIENCE_STAGING")
        }
        else {
            $audience = Get-FirstEnvValue -Names @("AUTH0_API_AUDIENCE_PRODUCTION", "AUTH0_API_AUDIENCE")
        }
        if (-not [string]::IsNullOrWhiteSpace($audience)) {
            [System.Environment]::SetEnvironmentVariable("TF_VAR_auth0_api_identifier", $audience, "Process")
        }
    }

    if ($Env -eq "auth0-shared") {
        $audience = Get-FirstEnvValue -Names @("TF_VAR_auth0_api_identifier", "AUTH0_API_AUDIENCE")
        if (-not [string]::IsNullOrWhiteSpace($audience)) {
            [System.Environment]::SetEnvironmentVariable("TF_VAR_auth0_api_identifier", $audience, "Process")
        }

        $rolesClaim = Get-FirstEnvValue -Names @("TF_VAR_editorial_roles_claim", "AUTH0_ROLES_CLAIM_NAMESPACE")
        if (-not [string]::IsNullOrWhiteSpace($rolesClaim)) {
            [System.Environment]::SetEnvironmentVariable("TF_VAR_editorial_roles_claim", $rolesClaim, "Process")
        }
    }
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
    param([string]$Env)

    if ($Env -eq "auth0-shared") {
        $map = [ordered]@{
            auth0_domain                        = @("TF_VAR_auth0_domain", "TF_VAR_AUTH0_DOMAIN")
            auth0_management_client_id          = @("TF_VAR_auth0_management_client_id", "TF_VAR_AUTH0_MANAGEMENT_CLIENT_ID")
            auth0_management_client_secret      = @("TF_VAR_auth0_management_client_secret", "TF_VAR_AUTH0_MANAGEMENT_CLIENT_SECRET")
            auth0_api_identifier                = @("TF_VAR_auth0_api_identifier", "AUTH0_API_AUDIENCE")
            editorial_roles_claim               = @("TF_VAR_editorial_roles_claim", "AUTH0_ROLES_CLAIM_NAMESPACE")
            workspace_url                       = @("TF_VAR_workspace_url", "TF_VAR_WORKSPACE_URL_PRODUCTION")
        }
    }
    else {
        $map = [ordered]@{
            cloudflare_api_token                    = @("TF_VAR_cloudflare_api_token", "TF_VAR_CLOUDFLARE_API_TOKEN")
            cloudflare_account_id                   = @("TF_VAR_cloudflare_account_id", "TF_VAR_CLOUDFLARE_ACCOUNT_ID")
            cloudflare_zone_id                      = @("TF_VAR_cloudflare_zone_id", "TF_VAR_CLOUDFLARE_ZONE_ID")
            auth0_domain                            = @("TF_VAR_auth0_domain", "TF_VAR_AUTH0_DOMAIN")
            auth0_management_client_id              = @("TF_VAR_auth0_management_client_id", "TF_VAR_AUTH0_MANAGEMENT_CLIENT_ID")
            auth0_management_client_secret          = @("TF_VAR_auth0_management_client_secret", "TF_VAR_AUTH0_MANAGEMENT_CLIENT_SECRET")
            auth0_api_identifier                    = @("TF_VAR_auth0_api_identifier")
            route_pattern                           = @("TF_VAR_route_pattern")
            worker_name                             = @("TF_VAR_worker_name")
            manage_apex_dns_record                  = @("TF_VAR_manage_apex_dns_record")
            apex_dns_record_content                 = @("TF_VAR_apex_dns_record_content")
            apim_function_key                       = @("TF_VAR_apim_function_key", "TF_VAR_APIM_FUNCTION_KEY")
            enable_hyperdrive                       = @("TF_VAR_enable_hyperdrive")
            hyperdrive_name                         = @("TF_VAR_hyperdrive_name")
            api_custom_hostname                     = @("TF_VAR_api_custom_hostname")
            workspace_url                           = @("TF_VAR_workspace_url")
            api_management_allowed_origins          = @("TF_VAR_api_management_allowed_origins")
            api_custom_hostname_certificate_base64  = @("TF_VAR_api_custom_hostname_certificate_base64")
            api_custom_hostname_certificate_password = @("TF_VAR_api_custom_hostname_certificate_password")
            emdash_database_url                     = @("TF_VAR_emdash_database_url")
            neon_api_key                            = @("TF_VAR_neon_api_key", "TF_VAR_NEON_API_KEY")
            manage_neon_resources                   = @("TF_VAR_manage_neon_resources")
            neon_project_id                         = @("TF_VAR_neon_project_id")
            neon_branch_id                          = @("TF_VAR_neon_branch_id")
            neon_endpoint_id                        = @("TF_VAR_neon_endpoint_id")
            neon_branch_name                        = @("TF_VAR_neon_branch_name")
            neon_role_name                          = @("TF_VAR_neon_role_name")
            neon_database_name                      = @("TF_VAR_neon_database_name")
        }
    }

    $varList = New-Object System.Collections.Generic.List[string]
    foreach ($tfVarName in $map.Keys) {
        $value = Get-FirstEnvValue -Names $map[$tfVarName]
        if (-not [string]::IsNullOrWhiteSpace($value)) {
            $varList.Add("-var")
            $varList.Add("$tfVarName=$value")
        }
    }

    return $varList.ToArray()
}

function Set-Or-AddEnvFileValue {
    param(
        [string]$Path,
        [string]$Key,
        [string]$Value
    )

    if (-not (Test-Path $Path)) {
        throw "Env file not found: $Path"
    }

    $lines = [System.Collections.Generic.List[string]]::new()
    $lines.AddRange([string[]](Get-Content -Path $Path))

    $pattern = "^" + [Regex]::Escape($Key) + "="
    $updated = $false
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match $pattern) {
            $lines[$i] = "$Key=$Value"
            $updated = $true
            break
        }
    }

    if (-not $updated) {
        $lines.Add("$Key=$Value")
    }

    Set-Content -Path $Path -Value $lines -Encoding UTF8
}

function Sync-Auth0LoginAppEnvFromState {
    param(
        [string]$Env,
        [string]$RepoRoot
    )

    $stateJson = & terraform state pull
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($stateJson)) {
        Write-Warning "Skipping Auth0 env sync: unable to pull terraform state."
        return
    }

    $state = $stateJson | ConvertFrom-Json
    $clientResource = $state.resources |
        Where-Object { $_.module -eq "module.auth0_app" -and $_.type -eq "auth0_client" -and $_.name -eq "admin_ui" } |
        Select-Object -First 1
    $credentialsResource = $state.resources |
        Where-Object { $_.module -eq "module.auth0_app" -and $_.type -eq "auth0_client_credentials" -and $_.name -eq "admin_ui" } |
        Select-Object -First 1

    if ($null -eq $clientResource -or $null -eq $credentialsResource) {
        Write-Warning "Skipping Auth0 env sync: auth0 app resources not present in state."
        return
    }

    $clientId = [string]$clientResource.instances[0].attributes.client_id
    $clientSecret = [string]$credentialsResource.instances[0].attributes.client_secret

    if ([string]::IsNullOrWhiteSpace($clientId) -or [string]::IsNullOrWhiteSpace($clientSecret)) {
        Write-Warning "Skipping Auth0 env sync: missing client_id or client_secret in state."
        return
    }

    $suffix = if ($Env -eq "staging") { "STAGING" } else { "PRODUCTION" }
    $envFilePath = Join-Path $RepoRoot ".env.dev"

    Set-Or-AddEnvFileValue -Path $envFilePath -Key "AUTH0_LOGIN_APP_CLIENT_ID_$suffix" -Value $clientId
    Set-Or-AddEnvFileValue -Path $envFilePath -Key "AUTH0_LOGIN_APP_CLIENT_SECRET_$suffix" -Value $clientSecret

    Write-Host "Synced AUTH0_LOGIN_APP_CLIENT_ID_$suffix and AUTH0_LOGIN_APP_CLIENT_SECRET_$suffix to .env.dev from terraform state." -ForegroundColor DarkGray
}

if (-not (Test-Path $envDir)) {
    throw "Environment directory not found: $envDir"
}
if (-not (Test-Path $preflightScript)) {
    throw "Preflight script not found: $preflightScript"
}

if ($LoadEnvFiles) {
    $baseEnvPath = Join-Path $repoRoot ".env.dev"
    Import-EnvFile -Path $baseEnvPath
    Invoke-EnvRemapping -Env $Environment
    Write-Host "DEBUG: Loaded and remapped env vars from .env.dev for environment: $Environment" -ForegroundColor DarkGray
}

$preflightArgs = @{
    Environment = $Environment
}
if ($LoadEnvFiles) {
    $preflightArgs["LoadEnvFiles"] = $true
}

$global:LASTEXITCODE = 0
& $preflightScript @preflightArgs
$preflightCode = 0
$preflightExit = Get-Variable -Name LASTEXITCODE -Scope Global -ErrorAction SilentlyContinue
if ($null -ne $preflightExit) {
    $preflightCode = [int]$preflightExit.Value
}
elseif (-not $?) {
    $preflightCode = 1
}

if ($preflightCode -ne 0) {
    exit $preflightCode
}

Push-Location $envDir
try {
    Write-Host "DEBUG: Building terraform var args..." -ForegroundColor DarkGray
    $varArgs = Build-TerraformVarArgs -Env $Environment
    Write-Host "DEBUG: Built $($varArgs.Count) var args" -ForegroundColor DarkGray

    if ($Operation -eq "init") {
        Write-Host "DEBUG: Running init operation" -ForegroundColor DarkGray
        $exitCode = Invoke-TerraformCommand -CommandArgs @("init", "-input=false", "-no-color")
        exit $exitCode
    }

    if ($Operation -eq "validate") {
        Write-Host "DEBUG: Running validate operation" -ForegroundColor DarkGray
        $exitCode = Invoke-TerraformCommand -CommandArgs @("validate", "-no-color")
        exit $exitCode
    }

    if ($Operation -eq "plan") {
        Write-Host "DEBUG: Running plan operation" -ForegroundColor DarkGray
        $planArgs = @("plan", "-input=false", "-lock-timeout=$LockTimeout", "-no-color", "-out=$PlanFile") + $varArgs
        $exitCode = Invoke-TerraformCommand -CommandArgs $planArgs
        exit $exitCode
    }

    if ($Operation -eq "apply") {
        Write-Host "DEBUG: Running apply operation, AutoApprove=$AutoApprove, PlanFile=$PlanFile, UsePlanFile=$UsePlanFile" -ForegroundColor DarkGray
        if ($UsePlanFile) {
            if (-not (Test-Path $PlanFile)) {
                throw "Plan file '$PlanFile' not found. Run plan first or remove -UsePlanFile for direct apply."
            }
            Write-Host "DEBUG: Plan file exists, applying from saved plan" -ForegroundColor DarkGray
            $exitCode = Invoke-TerraformCommand -CommandArgs @("apply", "-input=false", "-lock-timeout=$LockTimeout", "-no-color", $PlanFile)
            exit $exitCode
        }

        if ($AutoApprove) {
            Write-Host "DEBUG: AutoApprove enabled, running apply with $($varArgs.Count) var args" -ForegroundColor DarkGray
            $applyArgs = @("apply", "-input=false", "-lock-timeout=$LockTimeout", "-no-color", "-auto-approve") + $varArgs
            Write-Host "DEBUG: applyArgs count: $($applyArgs.Count)" -ForegroundColor DarkGray
            $exitCode = Invoke-TerraformCommand -CommandArgs $applyArgs
            if ($exitCode -eq 0 -and ($Environment -eq "staging" -or $Environment -eq "production")) {
                try {
                    Sync-Auth0LoginAppEnvFromState -Env $Environment -RepoRoot $repoRoot
                }
                catch {
                    Write-Warning ("Auth0 env sync skipped: " + $_.Exception.Message)
                }
            }
            Write-Host "DEBUG: terraform apply exited with code: $exitCode" -ForegroundColor DarkGray
            exit $exitCode
        }

        throw "Pass -AutoApprove for direct apply, or pass -UsePlanFile with a valid -PlanFile."
    }

    if ($Operation -eq "destroy") {
        Write-Host "DEBUG: Running destroy operation" -ForegroundColor DarkGray
        if (-not $AutoApprove) {
            throw "Destroy requires -AutoApprove to ensure non-interactive execution."
        }

        $destroyArgs = @("destroy", "-input=false", "-lock-timeout=$LockTimeout", "-no-color", "-auto-approve") + $varArgs
        $exitCode = Invoke-TerraformCommand -CommandArgs $destroyArgs
        exit $exitCode
    }

    if ($Operation -eq "import") {
        Write-Host "DEBUG: Running import operation" -ForegroundColor DarkGray
        if ([string]::IsNullOrWhiteSpace($ImportAddress) -or [string]::IsNullOrWhiteSpace($ImportId)) {
            throw "Import requires both -ImportAddress and -ImportId."
        }

        $importArgs = @("import", "-input=false", "-lock-timeout=$LockTimeout", "-no-color") + $varArgs + @($ImportAddress, $ImportId)
        $exitCode = Invoke-TerraformCommand -CommandArgs $importArgs
        exit $exitCode
    }

    if ($Operation -eq "output") {
        Write-Host "DEBUG: Running output operation" -ForegroundColor DarkGray
        if ([string]::IsNullOrWhiteSpace($OutputName)) {
            $exitCode = Invoke-TerraformCommand -CommandArgs @("output", "-no-color")
            exit $exitCode
        }

        $exitCode = Invoke-TerraformCommand -CommandArgs @("output", "-raw", $OutputName)
        exit $exitCode
    }
}
finally {
    Pop-Location
}
