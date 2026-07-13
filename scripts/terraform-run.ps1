# Canonical Terraform runner for staging, production, and auth0-shared.
# Acquires a per-environment file lock (.terraform-locks/<env>.lock) so only one
# local plan/apply/import/etc. runs at a time. See scripts/terraform-env-lock.ps1.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("staging", "production", "auth0-shared")]
    [string]$Environment,
    [Parameter(Mandatory = $true)]
    [ValidateSet("init", "validate", "plan", "apply", "destroy", "import", "output")]
    [string]$Operation,
    [switch]$LoadEnvFiles,
    [switch]$SkipTursoPreflight,
    [string]$LockTimeout = "5m",
    [string]$PlanFile = "tfplan",
    [switch]$AutoApprove,
    [switch]$UsePlanFile,
    [string[]]$Target,
    [string[]]$Replace,
    [string]$ImportAddress,
    [string]$ImportId,
    [string]$OutputName
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path $PSScriptRoot -Parent
$envDir = Join-Path $repoRoot "infra/terraform/environments/$Environment"
. "$PSScriptRoot/ensure-windows-cli-path.ps1"
Initialize-WindowsCliPath
. "$PSScriptRoot/terraform-turso-env.ps1"
. "$PSScriptRoot/terraform-env-lock.ps1"
$preflightScript = Join-Path $PSScriptRoot "terraform-preflight.ps1"

$requiresEnvironmentLock = @("init", "validate", "plan", "apply", "destroy", "import") -contains $Operation
$environmentLockCaller = "terraform-run.ps1 -Environment $Environment -Operation $Operation"

