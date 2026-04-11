[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path $PSScriptRoot -Parent
$terraformRunScript = Join-Path $PSScriptRoot "terraform-run.ps1"
$secretSyncScript = Join-Path $PSScriptRoot "set-github-secrets.ps1"
$stagingEnvDir = Join-Path $repoRoot "infra/terraform/environments/staging"
$baseEnvPath = Join-Path $repoRoot ".env.dev"

function Write-Step {
    param([string]$Message)

    $timestamp = Get-Date -Format "yyyy-MM-ddTHH:mm:ssK"
    Write-Host "[$timestamp] $Message" -ForegroundColor Cyan
}

function Invoke-ChildPwsh {
    param(
        [string[]]$Arguments,
        [string]$WorkingDirectory = $repoRoot,
        [switch]$CaptureOutput
    )

    Push-Location $WorkingDirectory
    try {
        if ($CaptureOutput) {
            $lines = & pwsh -NoProfile @Arguments 2>&1
            $exitCode = $LASTEXITCODE
            return [pscustomobject]@{ ExitCode = $exitCode; Output = @($lines) }
        }

        & pwsh -NoProfile @Arguments
        return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = @() }
    }
    finally {
        Pop-Location
    }
}

function Invoke-TerraformApplyWithRecovery {
    Write-Step "Applying staging Terraform (attempt 1)"
    $apply1 = Invoke-ChildPwsh -CaptureOutput -Arguments @(
        "-File", $terraformRunScript,
        "-Environment", "staging",
        "-Operation", "apply",
        "-LoadEnvFiles",
        "-AutoApprove"
    )

    $apply1.Output | ForEach-Object { $_ }

    if ($apply1.ExitCode -eq 0) {
        Write-Step "Terraform apply succeeded on first attempt"
        return
    }

    $combined = ($apply1.Output -join "`n")
    $importNeeded = $combined -match "azurerm_api_management_custom_domain" -and $combined -match "already exists - to be managed via Terraform"

    if (-not $importNeeded) {
        throw "Terraform apply failed and did not match the APIM custom-domain import recovery path."
    }

    $apimIdMatch = [regex]::Match($combined, '/subscriptions/[^\s"]+/providers/Microsoft\.ApiManagement/service/[^\s"]+')
    if (-not $apimIdMatch.Success) {
        throw "Terraform apply indicated custom-domain import is needed, but APIM service ID was not found in output."
    }

    $apimId = $apimIdMatch.Value
    $customDomainImportId = "$apimId/customDomains/default"

    Write-Step "Importing existing APIM custom-domain resource into Terraform state"
    $importResult = Invoke-ChildPwsh -CaptureOutput -Arguments @(
        "-File", $terraformRunScript,
        "-Environment", "staging",
        "-Operation", "import",
        "-LoadEnvFiles",
        "-ImportAddress", "azurerm_api_management_custom_domain.editorial[0]",
        "-ImportId", $customDomainImportId
    )

    $importResult.Output | ForEach-Object { $_ }

    if ($importResult.ExitCode -ne 0) {
        throw "Terraform import for APIM custom-domain failed."
    }

    Write-Step "Re-running staging Terraform apply (attempt 2 after import)"
    $apply2 = Invoke-ChildPwsh -CaptureOutput -Arguments @(
        "-File", $terraformRunScript,
        "-Environment", "staging",
        "-Operation", "apply",
        "-LoadEnvFiles",
        "-AutoApprove"
    )

    $apply2.Output | ForEach-Object { $_ }

    if ($apply2.ExitCode -ne 0) {
        throw "Terraform apply failed after APIM custom-domain import recovery."
    }

    Write-Step "Terraform apply succeeded after APIM import recovery"
}

function Get-TerraformOutputRaw {
    param([string]$Name)

    Push-Location $stagingEnvDir
    try {
        $value = (& terraform output -raw $Name).Trim()
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($value)) {
            throw "Failed to read terraform output '$Name'."
        }
        return $value
    }
    finally {
        Pop-Location
    }
}

function Get-EnvFileValue {
    param(
        [string]$Path,
        [string]$Key
    )

    if (-not (Test-Path $Path)) {
        return ""
    }

    $line = Get-Content $Path | Where-Object { $_ -match "^$([regex]::Escape($Key))=" } | Select-Object -First 1
    if ([string]::IsNullOrWhiteSpace($line)) {
        return ""
    }

    return ($line -split '=', 2)[1].Trim()
}

function Assert-Auth0SyncToEnv {
    Write-Step "Verifying Terraform-synced Auth0 staging credentials in .env.dev"

    $stagingClientIdInEnv = Get-EnvFileValue -Path $baseEnvPath -Key "AUTH0_LOGIN_APP_CLIENT_ID_STAGING"
    $stagingClientSecretInEnv = Get-EnvFileValue -Path $baseEnvPath -Key "AUTH0_LOGIN_APP_CLIENT_SECRET_STAGING"

    if ([string]::IsNullOrWhiteSpace($stagingClientIdInEnv)) {
        throw "Missing AUTH0_LOGIN_APP_CLIENT_ID_STAGING in .env.dev after Terraform apply."
    }

    if ([string]::IsNullOrWhiteSpace($stagingClientSecretInEnv)) {
        throw "Missing AUTH0_LOGIN_APP_CLIENT_SECRET_STAGING in .env.dev after Terraform apply."
    }

    $terraformClientId = Get-TerraformOutputRaw -Name "auth0_app_client_id"
    if ($stagingClientIdInEnv -ne $terraformClientId) {
        throw "AUTH0_LOGIN_APP_CLIENT_ID_STAGING in .env.dev does not match Terraform output auth0_app_client_id."
    }
}

