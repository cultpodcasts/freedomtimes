
[CmdletBinding()]
param()

function Invoke-FunctionDeploy {
    param([string]$FunctionAppName)

    Write-Step "Building production Function App from TypeScript sources"
    Push-Location (Join-Path $repoRoot "functions/editorial-api")
    try {
        & npm run build
        if ($LASTEXITCODE -ne 0) {
            throw "Function App TypeScript build failed."
        }

        Write-Step "Deploying production Function App code (remote build)"
        & func azure functionapp publish $FunctionAppName --javascript --build remote
        if ($LASTEXITCODE -ne 0) {
            throw "Function App deploy failed."
        }
    }
    finally {
        Pop-Location
    }
}

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path $PSScriptRoot -Parent
$terraformRunScript = Join-Path $PSScriptRoot "terraform-run.ps1"
$secretSyncScript = Join-Path $PSScriptRoot "set-github-secrets.ps1"
$productionEnvDir = Join-Path $repoRoot "infra/terraform/environments/production"
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
    Write-Step "Applying production Terraform (attempt 1)"
    $apply1 = Invoke-ChildPwsh -CaptureOutput -Arguments @(
        "-File", $terraformRunScript,
        "-Environment", "production",
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
        "-Environment", "production",
        "-Operation", "import",
        "-LoadEnvFiles",
        "-ImportAddress", "azurerm_api_management_custom_domain.editorial[0]",
        "-ImportId", $customDomainImportId
    )
    $importResult.Output | ForEach-Object { $_ }
    if ($importResult.ExitCode -ne 0) {
        throw "Terraform import for APIM custom-domain failed."
    }
    Write-Step "Re-running production Terraform apply (attempt 2 after import)"
    $apply2 = Invoke-ChildPwsh -CaptureOutput -Arguments @(
        "-File", $terraformRunScript,
        "-Environment", "production",
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
    Push-Location $productionEnvDir
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
    Write-Step "Verifying Terraform-synced Auth0 production credentials in .env.dev"
    $prodClientIdInEnv = Get-EnvFileValue -Path $baseEnvPath -Key "AUTH0_LOGIN_APP_CLIENT_ID_PRODUCTION"
    $prodClientSecretInEnv = Get-EnvFileValue -Path $baseEnvPath -Key "AUTH0_LOGIN_APP_CLIENT_SECRET_PRODUCTION"
    if ([string]::IsNullOrWhiteSpace($prodClientIdInEnv)) {
        throw "Missing AUTH0_LOGIN_APP_CLIENT_ID_PRODUCTION in .env.dev after Terraform apply."
    }
    if ([string]::IsNullOrWhiteSpace($prodClientSecretInEnv)) {
        throw "Missing AUTH0_LOGIN_APP_CLIENT_SECRET_PRODUCTION in .env.dev after Terraform apply."
    }
    $terraformClientId = Get-TerraformOutputRaw -Name "auth0_app_client_id"
    if ($prodClientIdInEnv -ne $terraformClientId) {
        throw "AUTH0_LOGIN_APP_CLIENT_ID_PRODUCTION in .env.dev does not match Terraform output auth0_app_client_id."
    }
}

function Invoke-SecretSync {
    Write-Step "Syncing Cloudflare Worker secrets for production"
    $result = Invoke-ChildPwsh -CaptureOutput -Arguments @(
        "-File", $secretSyncScript,
        "-Target", "Production",
        "-SyncCloudflareWorkerSecrets",
        "-AllowProduction"
    )
    if ($result.ExitCode -ne 0) {
        throw "Cloudflare Worker secret sync failed."
    }
}

function Invoke-WorkerDeploy {
    Write-Step "Deploying production Worker"
    Push-Location $repoRoot
    try {
        & npx wrangler deploy --config .\web\wrangler.jsonc --env production
        if ($LASTEXITCODE -ne 0) {
            throw "Wrangler worker deploy failed."
        }
    }
    finally {
        Pop-Location
    }
}

function Invoke-WorkerBuild {
    Write-Step "Building production Worker"

    # Set build-time env vars required by astro.config.ts from Terraform outputs
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

Write-Step "Starting local production rebuild workflow"
Invoke-TerraformApplyWithRecovery

# Update .env.dev with latest Auth0 values from Terraform outputs
$prodClientId = Get-TerraformOutputRaw -Name "auth0_app_client_id"
$prodClientSecret = Get-TerraformOutputRaw -Name "auth0_app_client_secret"

# Update .env.dev in place
(Get-Content $baseEnvPath) |
    ForEach-Object {
        if ($_ -match "^AUTH0_LOGIN_APP_CLIENT_ID_PRODUCTION=") {
            "AUTH0_LOGIN_APP_CLIENT_ID_PRODUCTION=$prodClientId"
        } elseif ($_ -match "^AUTH0_LOGIN_APP_CLIENT_SECRET_PRODUCTION=") {
            "AUTH0_LOGIN_APP_CLIENT_SECRET_PRODUCTION=$prodClientSecret"
        } else {
            $_
        }
    } | Set-Content $baseEnvPath

Assert-Auth0SyncToEnv
Invoke-SecretSync
Invoke-WorkerBuild
Invoke-WorkerDeploy

# Deploy Function App code to production
$functionAppName = Get-TerraformOutputRaw -Name "azure_function_app_name"
Invoke-FunctionDeploy -FunctionAppName $functionAppName

Write-Step "Production rebuild complete"
Write-Host "Function App: $functionAppName"
Write-Host "Worker: $(Get-TerraformOutputRaw -Name 'worker_name')"
