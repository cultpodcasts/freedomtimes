# Cloud Agent deploy guards (Cloudflare token stub, production rollback match).
# Run: pwsh -NoProfile -File ./scripts/test-deploy-cloud-agent-guards.ps1
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

. "$PSScriptRoot/Deploy-EnvironmentCommon.ps1"
. "$PSScriptRoot/resolve-turso-build-credentials.ps1"
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

    $env:CLOUDFLARE_API_TOKEN = "F" * 31
    $env:TF_VAR_CLOUDFLARE_API_TOKEN = ""
    $previousBase = $script:DeployBaseEnvPath
    $tmpRoot = $env:TMPDIR
    if ([string]::IsNullOrWhiteSpace($tmpRoot)) { $tmpRoot = "/tmp" }
    $emptyEnv = Join-Path $tmpRoot "empty-cloudflare.env"
    Set-Content -LiteralPath $emptyEnv -Value ""
    $script:DeployBaseEnvPath = $emptyEnv
    $ensureThrew = $false
    try {
        Ensure-DeployCloudflareWranglerAuthFromEnv
    }
    catch {
        $ensureThrew = $true
    }
    finally {
        $script:DeployBaseEnvPath = $previousBase
        Remove-Item -LiteralPath $emptyEnv -Force -ErrorAction SilentlyContinue
    }
    Assert-True $ensureThrew "throws when process token is a stub and TF_VAR is missing"
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

Write-Host "=== Select-StagingEmdashTursoUrl ignores process production shadow ==="
$prodUrl = "libsql://example-emdash-production-abc123.aws-eu-west-1.turso.io"
$stagingUrl = "libsql://example-emdash-staging-abc123.aws-eu-west-1.turso.io"
$selected = Select-StagingEmdashTursoUrl -TerraformUrl "" -ProcessUrl $prodUrl -FileUrl $stagingUrl -ProductionHint $prodUrl
Assert-True ($selected.Value -eq $stagingUrl) "uses .env.dev staging URL when process URL is production"
Assert-True ($selected.IgnoredProcessProductionShadow -eq $true) "flags process production shadow"
Assert-True ($selected.Source -match "\.env\.dev") "source is .env.dev"

$tfSelected = Select-StagingEmdashTursoUrl -TerraformUrl $stagingUrl -ProcessUrl $prodUrl -FileUrl $prodUrl -ProductionHint $prodUrl
Assert-True ($tfSelected.Value -eq $stagingUrl) "prefers terraform staging URL over process production"
Assert-True ($tfSelected.IgnoredProcessProductionShadow -eq $true) "flags process production shadow even when terraform URL wins"

$noHint = Select-StagingEmdashTursoUrl -TerraformUrl "" -ProcessUrl $prodUrl -FileUrl $stagingUrl -ProductionHint ""
Assert-True ($noHint.Value -eq $stagingUrl) "skips process production URL when TURSO_PRODUCTION_EMDASH_DB_URL is unset"
Assert-True ($noHint.IgnoredProcessProductionShadow -eq $true) "flags process production shadow without a production hint"

$tokenAfterTfUrl = Select-StagingEmdashTursoToken -TerraformToken "" -ProcessToken "process-prod-jwt" -FileToken "file-staging-jwt" -IgnoredProcessProductionShadow $true
Assert-True ($tokenAfterTfUrl.Value -eq "file-staging-jwt") "with terraform URL and empty terraform token, uses .env.dev token not process JWT"

$tfUrlProdThrew = $false
try {
    Select-StagingEmdashTursoUrl -TerraformUrl $prodUrl -ProcessUrl $prodUrl -FileUrl $stagingUrl -ProductionHint $prodUrl | Out-Null
}
catch {
    $tfUrlProdThrew = $true
}
Assert-True $tfUrlProdThrew "refuses terraform URL that is production EmDash"

$threw = $false
try {
    Select-StagingEmdashTursoUrl -TerraformUrl "" -ProcessUrl $prodUrl -FileUrl $prodUrl -ProductionHint $prodUrl | Out-Null
}
catch {
    $threw = $true
}
Assert-True $threw "refuses when process and file URLs are both production"

$processStaging = Select-StagingEmdashTursoUrl -TerraformUrl "" -ProcessUrl $stagingUrl -FileUrl $prodUrl -ProductionHint $prodUrl
Assert-True ($processStaging.Value -eq $stagingUrl) "uses process URL when it is staging"
Assert-True ($processStaging.IgnoredProcessProductionShadow -eq $false) "does not flag a staging process URL as a production shadow"

$tokenSkip = Select-StagingEmdashTursoToken -TerraformToken "" -ProcessToken "process-prod-jwt" -FileToken "file-staging-jwt" -IgnoredProcessProductionShadow $true
Assert-True ($tokenSkip.Value -eq "file-staging-jwt") "skips process TURSO_AUTH_TOKEN when URL was a production shadow"

