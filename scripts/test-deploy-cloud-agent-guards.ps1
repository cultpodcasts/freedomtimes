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

Write-Host "=== Resolve-ProductionEmdashTursoToken: TURSO_PRODUCTION_EMDASH_DB_TOKEN only, no Terraform output (#137) ==="
$tokenCmd = Get-Command Resolve-ProductionEmdashTursoToken
Assert-True (-not $tokenCmd.Parameters.ContainsKey("TerraformExe")) "production token resolver no longer takes a Terraform executable"
$resolverText = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot "resolve-turso-build-credentials.ps1")
$prodTokenBody = [regex]::Match($resolverText, '(?s)function Resolve-ProductionEmdashTursoToken \{.*?\n\}').Value
Assert-True ($prodTokenBody -notmatch 'Try-TerraformOutputRaw') "production token resolver never reads a Terraform output"
$tursoKeysUnderTest = @("TURSO_PRODUCTION_EMDASH_DB_TOKEN", "TURSO_PRODUCTION_EMDASH_DB_URL", "TURSO_AUTH_TOKEN", "TURSO_DATABASE_URL")
$savedTursoEnv = @{}
foreach ($key in $tursoKeysUnderTest) { $savedTursoEnv[$key] = [Environment]::GetEnvironmentVariable($key, "Process") }
$clearTursoEnv = { foreach ($key in $tursoKeysUnderTest) { [Environment]::SetEnvironmentVariable($key, $null, "Process") } }
$tmpEnvRoot = $env:TMPDIR
if ([string]::IsNullOrWhiteSpace($tmpEnvRoot)) { $tmpEnvRoot = [System.IO.Path]::GetTempPath() }
$emptyEnvDev = Join-Path $tmpEnvRoot "ft-137-empty.env.dev"
Set-Content -LiteralPath $emptyEnvDev -Value "# empty"
$stagingFileEnvDev = Join-Path $tmpEnvRoot "ft-137-staging-pair.env.dev"
Set-Content -LiteralPath $stagingFileEnvDev -Value @("TURSO_DATABASE_URL=$stagingUrl", "TURSO_AUTH_TOKEN=file-staging-jwt")
$fakeRepoRoot = Join-Path $tmpEnvRoot ("ft-137-repo-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $fakeRepoRoot -Force | Out-Null
Set-Content -LiteralPath (Join-Path $fakeRepoRoot ".env.dev") -Value @(
    "TURSO_PRODUCTION_EMDASH_DB_URL=$prodUrl",
    "TURSO_DATABASE_URL=$stagingUrl",
    "TURSO_AUTH_TOKEN=file-staging-jwt"
)

function Invoke-ProductionTokenResolveCapture {
    param([scriptblock]$Action)
    try {
        $null = & $Action
        return @{ Threw = $false; Message = "" }
    }
    catch {
        return @{ Threw = $true; Message = $_.Exception.Message }
    }
}

try {
    & $clearTursoEnv
    $env:TURSO_PRODUCTION_EMDASH_DB_TOKEN = "direct-prod-jwt"
    $env:TURSO_DATABASE_URL = $prodUrl
    $env:TURSO_AUTH_TOKEN = "paired-prod-jwt"
    $direct = Resolve-ProductionEmdashTursoToken -EnvDevPath $emptyEnvDev -ResolvedUrl $prodUrl
    Assert-True ($direct.Value -eq "direct-prod-jwt" -and $direct.Source -eq "TURSO_PRODUCTION_EMDASH_DB_TOKEN") "TURSO_PRODUCTION_EMDASH_DB_TOKEN wins"

    # CA-14 true pairing: process URL is the production URL being deployed.
    $env:TURSO_PRODUCTION_EMDASH_DB_TOKEN = ""
    $paired = Resolve-ProductionEmdashTursoToken -EnvDevPath $emptyEnvDev -ResolvedUrl $prodUrl
    Assert-True ($paired.Value -eq "paired-prod-jwt") "process TURSO_AUTH_TOKEN is used when process TURSO_DATABASE_URL equals the production URL (CA-14)"

    # 1. Process token travels with a staging process URL: never borrowed for production.
    $env:TURSO_DATABASE_URL = $stagingUrl
    $env:TURSO_AUTH_TOKEN = "process-staging-jwt"
    $stagingProcess = Invoke-ProductionTokenResolveCapture { Resolve-ProductionEmdashTursoToken -EnvDevPath $emptyEnvDev -ResolvedUrl $prodUrl }
    Assert-True $stagingProcess.Threw "throws for the production URL when the process token is paired with a staging TURSO_DATABASE_URL"
    Assert-True ($stagingProcess.Message -match 'TURSO_PRODUCTION_EMDASH_DB_TOKEN' -and $stagingProcess.Message -match '#137') "missing-token error names the key and #137"
    Assert-True ($stagingProcess.Message -notmatch 'process-staging-jwt') "missing-token error does not echo the token value"

    # 2. Token only in .env.dev (staging pair), resolved directly: the file TURSO_AUTH_TOKEN is not a candidate.
    & $clearTursoEnv
    $fileOnly = Invoke-ProductionTokenResolveCapture { Resolve-ProductionEmdashTursoToken -EnvDevPath $stagingFileEnvDev -ResolvedUrl $prodUrl }
    Assert-True $fileOnly.Threw "throws for the production URL when the only token is the .env.dev staging TURSO_AUTH_TOKEN"
    Assert-True ($fileOnly.Message -notmatch 'file-staging-jwt') "file-token error does not echo the token value"

    # 2b. A process token copied from the staging .env.dev file is rejected even beside a production process URL.
    $env:TURSO_DATABASE_URL = $prodUrl
    $env:TURSO_AUTH_TOKEN = "file-staging-jwt"
    $copied = Invoke-ProductionTokenResolveCapture { Resolve-ProductionEmdashTursoToken -EnvDevPath $stagingFileEnvDev -ResolvedUrl $prodUrl }
    Assert-True $copied.Threw "rejects a process token that is the .env.dev staging TURSO_AUTH_TOKEN"

    # 2c. End to end through Set-TursoBuildEnv: .env.dev import must not supply the staging token for production.
    & $clearTursoEnv
    $endToEnd = Invoke-ProductionTokenResolveCapture { Set-TursoBuildEnv -Environment production -RepoRoot $fakeRepoRoot }
    Assert-True $endToEnd.Threw "Set-TursoBuildEnv production throws when .env.dev has only the staging TURSO_AUTH_TOKEN"
    Assert-True ($endToEnd.Message -notmatch 'file-staging-jwt') "Set-TursoBuildEnv error does not echo the token value"

    # 3. End to end with a real CA-14 process pair: the snapshot taken before the .env.dev import wins.
    & $clearTursoEnv
    $env:TURSO_DATABASE_URL = $prodUrl
    $env:TURSO_AUTH_TOKEN = "paired-prod-jwt"
    $endToEndPaired = Set-TursoBuildEnv -Environment production -RepoRoot $fakeRepoRoot
    Assert-True ($endToEndPaired.Token.Value -eq "paired-prod-jwt" -and $env:TURSO_AUTH_TOKEN -eq "paired-prod-jwt") "Set-TursoBuildEnv production uses the CA-14 process pair"
    Assert-True ($endToEndPaired.Url.Value -eq $prodUrl) "Set-TursoBuildEnv production resolves the production URL"
}
finally {
    foreach ($key in $tursoKeysUnderTest) { [Environment]::SetEnvironmentVariable($key, $savedTursoEnv[$key], "Process") }
    Remove-Item -LiteralPath $emptyEnvDev, $stagingFileEnvDev -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $fakeRepoRoot -Recurse -Force -ErrorAction SilentlyContinue
}

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

Write-Host "=== -SkipTursoBackup skips export without a 24h checkpoint ==="
$skipBackupThrew = $false
try {
    Invoke-DeployEmDashTursoBackup -SkipTursoBackup
}
catch {
    $skipBackupThrew = $true
}
Assert-True (-not $skipBackupThrew) "SkipTursoBackup returns without requiring a fresh export"

Write-Host "=== WorkerOnly -SkipTursoBackup skips emdash migrate ==="
Initialize-DeployEnvironment -Environment production
Set-DeploySkipTursoMutate -SkipTursoBackup -WorkerOnly
Assert-True ([bool]$script:DeploySkipTursoMutate) "WorkerOnly + SkipTursoBackup sets DeploySkipTursoMutate"
$migrateThrew = $false
try {
    Invoke-DeployEmdashCoreMigrate
    Invoke-DeployEmdashCoreMigrateCheck
}
catch {
    $migrateThrew = $true
}
Assert-True (-not $migrateThrew) "migrate apply/check no-op when DeploySkipTursoMutate is set"

Initialize-DeployEnvironment -Environment production
Set-DeploySkipTursoMutate
Assert-True (-not [bool]$script:DeploySkipTursoMutate) "full deploy without SkipTursoBackup still migrates"

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

Write-Host "=== Get-DeployWebInstallMismatches ==="
$installTmp = Join-Path ([IO.Path]::GetTempPath()) ("web-install-" + [guid]::NewGuid().ToString("n"))
New-Item -ItemType Directory -Force -Path (Join-Path $installTmp "node_modules/emdash") | Out-Null
try {
    @{
        dependencies = @{ emdash = "^1.1.0" }
    } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $installTmp "package.json")
    @{
        packages = @{
            "node_modules/emdash" = @{ version = "1.1.0" }
        }
    } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $installTmp "package-lock.json")
    @{ version = "1.0.1" } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $installTmp "node_modules/emdash/package.json")

    $stale = @(Get-DeployWebInstallMismatches -WebDir $installTmp)
    Assert-True ($stale.Count -eq 1 -and $stale[0].Name -eq "emdash" -and $stale[0].Installed -eq "1.0.1" -and $stale[0].Lockfile -eq "1.1.0") "stale emdash install is a mismatch"

    @{ version = "1.1.0" } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $installTmp "node_modules/emdash/package.json")
    $fresh = @(Get-DeployWebInstallMismatches -WebDir $installTmp)
    Assert-True ($fresh.Count -eq 0) "matching emdash install is not a mismatch"

    $assertThrew = $false
    @{ version = "1.0.1" } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $installTmp "node_modules/emdash/package.json")
    try {
        Assert-DeployInstalledPackagesMatchLockfile -WebDir $installTmp
    }
    catch {
        $assertThrew = $_.Exception.Message -match "does not match"
    }
    Assert-True $assertThrew "build refuses a stale node_modules"
}
finally {
    Remove-Item -LiteralPath $installTmp -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "=== Worker settings verification (placement / PAGE_CACHE) after wrangler deploy ==="
# terraform-run.ps1's post-apply check and pre-apply guard are tested end to end in
# scripts/test-terraform-worker-script-guards.ps1. Here: the deploy pipeline's use of the same lib.
# `node` is shadowed by a function that WRITES TO STDOUT (so an output leak would show) and no
# network call is made.
function node { Write-Output "[verify-worker-placement] fake stdout line"; $global:LASTEXITCODE = $script:FakeNodeExit }
try {
    $script:FakeNodeExit = 0
    $okThrew = $false
    try { Invoke-DeployWorkerSettingsVerification 6>$null } catch { $okThrew = $true }
    Assert-True (-not $okThrew) "verifier exit 0 passes"

    $script:FakeNodeExit = 1
    $mismatchThrew = $false
    try { Invoke-DeployWorkerSettingsVerification 6>$null } catch { $mismatchThrew = $_.Exception.Message -match "do not match web/wrangler.jsonc" }
    Assert-True $mismatchThrew "verifier exit 1 (placement/PAGE_CACHE mismatch) fails the deploy"

    $script:FakeNodeExit = 2
    $authThrew = $false
    try { Invoke-DeployWorkerSettingsVerification 3>$null 6>$null } catch { $authThrew = $true }
    Assert-True (-not $authThrew) "verifier exit 2 (no token / API error) only warns after wrangler deploy"
}
finally {
    Remove-Item function:node -ErrorAction SilentlyContinue
}

Write-Host "=== Invoke-DeployWorkerSettingsVerification with PSNativeCommandUseErrorActionPreference = `$true (real node) ==="
$nativeTmp = Join-Path ([IO.Path]::GetTempPath()) ("ft-deploy-verify-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path (Join-Path $nativeTmp "web/scripts") | Out-Null
Set-Content -LiteralPath (Join-Path $nativeTmp "web/scripts/verify-worker-placement.mjs") -Value @'
console.log('[verify-worker-placement] fake');
console.error('[verify-worker-placement] could not verify (fake)');
process.exitCode = Number(process.env.FAKE_VERIFIER_EXIT ?? '0');
'@
$previousRepoRoot = $script:DeployRepoRoot
$script:DeployRepoRoot = $nativeTmp
$PSNativeCommandUseErrorActionPreference = $true
try {
    $env:FAKE_VERIFIER_EXIT = "2"
    $nativeThrew = $false
    try { Invoke-DeployWorkerSettingsVerification 3>$null 6>$null } catch { $nativeThrew = $true }
    Assert-True (-not $nativeThrew) "verifier exit 2 only warns even with PSNativeCommandUseErrorActionPreference = `$true"

    $env:FAKE_VERIFIER_EXIT = "1"
    $nativeMismatch = $false
    try { Invoke-DeployWorkerSettingsVerification 6>$null } catch { $nativeMismatch = $_.Exception.Message -match "do not match web/wrangler.jsonc" }
    Assert-True $nativeMismatch "verifier exit 1 throws the mismatch message (not a NativeCommandExitException)"

    Write-Host "=== Write-DeployIncompleteAfterTerraformWarning ==="
    $env:FAKE_VERIFIER_EXIT = "2"
    $script:DeployTerraformApplyStarted = $true
    $script:DeployWorkerDeployCompleted = $false
    $warnOut = Invoke-Command { Write-DeployIncompleteAfterTerraformWarning } 6>&1 | Out-String
    Assert-True ($warnOut -match "wrangler deploy did not complete" -and $warnOut -match "deploy-production-local\.ps1 -WorkerOnly") "apply ran, wrangler did not: loud warning with the -WorkerOnly redeploy command"
    Assert-True ($warnOut -match "Live Worker check exit 2") "...and the live Worker check runs (non-fatal)"

    $script:DeployWorkerDeployCompleted = $true
    $quietOut = Invoke-Command { Write-DeployIncompleteAfterTerraformWarning } 6>&1 | Out-String
    Assert-True ([string]::IsNullOrWhiteSpace($quietOut)) "no warning once wrangler deploy completed"

    $script:DeployTerraformApplyStarted = $false
    $script:DeployWorkerDeployCompleted = $false
    $quietOut = Invoke-Command { Write-DeployIncompleteAfterTerraformWarning } 6>&1 | Out-String
    Assert-True ([string]::IsNullOrWhiteSpace($quietOut)) "no warning when Terraform never ran (-WorkerOnly)"

    $script:DeployTerraformApplyStarted = $true
    $script:DeployRepoRoot = Join-Path $nativeTmp "missing"
    $neverThrew = $true
    try { Write-DeployIncompleteAfterTerraformWarning 6>$null } catch { $neverThrew = $false }
    Assert-True $neverThrew "warning helper never throws (it runs in finally blocks)"
}
finally {
    $PSNativeCommandUseErrorActionPreference = $false
    $script:DeployRepoRoot = $previousRepoRoot
    $script:DeployTerraformApplyStarted = $false
    $script:DeployWorkerDeployCompleted = $false
    Remove-Item Env:FAKE_VERIFIER_EXIT -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $nativeTmp -Recurse -Force -ErrorAction SilentlyContinue
}

$deployCommonText = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot "Deploy-EnvironmentCommon.ps1")
Assert-True ($deployCommonText -match '\$env:FT_WRANGLER_DEPLOY_FOLLOWS = "1"') "deploy pipeline marks its Terraform apply as followed by wrangler deploy"
foreach ($deployScript in "deploy-staging-local.ps1", "deploy-production-local.ps1") {
    $text = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot $deployScript)
    Assert-True ($text -match '(?s)try \{.*Invoke-DeployTerraformApplyWithRecovery.*finally \{\s*#[^\n]*\n\s*Write-DeployIncompleteAfterTerraformWarning') "$deployScript runs the Terraform apply inside try and warns in finally"
}

Write-Host ""
Write-Host "passed=$script:Passed failed=$script:Failed"
if ($script:Failed -gt 0) {
    exit 1
}
exit 0