function Invoke-TerraformCommand {
    param([string[]]$CommandArgs)

    $verb = if ($CommandArgs.Count -gt 0) { $CommandArgs[0] } else { "<none>" }
    Write-Host "DEBUG: Executing terraform $verb with $($CommandArgs.Count - 1) args" -ForegroundColor DarkGray

    # CRITICAL: terraform's stdout must NOT flow through this function's own output stream.
    # Every caller does `$exitCode = Invoke-TerraformCommand ...`, and PowerShell functions
    # implicitly return ALL uncaptured output alongside any explicit `return` value. Calling
    # `& terraform @CommandArgs` bare (as before) meant terraform's entire stdout (plan/apply
    # output, "Apply complete!", etc.) was bundled into $exitCode as an object array, with the
    # real integer exit code buried as just one element. Passing that array to `exit $exitCode`
    # then silently resolves to process exit code 0 no matter what — which is exactly how a
    # FAILED `terraform apply` (Auth0 OIDC error and all) was previously reported as having
    # "succeeded on first attempt". Piping through Write-Host keeps terraform's output visible
    # on screen while keeping it out of the function's return value, so $exitCode stays a clean
    # [int] and `exit $exitCode` reports the real result.
    & terraform @CommandArgs | ForEach-Object { Write-Host $_ }
    $exitCode = $LASTEXITCODE

    if ($null -eq $exitCode) {
        if ($?) { return 0 }
        return 1
    }

    return [int]$exitCode
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
        "TF_VAR_turso_organization"             = "TF_VAR_TURSO_ORGANIZATION"
    }
    foreach ($target in $sharedAliases.Keys) {
        $src = [System.Environment]::GetEnvironmentVariable($sharedAliases[$target], "Process")
        if (-not [string]::IsNullOrWhiteSpace($src)) {
            [System.Environment]::SetEnvironmentVariable($target, $src, "Process")
        }
    }

    # Required analytics Worker secret: ANALYTICS_CF_TOKEN → var.cloudflare_analytics_api_token.
    # Terraform does not mint analytics API tokens.
    $analyticsOverride = Get-FirstEnvValue -Names @(
        "TF_VAR_cloudflare_analytics_api_token",
        "TF_VAR_CLOUDFLARE_ANALYTICS_API_TOKEN",
        "ANALYTICS_CF_TOKEN"
    )
    if (-not [string]::IsNullOrWhiteSpace($analyticsOverride)) {
        [System.Environment]::SetEnvironmentVariable("TF_VAR_cloudflare_analytics_api_token", $analyticsOverride, "Process")
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
            "TF_VAR_api_custom_hostname"                       = "TF_VAR_API_CUSTOM_HOSTNAME$suffix"
            "TF_VAR_workspace_url"                             = "TF_VAR_WORKSPACE_URL$suffix"
            "TF_VAR_api_custom_hostname_certificate_base64"    = "TF_VAR_API_CUSTOM_HOSTNAME_CERTIFICATE_BASE64$suffix"
            "TF_VAR_api_custom_hostname_certificate_password"  = "TF_VAR_API_CUSTOM_HOSTNAME_CERTIFICATE_PASSWORD$suffix"
            "TF_VAR_turso_database_name"                       = "TF_VAR_TURSO_DATABASE_NAME$suffix"
            "TF_VAR_turso_database_group"                      = "TF_VAR_TURSO_DATABASE_GROUP$suffix"
            "TF_VAR_turso_database_token_expiration"           = "TF_VAR_TURSO_DATABASE_TOKEN_EXPIRATION$suffix"
            "TF_VAR_turso_database_size_limit"                 = "TF_VAR_TURSO_DATABASE_SIZE_LIMIT$suffix"
        }
        foreach ($target in $envSpecific.Keys) {
            $src = [System.Environment]::GetEnvironmentVariable($envSpecific[$target], "Process")
            if (-not [string]::IsNullOrWhiteSpace($src)) {
                [System.Environment]::SetEnvironmentVariable($target, $src, "Process")
            }
        }

        Set-TerraformListEnvVar -Name "TF_VAR_api_management_allowed_origins" -SourceNames @(
            "TF_VAR_api_management_allowed_origins",
            "TF_VAR_API_MANAGEMENT_ALLOWED_ORIGINS$suffix"
        )

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

        Set-TursoPlatformApiTokenForEnvironment -Environment $Env
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
        $tursoApiTokenVarNames = @("TF_VAR_turso_api_token")
        $map = [ordered]@{
            cloudflare_api_token                    = @("TF_VAR_cloudflare_api_token", "TF_VAR_CLOUDFLARE_API_TOKEN")
            cloudflare_analytics_api_token          = @("TF_VAR_cloudflare_analytics_api_token", "TF_VAR_CLOUDFLARE_ANALYTICS_API_TOKEN", "ANALYTICS_CF_TOKEN")
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
            api_custom_hostname                     = @("TF_VAR_api_custom_hostname")
            workspace_url                           = @("TF_VAR_workspace_url")
            api_custom_hostname_certificate_base64  = @("TF_VAR_api_custom_hostname_certificate_base64")
            api_custom_hostname_certificate_password = @("TF_VAR_api_custom_hostname_certificate_password")
            turso_api_token                         = $tursoApiTokenVarNames
            turso_organization                      = @("TF_VAR_turso_organization", "TF_VAR_TURSO_ORGANIZATION")
            turso_database_name                     = @("TF_VAR_turso_database_name")
            turso_database_group                    = @("TF_VAR_turso_database_group")
            turso_database_token_expiration         = @("TF_VAR_turso_database_token_expiration")
            turso_database_size_limit               = @("TF_VAR_turso_database_size_limit")
        }
    }

    $varList = New-Object System.Collections.Generic.List[string]
    foreach ($tfVarName in $map.Keys) {
        $value = Get-FirstEnvValue -Names $map[$tfVarName]
        if (-not [string]::IsNullOrWhiteSpace($value)) {
            $varList.Add('-var=' + $tfVarName + '=' + $value)
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

function Expand-ResourceList {
    param([string[]]$Values)

    $expanded = New-Object System.Collections.Generic.List[string]
    foreach ($value in $Values) {
        if ([string]::IsNullOrWhiteSpace($value)) {
            continue
        }

        foreach ($part in ($value -split ',')) {
            $trimmed = $part.Trim()
            if (-not [string]::IsNullOrWhiteSpace($trimmed)) {
                [void]$expanded.Add($trimmed)
            }
        }
    }

    return $expanded.ToArray()
}

function Remove-StaleAzureState {
    param([string]$Env)

    if ($Env -ne "staging" -and $Env -ne "production") {
        return
    }

    Write-Host "DEBUG: Checking terraform state for stale Azure resources..." -ForegroundColor DarkGray

    $stateListOutput = & terraform state list 2>$null
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace(($stateListOutput | Out-String))) {
        Write-Host "DEBUG: No readable terraform state list; skipping stale Azure cleanup." -ForegroundColor DarkGray
        return
    }

    $stateEntries = @($stateListOutput | ForEach-Object { $_.Trim() } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    $staleAzureEntries = $stateEntries | Where-Object {
        $_ -match '^azurerm_' -or
        $_ -match '^data\.azurerm_' -or
        $_ -match '^module\.azure_editorial_api(\.|$)' -or
        $_ -match '\.azurerm_'
    }

    if (-not $staleAzureEntries -or $staleAzureEntries.Count -eq 0) {
        Write-Host "DEBUG: No stale Azure resources found in terraform state." -ForegroundColor DarkGray
        return
    }

    Write-Warning "Removing stale Azure resources from terraform state to avoid azurerm provider errors..."
    foreach ($address in $staleAzureEntries) {
        Write-Host "DEBUG: terraform state rm $address" -ForegroundColor DarkGray
        & terraform state rm $address 1>$null
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to remove stale Azure state entry: $address"
        }
    }

    Write-Host "DEBUG: Removed $($staleAzureEntries.Count) stale Azure state entries." -ForegroundColor DarkGray
}

function Get-TerraformOutputRawForEnvSync {
    param([string]$Name)

    $rawOutput = & terraform output -raw $Name 2>$null
    $exitCode = $LASTEXITCODE
    if ($null -eq $exitCode) {
        $exitCode = if ($?) { 0 } else { 1 }
    }

    if ($exitCode -ne 0) {
        return $null
    }

    if ([string]::IsNullOrWhiteSpace($rawOutput)) {
        return $null
    }

    return [string]$rawOutput.Trim()
}

function Sync-Auth0LoginAppEnvFromState {
    param(
        [string]$Env,
        [string]$RepoRoot
    )

    if ($Env -ne "staging" -and $Env -ne "production") {
        return
    }

    $clientId = Get-TerraformOutputRawForEnvSync -Name "auth0_app_client_id"
    if ([string]::IsNullOrWhiteSpace($clientId)) {
        Write-Warning "Skipping Auth0 env sync: terraform output 'auth0_app_client_id' is missing or unreadable."
        return
    }

    $clientSecret = Get-TerraformOutputRawForEnvSync -Name "auth0_app_client_secret"
    if ([string]::IsNullOrWhiteSpace($clientSecret)) {
        Write-Warning "Skipping Auth0 env sync: terraform output 'auth0_app_client_secret' is missing or unreadable."
        return
    }

    $suffix = if ($Env -eq "staging") { "STAGING" } else { "PRODUCTION" }
    $envFilePath = Join-Path $RepoRoot ".env.dev"

    Set-Or-AddEnvFileValue -Path $envFilePath -Key "AUTH0_LOGIN_APP_CLIENT_ID_$suffix" -Value $clientId
    Set-Or-AddEnvFileValue -Path $envFilePath -Key "AUTH0_LOGIN_APP_CLIENT_SECRET_$suffix" -Value $clientSecret

    Write-Host "Synced AUTH0_LOGIN_APP_CLIENT_ID_$suffix and AUTH0_LOGIN_APP_CLIENT_SECRET_$suffix to .env.dev from terraform outputs." -ForegroundColor DarkGray
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
if ($SkipTursoPreflight) {
    $preflightArgs["SkipTursoPreflight"] = $true
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

if ($requiresEnvironmentLock) {
    Enter-TerraformEnvironmentLock -Environment $Environment -Operation $Operation -RepoRoot $repoRoot -CallerInfo $environmentLockCaller
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
        $targetArgs = @()
        $targets = Expand-ResourceList -Values $Target
        if ($targets) {
            foreach ($resource in $targets) {
                if (-not [string]::IsNullOrWhiteSpace($resource)) {
                    $targetArgs += "-target=$resource"
                }
            }
        }
        $replaceArgs = @()
        $replacements = Expand-ResourceList -Values $Replace
        if ($replacements) {
            foreach ($resource in $replacements) {
                if (-not [string]::IsNullOrWhiteSpace($resource)) {
                    $replaceArgs += "-replace=$resource"
                }
            }
        }
        $planArgs = @("plan", "-input=false", "-lock-timeout=$LockTimeout", "-no-color", "-out=$PlanFile") + $targetArgs + $replaceArgs + $varArgs
        $exitCode = Invoke-TerraformCommand -CommandArgs $planArgs
        exit $exitCode
    }

    if ($Operation -eq "apply") {
        Write-Host "DEBUG: Running apply operation, AutoApprove=$AutoApprove, PlanFile=$PlanFile, UsePlanFile=$UsePlanFile" -ForegroundColor DarkGray
        Remove-StaleAzureState -Env $Environment
        if ($UsePlanFile) {
            if (-not (Test-Path $PlanFile)) {
                throw "Plan file '$PlanFile' not found. Run plan first or remove -UsePlanFile for direct apply."
            }
            Write-Host "DEBUG: Plan file exists, running safety guards before apply" -ForegroundColor DarkGray
            $guardTursoScript = Join-Path $repoRoot "scripts/terraform-plan-guard-turso.ps1"
            $guardWorkerSecretsScript = Join-Path $repoRoot "scripts/terraform-plan-guard-worker-secrets.ps1"
            if (Test-Path $guardTursoScript) {
                & $guardTursoScript -Environment $Environment -PlanFile $PlanFile
                if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
            }
            if (Test-Path $guardWorkerSecretsScript) {
                & $guardWorkerSecretsScript -Environment $Environment -PlanFile $PlanFile
                if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
            }
            Write-Host "DEBUG: Applying from saved plan" -ForegroundColor DarkGray
            $exitCode = Invoke-TerraformCommand -CommandArgs @("apply", "-input=false", "-lock-timeout=$LockTimeout", "-no-color", $PlanFile)
            exit $exitCode
        }

        if ($AutoApprove) {
            Write-Host "DEBUG: AutoApprove enabled, running apply with $($varArgs.Count) var args" -ForegroundColor DarkGray
            $targetArgs = @()
            $targets = Expand-ResourceList -Values $Target
            if ($targets) {
                foreach ($resource in $targets) {
                    if (-not [string]::IsNullOrWhiteSpace($resource)) {
                        $targetArgs += "-target=$resource"
                    }
                }
            }
            $replaceArgs = @()
            $replacements = Expand-ResourceList -Values $Replace
            if ($replacements) {
                foreach ($resource in $replacements) {
                    if (-not [string]::IsNullOrWhiteSpace($resource)) {
                        $replaceArgs += "-replace=$resource"
                    }
                }
            }
            $applyArgs = @("apply", "-input=false", "-lock-timeout=$LockTimeout", "-no-color", "-auto-approve") + $targetArgs + $replaceArgs + $varArgs
            Write-Host "DEBUG: applyArgs count: $($applyArgs.Count)" -ForegroundColor DarkGray
            $exitCode = Invoke-TerraformCommand -CommandArgs $applyArgs
            if ($exitCode -eq 0 -and ($Environment -eq "staging" -or $Environment -eq "production")) {
                Sync-Auth0LoginAppEnvFromState -Env $Environment -RepoRoot $repoRoot
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

        $targetArgs = @()
        $targets = Expand-ResourceList -Values $Target
        if ($targets) {
            foreach ($resource in $targets) {
                if (-not [string]::IsNullOrWhiteSpace($resource)) {
                    $targetArgs += "-target=$resource"
                }
            }
        }

        $destroyArgs = @("destroy", "-input=false", "-lock-timeout=$LockTimeout", "-no-color", "-auto-approve") + $targetArgs + $varArgs
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
    if ($requiresEnvironmentLock) {
        Exit-TerraformEnvironmentLock
    }
    Pop-Location
}