$tokenKeep = Select-StagingEmdashTursoToken -TerraformToken "" -ProcessToken "process-staging-jwt" -FileToken "file-staging-jwt" -IgnoredProcessProductionShadow $false
Assert-True ($tokenKeep.Value -eq "process-staging-jwt") "keeps process TURSO_AUTH_TOKEN when URL was not a production shadow"

Write-Host "=== Test-DeployTerraformPluginCacheMismatch ==="
Assert-True (Test-DeployTerraformPluginCacheMismatch -Output @("Required plugins are not installed")) "detects missing plugins"
Assert-True (Test-DeployTerraformPluginCacheMismatch -Output @("the cached package for registry.terraform.io/cloudflare/cloudflare 5.22.0 (in .terraform/providers) does not match any of the checksums recorded in the dependency lock file")) "detects lockfile checksum mismatch"
Assert-True (-not (Test-DeployTerraformPluginCacheMismatch -Output @("Apply complete! Resources: 0 added, 1 changed, 0 destroyed."))) "does not treat a successful apply as a cache mismatch"

Write-Host "=== Get-DeployRollbackMetadataFreshnessUtc prefers createdAtUtc and ignores epoch mtime ==="
$tmpRoot = $env:TMPDIR
if ([string]::IsNullOrWhiteSpace($tmpRoot)) { $tmpRoot = "/tmp" }
$metaPath = Join-Path $tmpRoot "rollback-freshness-test.json"
Set-Content -LiteralPath $metaPath -Value '{"createdAtUtc":"2026-09-01T12:00:00Z","sourceDatabase":"example-emdash-production"}'
$metaFile = Get-Item -LiteralPath $metaPath
$metaFile.LastWriteTimeUtc = [datetime]::SpecifyKind([datetime]"1970-01-01T00:00:00", "Utc")
$metaObj = Get-Content -LiteralPath $metaPath -Raw | ConvertFrom-Json
$freshAt = Get-DeployRollbackMetadataFreshnessUtc -File $metaFile -Meta $metaObj
Assert-True ($freshAt.Year -eq 2026) "uses JSON createdAtUtc instead of Unix-epoch file mtime"
$epochOnly = Get-DeployRollbackMetadataFreshnessUtc -File $metaFile -Meta ([pscustomobject]@{})
Assert-True ($epochOnly -eq [datetime]::MinValue) "epoch mtime without createdAtUtc is not a fresh checkpoint"
Remove-Item -LiteralPath $metaPath -Force -ErrorAction SilentlyContinue

if (-not $IsWindows) {
    Write-Host "=== Initialize-LinuxNvmNodePath prepends nvm 22.22.2 ==="
    $tmpRoot = $env:TMPDIR
    if ([string]::IsNullOrWhiteSpace($tmpRoot)) {
        $tmpRoot = "/tmp"
    }
    $tmp = Join-Path $tmpRoot "nvm-deploy-guard-test"
    $bin = Join-Path $tmp "versions/node/v22.22.2/bin"
    New-Item -ItemType Directory -Force -Path $bin | Out-Null
    Set-Content -LiteralPath (Join-Path $bin "node") -Value ""
    $prevNvm = $env:NVM_DIR
    $prevPath = $env:PATH
    try {
        $env:NVM_DIR = $tmp
        $env:PATH = "/exec-daemon:/usr/bin"
        Initialize-LinuxNvmNodePath
        $prefix = $bin + [IO.Path]::PathSeparator
        Assert-True ($env:PATH.StartsWith($prefix, [StringComparison]::Ordinal)) "prepends nvm 22.22.2 bin ahead of /exec-daemon"
    }
    finally {
        if ($null -eq $prevNvm) { Remove-Item Env:NVM_DIR -ErrorAction SilentlyContinue } else { $env:NVM_DIR = $prevNvm }
        $env:PATH = $prevPath
        Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Write-Host "=== Test-DeployProductionWorkerSecretOverlayPresent ==="
$overlayTmp = Join-Path ([IO.Path]::GetTempPath()) ("prod-overlay-" + [guid]::NewGuid().ToString("n"))
New-Item -ItemType Directory -Force -Path $overlayTmp | Out-Null
try {
    Assert-True (-not (Test-DeployProductionWorkerSecretOverlayPresent -RepoRoot $overlayTmp)) "missing .env.production is absent"
    Set-Content -LiteralPath (Join-Path $overlayTmp ".env.production") -Value ""
    Assert-True (Test-DeployProductionWorkerSecretOverlayPresent -RepoRoot $overlayTmp) "present .env.production is detected"
}
finally {
    Remove-Item -LiteralPath $overlayTmp -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "passed=$script:Passed failed=$script:Failed"
if ($script:Failed -gt 0) {
    exit 1
}
exit 0
