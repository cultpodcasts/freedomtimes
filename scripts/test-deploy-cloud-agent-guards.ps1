# Cloud Agent deploy guards (Cloudflare token stub, production rollback match).
# Run: pwsh -NoProfile -File ./scripts/test-deploy-cloud-agent-guards.ps1
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

. "$PSScriptRoot/Deploy-EnvironmentCommon.ps1"
Initialize-DeployEnvironment -Environment production

$script:Failed = 0
$script:Passed = 0

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if ($Condition) {
        $script:Passed++
        Write-Host "ok  $Message"
    }
    else {
        $script:Failed++
        Write-Host "FAIL  $Message" -ForegroundColor Red
    }
}

Write-Host "=== Test-DeployCloudflareApiTokenPlausible ==="
Assert-True (-not (Test-DeployCloudflareApiTokenPlausible -Token "")) "empty token is implausible"
Assert-True (-not (Test-DeployCloudflareApiTokenPlausible -Token ("F" * 31))) "31-char stub is implausible"
Assert-True (-not (Test-DeployCloudflareApiTokenPlausible -Token (("c" * 20) + " " + ("d" * 20)))) "whitespace is implausible"
Assert-True (Test-DeployCloudflareApiTokenPlausible -Token ("c" * 40)) "40-char token is plausible"
Assert-True (Test-DeployCloudflareApiTokenPlausible -Token ("c" * 53)) "53-char token is plausible"

Write-Host "=== Ensure-DeployCloudflareWranglerAuthFromEnv remaps stub ==="
$previousCf = [Environment]::GetEnvironmentVariable("CLOUDFLARE_API_TOKEN", "Process")
$previousTf = [Environment]::GetEnvironmentVariable("TF_VAR_CLOUDFLARE_API_TOKEN", "Process")
$previousAccount = [Environment]::GetEnvironmentVariable("CLOUDFLARE_ACCOUNT_ID", "Process")
try {
    $env:CLOUDFLARE_ACCOUNT_ID = "a" * 32
    $env:CLOUDFLARE_API_TOKEN = "F" * 31
    $env:TF_VAR_CLOUDFLARE_API_TOKEN = "c" * 53
    Ensure-DeployCloudflareWranglerAuthFromEnv
    Assert-True ($env:CLOUDFLARE_API_TOKEN -eq ("c" * 53)) "replaces short stub with TF_VAR token"

    $env:CLOUDFLARE_API_TOKEN = "d" * 53
    $env:TF_VAR_CLOUDFLARE_API_TOKEN = "c" * 53
    Ensure-DeployCloudflareWranglerAuthFromEnv
    Assert-True ($env:CLOUDFLARE_API_TOKEN -eq ("d" * 53)) "keeps a plausible process token"
}
finally {
    if ($null -eq $previousCf) { Remove-Item Env:CLOUDFLARE_API_TOKEN -ErrorAction SilentlyContinue } else { $env:CLOUDFLARE_API_TOKEN = $previousCf }
    if ($null -eq $previousTf) { Remove-Item Env:TF_VAR_CLOUDFLARE_API_TOKEN -ErrorAction SilentlyContinue } else { $env:TF_VAR_CLOUDFLARE_API_TOKEN = $previousTf }
    if ($null -eq $previousAccount) { Remove-Item Env:CLOUDFLARE_ACCOUNT_ID -ErrorAction SilentlyContinue } else { $env:CLOUDFLARE_ACCOUNT_ID = $previousAccount }
}

Write-Host "=== Test-DeployRollbackSourceMatchesProductionEmDash ==="
$exampleDb = "example-emdash-production"
$exampleUrl = "libsql://example-emdash-production-abc123.aws-eu-west-1.turso.io"
$stagingUrl = "libsql://example-emdash-staging-abc123.aws-eu-west-1.turso.io"

Assert-True (Test-DeployRollbackSourceMatchesProductionEmDash `
        -SourceDatabase $exampleDb `
        -ExpectedDatabase $exampleDb `
        -ProductionUrls @()) "matches TF_VAR database name"

Assert-True (Test-DeployRollbackSourceMatchesProductionEmDash `
        -SourceDatabase $exampleDb `
        -ExpectedDatabase "" `
        -ProductionUrls @($exampleUrl)) "matches production URL host prefix when TF_VAR is unset"

Assert-True (-not (Test-DeployRollbackSourceMatchesProductionEmDash `
            -SourceDatabase $exampleDb `
            -ExpectedDatabase "[REDACTED]-emdash-production" `
            -ProductionUrls @($stagingUrl))) "does not match a staging URL or placeholder expected name"

Assert-True (-not (Test-DeployRollbackSourceMatchesProductionEmDash `
            -SourceDatabase "[REDACTED]-emdash-production" `
            -ExpectedDatabase "" `
            -ProductionUrls @($exampleUrl))) "rejects literal redacted placeholder as sourceDatabase"

Assert-True (-not (Test-DeployRollbackSourceMatchesProductionEmDash `
            -SourceDatabase "other-emdash-production" `
            -ExpectedDatabase "" `
            -ProductionUrls @($exampleUrl))) "rejects a different production-looking name"

Write-Host ""
Write-Host "passed=$script:Passed failed=$script:Failed"
if ($script:Failed -gt 0) {
    exit 1
}
exit 0