function Invoke-SecretSync {
    Write-Step "Syncing Cloudflare Worker secrets for staging"

    # Ensure CLOUDFLARE_ACCOUNT_ID is set so wrangler can run non-interactively
    if (-not $env:CLOUDFLARE_ACCOUNT_ID) {
        $accountId = Get-EnvFileValue -Path $baseEnvPath -Key "TF_VAR_CLOUDFLARE_ACCOUNT_ID"
        if ($accountId) {
            $env:CLOUDFLARE_ACCOUNT_ID = $accountId
        }
    }

    $result = Invoke-ChildPwsh -CaptureOutput -Arguments @(
        "-File", $secretSyncScript,
        "-Target", "Staging",
        "-SyncCloudflareWorkerSecrets"
    )

    $result.Output | ForEach-Object { $_ }

    if ($result.ExitCode -ne 0) {
        throw "Cloudflare Worker secret sync failed."
    }
}

function Invoke-WorkerBuild {
    Write-Step "Building staging Worker"

    # Set build-time env vars required by astro.config.mjs from Terraform outputs
    $env:TURSO_DATABASE_URL = Get-TerraformOutputRaw -Name "turso_database_url"
    $env:TURSO_AUTH_TOKEN   = Get-TerraformOutputRaw -Name "turso_database_auth_token"

    Push-Location (Join-Path $repoRoot "web")
    try {
        & npm run build
        if ($LASTEXITCODE -ne 0) {
            throw "Worker build failed."
        }
    }
    finally {
        Pop-Location
    }
}

function Invoke-WorkerDeploy {
    Write-Step "Deploying staging Worker"
    Push-Location $repoRoot
    try {
        & npx wrangler deploy --config .\web\wrangler.jsonc --env staging
        if ($LASTEXITCODE -ne 0) {
            throw "Wrangler worker deploy failed."
        }
    }
    finally {
        Pop-Location
    }
}

function Invoke-FunctionDeploy {
    param([string]$FunctionAppName)

    Write-Step "Building staging Function App from TypeScript sources"
    Push-Location (Join-Path $repoRoot "functions/editorial-api")
    try {
        & npm run build
        if ($LASTEXITCODE -ne 0) {
            throw "Function App TypeScript build failed."
        }

        Write-Step "Deploying staging Function App code (local build artifact)"
        & func azure functionapp publish $FunctionAppName --javascript --build local
        if ($LASTEXITCODE -ne 0) {
            throw "Function App deploy failed."
        }
    }
    finally {
        Pop-Location
    }
}

function Invoke-Verification {
    param([string]$FunctionAppName)

    Write-Step "Verifying staging Worker secrets"
    Push-Location $repoRoot
    try {
        $secretOutput = & npx wrangler secret list --config .\web\wrangler.jsonc --env staging
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to list staging worker secrets."
        }

        $requiredSecrets = @("AUTH0_DOMAIN", "AUTH0_CLIENT_ID", "AUTH0_CLIENT_SECRET", "EMDASH_AUTH_SECRET", "EMDASH_PREVIEW_SECRET")
        foreach ($secretName in $requiredSecrets) {
            if (-not ($secretOutput -match $secretName)) {
                throw "Expected worker secret '$secretName' was not found."
            }
        }
    }
    finally {
        Pop-Location
    }

    Write-Step "Verifying staging Function triggers"
    $functions = & az functionapp function list --name $FunctionAppName --resource-group freedomtimes-staging-rg --query "[].name" -o tsv
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to query Function App triggers."
    }

    if ([string]::IsNullOrWhiteSpace(($functions -join ""))) {
        throw "Function App reports no discovered functions after deploy."
    }

    Write-Host $functions
}

Write-Step "Starting local staging rebuild workflow"
Invoke-TerraformApplyWithRecovery
Assert-Auth0SyncToEnv

$functionAppName = Get-TerraformOutputRaw -Name "azure_function_app_name"
$apiBaseUrl = Get-TerraformOutputRaw -Name "azure_editorial_api_public_base_url"
$workerName = Get-TerraformOutputRaw -Name "worker_name"

Invoke-SecretSync
Invoke-WorkerBuild
Invoke-WorkerDeploy
Invoke-FunctionDeploy -FunctionAppName $functionAppName
Invoke-Verification -FunctionAppName $functionAppName

Write-Step "Staging rebuild complete"
Write-Host "Function App: $functionAppName"
Write-Host "Worker: $workerName"
Write-Host "API Base URL: $apiBaseUrl"
