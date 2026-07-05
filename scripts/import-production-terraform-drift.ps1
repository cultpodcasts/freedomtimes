[CmdletBinding()]
param(
    [ValidateSet("staging", "production")]
    [string]$Environment = "production"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path $PSScriptRoot -Parent
$runScript = Join-Path $PSScriptRoot "terraform-run.ps1"

function Import-TerraformResource {
    param(
        [string]$Address,
        [string]$Id,
        [switch]$SkipTursoPreflight
    )

    Write-Host "Importing $Address <- $Id" -ForegroundColor Cyan
    $args = @{
        Environment      = $Environment
        Operation        = "import"
        LoadEnvFiles     = $true
        ImportAddress    = $Address
        ImportId         = $Id
    }
    if ($SkipTursoPreflight) {
        $args["SkipTursoPreflight"] = $true
    }
    & $runScript @args
    if ($LASTEXITCODE -ne 0) {
        throw "Import failed for $Address"
    }
}

. "$repoRoot/scripts/terraform-turso-env.ps1"

# Load env for Cloudflare API lookup (terraform-run import loads again).
$envDevPath = Join-Path $repoRoot ".env.dev"
if (-not (Test-Path $envDevPath)) {
    throw ".env.dev not found"
}

Get-Content $envDevPath | ForEach-Object {
    $line = $_.Trim()
    if ([string]::IsNullOrWhiteSpace($line) -or $line.StartsWith("#")) { return }
    if ($line -match '^[A-Za-z_][A-Za-z0-9_]*=') {
        $parts = $line -split '=', 2
        [System.Environment]::SetEnvironmentVariable($parts[0].Trim(), $parts[1].Trim(), "Process")
    }
}

Set-TursoPlatformApiTokenForEnvironment -Environment $Environment

function Get-CloudflareWorkerRouteImportId {
    param(
        [string]$ZoneId,
        [string]$Pattern,
        [string]$ScriptName,
        [string]$ApiToken
    )

    $headers = @{
        Authorization  = "Bearer $ApiToken"
        "Content-Type" = "application/json"
    }
    $uri = "https://api.cloudflare.com/client/v4/zones/$ZoneId/workers/routes"
    $response = Invoke-RestMethod -Method Get -Uri $uri -Headers $headers
    if (-not $response.success) {
        throw "Cloudflare routes API failed: $($response.errors | ConvertTo-Json -Compress)"
    }

    $match = $response.result | Where-Object { $_.pattern -eq $Pattern -and $_.script -eq $ScriptName } | Select-Object -First 1
    if ($null -eq $match) {
        throw "No worker route found for pattern '$Pattern' and script '$ScriptName'."
    }

    return "$ZoneId/$($match.id)"
}

$tursoPlatformToken = [System.Environment]::GetEnvironmentVariable("TF_VAR_turso_api_token", "Process")
$hasTursoPlatformToken = -not [string]::IsNullOrWhiteSpace($tursoPlatformToken)
if (-not $hasTursoPlatformToken) {
    Write-Warning @"
No valid Turso Platform API token in .env.dev (TURSO_PLATFORM_API_TOKEN / TF_VAR_turso_api_token).
Candidates are validated with a Turso Platform API probe (GET /v1/organizations). Database JWTs (e.g. TURSO_AUTH_TOKEN) fail that probe and are skipped. Set a Platform API token from Turso dashboard -> Settings -> API tokens, then re-run this script.
Cloudflare-only imports can proceed with -SkipTursoPreflight.
"@
}

$suffix = if ($Environment -eq "staging") { "_STAGING" } else { "_PRODUCTION" }
$org = [System.Environment]::GetEnvironmentVariable("TF_VAR_TURSO_ORGANIZATION", "Process")
if ([string]::IsNullOrWhiteSpace($org)) {
    throw "TF_VAR_TURSO_ORGANIZATION missing from .env.dev"
}

$dbNames = if ($Environment -eq "staging") {
    @{
        emdash        = "freedomtimes-emdash-staging"
        scheduler     = "freedomtimes-scheduler-staging"
        subscriptions = "freedomtimes-subscriptions-staging"
        tips          = "freedomtimes-tips-staging"
    }
}
else {
    @{
        emdash        = [System.Environment]::GetEnvironmentVariable("TF_VAR_TURSO_DATABASE_NAME_PRODUCTION", "Process")
        scheduler     = "freedomtimes-scheduler-production"
        subscriptions = "freedomtimes-subscriptions-production"
        tips          = "freedomtimes-tips-production"
    }
}

if ([string]::IsNullOrWhiteSpace($dbNames.emdash)) {
    $dbNames.emdash = "freedomtimes-emdash-production"
}

function Import-TerraformResourceIfMissing {
    param(
        [string]$Address,
        [string]$Id,
        [switch]$SkipTursoPreflight
    )

    $listed = & terraform state list 2>$null | Where-Object { $_ -eq $Address }
    if ($listed) {
        Write-Host "[skip] Already in state: $Address" -ForegroundColor DarkGray
        return
    }

    Import-TerraformResource -Address $Address -Id $Id -SkipTursoPreflight:$SkipTursoPreflight
}

function Get-TerraformStateWorkerScriptName {
    param([string]$Address)

    $show = & terraform state show $Address 2>$null
    if ($LASTEXITCODE -ne 0) {
        return $null
    }

    foreach ($line in $show) {
        if ($line -match '^\s*name\s*=\s*"([^"]+)"') {
            return $Matches[1]
        }
    }

    return $null
}

function Sync-TerraformWorkerScriptState {
    param(
        [string]$ExpectedWorkerName,
        [string]$AccountId,
        [switch]$SkipTursoPreflight
    )

    $scriptAddr = "module.cloudflare_holding_page.cloudflare_workers_script.holding_page"
    $stateName = Get-TerraformStateWorkerScriptName -Address $scriptAddr

    if ($null -eq $stateName) {
        Write-Host "Importing worker script $ExpectedWorkerName into Terraform state." -ForegroundColor Cyan
        Import-TerraformResource -Address $scriptAddr -Id $ExpectedWorkerName -SkipTursoPreflight:$SkipTursoPreflight
        return
    }

    if ($stateName -eq $ExpectedWorkerName) {
        Write-Host "Worker script state already aligned: $ExpectedWorkerName" -ForegroundColor DarkGray
        return
    }

    Write-Warning "Worker script name drift: state has '$stateName', live config expects '$ExpectedWorkerName'."
    Write-Host "Re-importing worker script as $ExpectedWorkerName (live SSR worker name after -holding rename)." -ForegroundColor Cyan
    & terraform state rm $scriptAddr
    if ($LASTEXITCODE -ne 0) {
        throw "terraform state rm failed for $scriptAddr"
    }
    Import-TerraformResource -Address $scriptAddr -Id $ExpectedWorkerName -SkipTursoPreflight:$SkipTursoPreflight
}

$accountId = [System.Environment]::GetEnvironmentVariable("TF_VAR_CLOUDFLARE_ACCOUNT_ID", "Process")
$zoneId = [System.Environment]::GetEnvironmentVariable("TF_VAR_CLOUDFLARE_ZONE_ID", "Process")
$cfToken = [System.Environment]::GetEnvironmentVariable("TF_VAR_CLOUDFLARE_API_TOKEN", "Process")
$routePattern = [System.Environment]::GetEnvironmentVariable("TF_VAR_ROUTE_PATTERN$suffix", "Process")
$workerName = [System.Environment]::GetEnvironmentVariable("TF_VAR_WORKER_NAME$suffix", "Process")

$envDir = Join-Path $repoRoot "infra/terraform/environments/$Environment"
. "$repoRoot/scripts/ensure-windows-cli-path.ps1"
Initialize-WindowsCliPath
Push-Location $envDir
try {
    Write-Host "=== Turso database imports ($Environment) ===" -ForegroundColor Yellow
    if (-not $hasTursoPlatformToken) {
    Write-Warning "Skipping Turso database imports (no Platform API token)."
}
else {
    foreach ($resource in @("emdash", "scheduler", "subscriptions", "tips")) {
        $dbName = $dbNames[$resource]
        Import-TerraformResource -Address "turso_database.$resource" -Id "$org/$dbName"
    }
}

Write-Host "=== Cloudflare worker script import ($Environment) ===" -ForegroundColor Yellow
if ([string]::IsNullOrWhiteSpace($workerName)) {
    throw "Missing TF_VAR_WORKER_NAME$suffix for worker script import."
}
Sync-TerraformWorkerScriptState -ExpectedWorkerName $workerName -AccountId $accountId -SkipTursoPreflight:(-not $hasTursoPlatformToken)

Write-Host "=== Cloudflare worker route import ($Environment) ===" -ForegroundColor Yellow
if ([string]::IsNullOrWhiteSpace($zoneId) -or [string]::IsNullOrWhiteSpace($cfToken) -or [string]::IsNullOrWhiteSpace($routePattern) -or [string]::IsNullOrWhiteSpace($workerName)) {
    throw "Missing Cloudflare route lookup vars (zone, token, pattern, worker name)."
}

$routeImportId = Get-CloudflareWorkerRouteImportId -ZoneId $zoneId -Pattern $routePattern -ScriptName $workerName -ApiToken $cfToken
Import-TerraformResourceIfMissing -Address "module.cloudflare_holding_page.cloudflare_workers_route.holding_page[0]" -Id $routeImportId -SkipTursoPreflight:(-not $hasTursoPlatformToken)

Write-Host "Import batch completed. Run terraform plan to verify remaining drift (database tokens, Turnstile worker secrets)." -ForegroundColor Green
Write-Host "Note: TURSO_DATABASE_URL / TURSO_AUTH_TOKEN are wrangler-managed — run terraform-unmanage-worker-turso-secrets.ps1 if state still tracks them." -ForegroundColor DarkGray
}
finally {
    Pop-Location
}
