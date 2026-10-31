# Cloud Agent deploy guards (Cloudflare token stub, production rollback match).
# Run: pwsh -NoProfile -File ./scripts/test-deploy-cloud-agent-guards.ps1
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# Also runs in CI (ci-guards.yml, deploy-worker.yml) as its own pwsh process. Stubs must never
# emit real workflow commands (::warning::, ::add-mask::) or write to the job summary.
Remove-Item Env:GITHUB_ACTIONS, Env:GITHUB_STEP_SUMMARY -ErrorAction SilentlyContinue

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

Write-Host "=== -UseFreshTursoCheckpoint: verified backup selection ==="
$checkpointTmp = Join-Path ([System.IO.Path]::GetTempPath()) ("ft-checkpoint-" + [guid]::NewGuid().ToString("N"))
$previousCheckpointRoot = $script:DeployRepoRoot
$previousTursoUrl = [Environment]::GetEnvironmentVariable("TURSO_DATABASE_URL", "Process")
try {
    $metaDir = Join-Path $checkpointTmp ".release/rollback-branches"
    New-Item -ItemType Directory -Force -Path $metaDir | Out-Null
    $nowUtc = (Get-Date).ToUniversalTime()
    function New-TestBackupMeta {
        param([string]$Name, [hashtable]$Fields, [int]$AgeSeconds)
        $path = Join-Path $metaDir $Name
        ($Fields | ConvertTo-Json -Depth 4) | Set-Content -LiteralPath $path
        (Get-Item -LiteralPath $path).LastWriteTimeUtc = $nowUtc.AddSeconds(-$AgeSeconds)
    }
    $goodHost = "freedomtimes-emdash-production-org.aws-eu-west-1.turso.io"
    $base = @{ kind = "production-emdash-content-backup"; workerTursoHost = $goodHost }

    $empty = Select-DeployFreshVerifiedProductionBackup -MetadataDir $metaDir -CutoffUtc $nowUtc.AddHours(-24)
    Assert-True ($null -eq $empty.Metadata) "no metadata: nothing selected"

    $good = $base.Clone(); $good.backupDatabase = "prod-backup-20261030-100000"; $good.verificationPass = $true; $good.createdAtUtc = $nowUtc.AddMinutes(-5).ToString("o")
    New-TestBackupMeta -Name "20261030-100000-prod-backup-20261030-100000.json" -Fields $good -AgeSeconds 40
    $noHost = $good.Clone(); $noHost.backupDatabase = "prod-backup-20261030-100100"; $noHost.workerTursoHost = ""
    New-TestBackupMeta -Name "20261030-100100-prod-backup-20261030-100100.json" -Fields $noHost -AgeSeconds 30
    $old = $good.Clone(); $old.backupDatabase = "prod-backup-20261028-100000"; $old.createdAtUtc = $nowUtc.AddHours(-30).ToString("o")
    New-TestBackupMeta -Name "20261030-100200-prod-backup-20261028-100000.json" -Fields $old -AgeSeconds 20
    # Newest file: name-matched but NOT verified. The old code accepted this; it must be skipped.
    $unverified = $good.Clone(); $unverified.backupDatabase = "prod-backup-20261030-100300"; $unverified.verificationPass = $false
    New-TestBackupMeta -Name "20261030-100300-prod-backup-20261030-100300.json" -Fields $unverified -AgeSeconds 10

    $pick = Select-DeployFreshVerifiedProductionBackup -MetadataDir $metaDir -CutoffUtc $nowUtc.AddHours(-24)
    Assert-True ($null -ne $pick.Metadata -and $pick.Metadata.backupDatabase -eq "prod-backup-20261030-100000") "picks the newest verified, fresh, complete backup"
    Assert-True (@($pick.Rejected).Count -eq 3) "rejects unverified, stale and host-less candidates"
    Assert-True ((@($pick.Rejected) -join "`n") -match "verificationPass is not true") "unverified candidate is reported"

    Remove-Item -LiteralPath (Join-Path $metaDir "20261030-100000-prod-backup-20261030-100000.json")
    $script:DeployRepoRoot = $checkpointTmp
    $script:DeployIsStaging = $false
    $assertMessage = ""
    try { Assert-DeployFreshEmDashTursoBackup 3>$null } catch { $assertMessage = $_.Exception.Message }
    Assert-True ($assertMessage -match "Refusing to migrate or deploy" -and $assertMessage -match "-UseFreshTursoCheckpoint") "only unverified/stale backups: refuses with a -UseFreshTursoCheckpoint message"
    Assert-True ($assertMessage -notmatch "SkipTursoBackup") "refusal does not mention -SkipTursoBackup"

    Write-Host "=== -UseFreshTursoCheckpoint: migrate target must be the backed-up host ==="
    Assert-True (Test-DeployMigrateTargetMatchesBackupHost -BackupHost $goodHost -MigrateUrl "libsql://$goodHost") "same host matches"
    Assert-True (Test-DeployMigrateTargetMatchesBackupHost -BackupHost $goodHost.ToUpperInvariant() -MigrateUrl "libsql://$goodHost/?tls=1") "case and query string ignored"
    Assert-True (-not (Test-DeployMigrateTargetMatchesBackupHost -BackupHost $goodHost -MigrateUrl "libsql://freedomtimes-emdash-production-dr-org.aws-eu-west-1.turso.io")) "different host does not match"
    Assert-True (-not (Test-DeployMigrateTargetMatchesBackupHost -BackupHost "" -MigrateUrl "libsql://$goodHost")) "empty backup host never matches"
    Assert-True (-not (Test-DeployMigrateTargetMatchesBackupHost -BackupHost $goodHost -MigrateUrl "")) "empty migrate URL never matches"

    $script:DeployFreshBackupMetadata = [pscustomobject]$good
    $env:TURSO_DATABASE_URL = "libsql://freedomtimes-emdash-production-dr-org.aws-eu-west-1.turso.io"
    $mismatchThrew = $false
    try { Assert-DeployMigrateTargetMatchesBackupHost 6>$null } catch { $mismatchThrew = $_.Exception.Message -match "Nothing was migrated or deployed" }
    Assert-True $mismatchThrew "migrate target on another host: refuses before migrate"
    $env:TURSO_DATABASE_URL = "libsql://$goodHost"
    $matchThrew = $false
    try { Assert-DeployMigrateTargetMatchesBackupHost 6>$null } catch { $matchThrew = $true }
    Assert-True (-not $matchThrew) "migrate target on the backed-up host: proceeds"
}
finally {
    $script:DeployRepoRoot = $previousCheckpointRoot
    $script:DeployFreshBackupMetadata = $null
    [Environment]::SetEnvironmentVariable("TURSO_DATABASE_URL", $previousTursoUrl, "Process")
    Remove-Item -LiteralPath $checkpointTmp -Recurse -Force -ErrorAction SilentlyContinue
}


Write-Host "=== #142: live production Worker provenance (hash of the Worker's Turso host) ==="
$provHost = "freedomtimes-emdash-production-org.aws-eu-west-1.turso.io"
$provDrHost = "freedomtimes-emdash-production-dr-org.aws-eu-west-1.turso.io"
# Shared vector with web/scripts/test-deploy-provenance.mts (the Worker computes the same hex).
$provHash = "642dfdbffe3ada3de0c2611f4095b3cae12e30b36886b7619fa5251c4e2f52bb"
Assert-True ((Get-DeployTursoHostProvenanceHash -TursoHost $provHost) -eq $provHash) "host hash matches the shared Worker test vector"
Assert-True ((Get-DeployTursoHostProvenanceHash -TursoHost $provHost.ToUpperInvariant()) -eq $provHash) "host hash ignores case"
Assert-True ((Get-DeployTursoHostProvenanceHash -TursoHost "") -eq "") "empty host has no hash"
$provDrHash = Get-DeployTursoHostProvenanceHash -TursoHost $provDrHost
Assert-True ($provDrHash -ne $provHash) "a DR host hashes differently"

# Runs a provenance call as on GitHub Actions; returns its host output and job-summary text.
function Invoke-WithGitHubStepSummary {
    param([scriptblock]$Body)
    $prevGha = $env:GITHUB_ACTIONS
    $prevSummary = $env:GITHUB_STEP_SUMMARY
    $summaryFile = [System.IO.Path]::GetTempFileName()
    try {
        $env:GITHUB_ACTIONS = "true"
        $env:GITHUB_STEP_SUMMARY = $summaryFile
        $hostLines = @(& $Body 3>$null 6>&1 | ForEach-Object { "$_" })
        [pscustomobject]@{ Host = ($hostLines -join "`n"); Summary = [string](Get-Content -Raw -LiteralPath $summaryFile) }
    }
    finally {
        $env:GITHUB_ACTIONS = $prevGha
        $env:GITHUB_STEP_SUMMARY = $prevSummary
        Remove-Item -LiteralPath $summaryFile -ErrorAction SilentlyContinue
    }
}
function New-ProvBody { param([string]$Hash, [string]$Commit = "c0ffee1") ([ordered]@{ schema = 1; commitSha = $Commit; tursoHostSha256 = $Hash } | ConvertTo-Json -Compress) }
function Get-ProvOutcome {
    param([string]$Phase, [int]$Status, [string]$Body, [string]$Commit = "")
    (Resolve-DeployLiveWorkerProvenanceVerdict -Phase $Phase -StatusCode $Status -Body $Body -ExpectedHash $provHash -ExpectedCommitSha $Commit).Outcome
}
Assert-True ((Get-ProvOutcome PreDeploy 200 (New-ProvBody $provHash)) -eq "Match") "verdict: same host hash = Match"
Assert-True ((Get-ProvOutcome PreDeploy 200 (New-ProvBody $provDrHash)) -eq "Mismatch") "verdict: other host hash = Mismatch"
Assert-True ((Get-ProvOutcome PreDeploy 200 (New-ProvBody $null)) -eq "Fail") "verdict: missing host hash = Fail"
Assert-True ((Get-ProvOutcome PreDeploy 200 "<html>not json</html>") -eq "Fail") "verdict: non-JSON body = Fail"
Assert-True ((Get-ProvOutcome PreDeploy 404 "") -eq "BootstrapCandidate") "verdict: 404 before deploy = BootstrapCandidate (needs #144 evidence, never a pass on its own)"
Assert-True ((Get-ProvOutcome PostDeploy 404 "") -eq "Retry") "verdict: 404 after deploy = Retry (never Bootstrap)"
Assert-True ((Get-ProvOutcome PreDeploy 401 "") -eq "Fail") "verdict: 401 = Fail"
Assert-True ((Get-ProvOutcome PreDeploy 302 "") -eq "Fail") "verdict: redirect = Fail"
Assert-True ((Get-ProvOutcome PreDeploy 0 "") -eq "Retry") "verdict: network error = Retry"
Assert-True ((Get-ProvOutcome PreDeploy 503 "") -eq "Retry") "verdict: 5xx = Retry"
Assert-True ((Get-ProvOutcome PostDeploy 200 (New-ProvBody $provHash "old1234") "new5678") -eq "Retry") "verdict: old version still serving after deploy = Retry"
Assert-True ((Get-ProvOutcome PostDeploy 200 (New-ProvBody $provHash "new5678") "new5678") -eq "Match") "verdict: new version, same host = Match"
Assert-True ((Get-ProvOutcome PostDeploy 200 (New-ProvBody $provDrHash "new5678") "new5678") -eq "Mismatch") "verdict: new version, other host = Mismatch"
Assert-True ((Resolve-DeployLiveWorkerProvenanceVerdict -Phase PreDeploy -StatusCode 200 -Body (New-ProvBody $provHash) -ExpectedHash "" -ExpectedCommitSha "").Outcome -eq "Fail") "verdict: backup without workerTursoHost = Fail"

$previousBuildSha = [Environment]::GetEnvironmentVariable("FT_BUILD_COMMIT_SHA", "Process")
try {
    $script:DeployFreshBackupMetadata = [pscustomobject]@{ backupDatabase = "prod-backup-20261030-100000"; workerTursoHost = $provHost }
    $env:FT_BUILD_COMMIT_SHA = "new5678"
    $fetchOk = { [pscustomobject]@{ StatusCode = 200; Body = (New-ProvBody $provHash "old1234") } }
    Assert-True ((Assert-DeployLiveWorkerTursoHostMatchesBackup -Phase PreDeploy -Fetch $fetchOk -DelaySeconds 0 6>$null) -eq "Match") "pre-deploy: live Worker on the backed-up host proceeds"

    $mismatchMessage = ""
    $fetchDr = { [pscustomobject]@{ StatusCode = 200; Body = (New-ProvBody $provDrHash "old1234") } }
    try { Assert-DeployLiveWorkerTursoHostMatchesBackup -Phase PreDeploy -Fetch $fetchDr -DelaySeconds 0 6>$null | Out-Null } catch { $mismatchMessage = $_.Exception.Message }
    Assert-True ($mismatchMessage -match "Refusing to migrate or deploy" -and $mismatchMessage -match "Nothing was migrated or deployed") "pre-deploy: live Worker on another DB fails closed before anything runs"
    Assert-True ($mismatchMessage -notmatch [regex]::Escape($provHost) -and $mismatchMessage -notmatch [regex]::Escape($provDrHost)) "mismatch message never prints a hostname"

    $missingMessage = ""
    $fetchNoHash = { [pscustomobject]@{ StatusCode = 200; Body = (New-ProvBody $null "old1234") } }
    try { Assert-DeployLiveWorkerTursoHostMatchesBackup -Phase PreDeploy -Fetch $fetchNoHash -DelaySeconds 0 6>$null | Out-Null } catch { $missingMessage = $_.Exception.Message }
    Assert-True ($missingMessage -match "no Turso host hash") "pre-deploy: live Worker without a host hash fails closed"

    # #144: a pre-deploy 404 is the bootstrap only with proof the live Worker predates the endpoint.
    $preSha = "1646f96749e245d9f6df44a8e8f633fb86500cdf"
    $endpointSha = "9a71314353aacd24e18b71906358e80791ffa820"
    $laterSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    function New-FakeGitOps {
        param([bool]$Shallow = $false, [string[]]$Known = @(), [string[]]$HasRoute = @(), [string[]]$Introducing = @(), [string[]]$Descendants = @(), [bool]$Throw = $false)
        $state = @{ Shallow = $Shallow; Known = $Known; HasRoute = $HasRoute; Introducing = $Introducing; Descendants = $Descendants; Throw = $Throw }
        return @{
            IsShallow          = { if ($state.Throw) { throw "git exploded" }; $state.Shallow }.GetNewClosure()
            CommitExists       = { param($Sha) $state.Known -contains $Sha }.GetNewClosure()
            TreeHasPath        = { param($Sha, $Path) $state.HasRoute -contains $Sha }.GetNewClosure()
            IntroducingCommits = { param($Path) $state.Introducing }.GetNewClosure()
            IsAncestor         = { param($Ancestor, $Descendant) $state.Descendants -contains $Descendant }.GetNewClosure()
        }
    }
    function New-VersionBody { param([string]$Commit) ([ordered]@{ repository = "cultpodcasts/freedomtimes"; commitSha = $Commit } | ConvertTo-Json -Compress) }
    $gitPre = New-FakeGitOps -Known @($preSha, $endpointSha, $laterSha) -HasRoute @($endpointSha, $laterSha) -Introducing @($endpointSha) -Descendants @($endpointSha, $laterSha)
    $ev = { param($Status, $Body, $Git) Resolve-DeployProvenanceBootstrapEvidence -VersionStatusCode $Status -VersionBody $Body -Git $Git }

    Assert-True ((& $ev 200 (New-VersionBody $preSha) $gitPre).Allowed) "#144 evidence: live commit predates the endpoint = bootstrap allowed"
    Assert-True (-not (& $ev 200 (New-VersionBody $laterSha) $gitPre).Allowed) "#144 evidence: live commit already ships the endpoint = refused"
    $gitCherry = New-FakeGitOps -Known @($preSha) -HasRoute @($preSha) -Introducing @($endpointSha)
    Assert-True (-not (& $ev 200 (New-VersionBody $preSha) $gitCherry).Allowed) "#144 evidence: route file in the live tree (not via ancestry) = refused"
    $gitDesc = New-FakeGitOps -Known @($preSha) -Introducing @($endpointSha) -Descendants @($preSha)
    Assert-True (-not (& $ev 200 (New-VersionBody $preSha) $gitDesc).Allowed) "#144 evidence: endpoint commit is an ancestor of the live commit = refused"
    Assert-True (-not (& $ev 200 (New-VersionBody "unknown") $gitPre).Allowed) "#144 evidence: live commit 'unknown' = refused"
    Assert-True (-not (& $ev 200 (New-VersionBody "1646f96") $gitPre).Allowed) "#144 evidence: short/partial live commit = refused"
    Assert-True (-not (& $ev 200 '{"repository":"x"}' $gitPre).Allowed) "#144 evidence: version.json without commitSha = refused"
    Assert-True (-not (& $ev 200 (New-VersionBody "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb") $gitPre).Allowed) "#144 evidence: live commit not in history = refused"
    Assert-True (-not (& $ev 0 "" $gitPre).Allowed) "#144 evidence: version.json unreachable = refused"
    Assert-True (-not (& $ev 301 "" $gitPre).Allowed) "#144 evidence: version.json redirect = refused"
    Assert-True (-not (& $ev 503 "" $gitPre).Allowed) "#144 evidence: version.json 5xx = refused"
    Assert-True (-not (& $ev 200 "<html>login</html>" $gitPre).Allowed) "#144 evidence: version.json not JSON = refused"
    Assert-True (-not (& $ev 200 '["x"]' $gitPre).Allowed) "#144 evidence: version.json not an object = refused"
    Assert-True (-not (& $ev 200 (New-VersionBody $preSha) (New-FakeGitOps -Shallow $true -Known @($preSha) -Introducing @($endpointSha))).Allowed) "#144 evidence: shallow checkout = refused"
    Assert-True (-not (& $ev 200 (New-VersionBody $preSha) (New-FakeGitOps -Known @($preSha))).Allowed) "#144 evidence: no introducing commit found = refused"
    Assert-True (-not (& $ev 200 (New-VersionBody $preSha) (New-FakeGitOps -Throw $true)).Allowed) "#144 evidence: git error = refused"

    $script:DeployLiveProvenanceBootstrap = $false
    $fetch404 = { [pscustomobject]@{ StatusCode = 404; Body = "" } }
    $fetchVersionPre = { [pscustomobject]@{ StatusCode = 200; Body = (New-VersionBody $preSha) } }
    $bootstrap = Assert-DeployLiveWorkerTursoHostMatchesBackup -Phase PreDeploy -Fetch $fetch404 -FetchVersion $fetchVersionPre -GitOps $gitPre -DelaySeconds 0 3>$null 6>$null
    Assert-True ($bootstrap -eq "Bootstrap" -and $script:DeployLiveProvenanceBootstrap) "pre-deploy: 404 with a live Worker that predates the endpoint is a bootstrap"
    $ci = Invoke-WithGitHubStepSummary { Assert-DeployLiveWorkerTursoHostMatchesBackup -Phase PreDeploy -Fetch $fetch404 -FetchVersion $fetchVersionPre -GitOps $gitPre -DelaySeconds 0 }
    Assert-True ($ci.Host -match '::warning title=Live Worker provenance bootstrap \(#142\)::' -and $ci.Summary -match '\(PreDeploy, #142\): \*\*bootstrap\*\*' -and $ci.Summary -match 'secret-vs-backup host check only') "pre-deploy bootstrap: #142 warning title and job-summary line"

    $script:DeployLiveProvenanceBootstrap = $false
    $refused = ""
    $fetchVersionLater = { [pscustomobject]@{ StatusCode = 200; Body = (New-VersionBody $laterSha) } }
    try { Assert-DeployLiveWorkerTursoHostMatchesBackup -Phase PreDeploy -Fetch $fetch404 -FetchVersion $fetchVersionLater -GitOps $gitPre -DelaySeconds 0 3>$null 6>$null | Out-Null } catch { $refused = $_.Exception.Message }
    Assert-True ($refused -match "Not a provenance bootstrap \(#144\)" -and $refused -match "Nothing was migrated or deployed" -and -not $script:DeployLiveProvenanceBootstrap) "pre-deploy: 404 from a live Worker that ships the endpoint fails closed"

    $refused = ""
    $fetchVersionDown = { [pscustomobject]@{ StatusCode = 0; Body = "" } }
    try { Assert-DeployLiveWorkerTursoHostMatchesBackup -Phase PreDeploy -Fetch $fetch404 -FetchVersion $fetchVersionDown -GitOps $gitPre -DelaySeconds 0 3>$null 6>$null | Out-Null } catch { $refused = $_.Exception.Message }
    Assert-True ($refused -match "unreachable" -and $refused -match "Nothing was migrated or deployed") "pre-deploy: 404 with version.json unreachable fails closed"

    $refused = ""
    $fetchVersionUnknown = { [pscustomobject]@{ StatusCode = 200; Body = (New-VersionBody "unknown") } }
    try { Assert-DeployLiveWorkerTursoHostMatchesBackup -Phase PreDeploy -Fetch $fetch404 -FetchVersion $fetchVersionUnknown -GitOps $gitPre -DelaySeconds 0 3>$null 6>$null | Out-Null } catch { $refused = $_.Exception.Message }
    Assert-True ($refused -match "Not a provenance bootstrap") "pre-deploy: 404 with an unknown live commit fails closed"

    # Real git (temp repo): the default ops read history the way CI does (full clone).
    $gitRepo = Join-Path ([System.IO.Path]::GetTempPath()) ("ft144-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $gitRepo | Out-Null
    try {
        $g = { param([Parameter(ValueFromRemainingArguments = $true)][string[]]$GitArgs) & git -C $gitRepo -c user.name=t -c user.email=t@example.invalid -c commit.gpgsign=false @GitArgs 2>$null }
        & $g init -q | Out-Null
        Set-Content -LiteralPath (Join-Path $gitRepo "README.md") -Value "a"
        & $g add -A | Out-Null; & $g commit -q -m before | Out-Null
        $realPre = ([string](& $g rev-parse HEAD)).Trim()
        $routeDir = Join-Path $gitRepo "web/src/pages/api"
        New-Item -ItemType Directory -Path $routeDir -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $routeDir "deploy-provenance.json.ts") -Value "export {}"
        & $g add -A | Out-Null; & $g commit -q -m endpoint | Out-Null
        $realEndpoint = ([string](& $g rev-parse HEAD)).Trim()
        Set-Content -LiteralPath (Join-Path $gitRepo "README.md") -Value "b"
        & $g add -A | Out-Null; & $g commit -q -m after | Out-Null
        $realAfter = ([string](& $g rev-parse HEAD)).Trim()
        $realOps = Get-DeployGitProvenanceEvidenceOps -RepoRoot $gitRepo
        Assert-True ((& $ev 200 (New-VersionBody $realPre) $realOps).Allowed) "#144 real git: commit before the endpoint = bootstrap allowed"
        Assert-True (-not (& $ev 200 (New-VersionBody $realEndpoint) $realOps).Allowed) "#144 real git: the endpoint commit itself = refused"
        Assert-True (-not (& $ev 200 (New-VersionBody $realAfter) $realOps).Allowed) "#144 real git: a later commit = refused"
        Assert-True (-not (& $ev 200 (New-VersionBody ("c" * 40)) $realOps).Allowed) "#144 real git: commit not in history = refused"
    }
    finally {
        Remove-Item -LiteralPath $gitRepo -Recurse -Force -ErrorAction SilentlyContinue
    }

    $post404Message = ""
    try { Assert-DeployLiveWorkerTursoHostMatchesBackup -Phase PostDeploy -Fetch $fetch404 -MaxAttempts 3 -DelaySeconds 0 6>$null | Out-Null } catch { $post404Message = $_.Exception.Message }
    Assert-True ($post404Message -match "post-deploy provenance check" -and $post404Message -match "gave up after 3 attempts") "post-deploy: 404 is a hard failure (no bootstrap after deploy)"

    $script:provCalls = 0
    $fetchRollover = {
        $script:provCalls++
        $commit = if ($script:provCalls -lt 3) { "old1234" } else { "new5678" }
        [pscustomobject]@{ StatusCode = 200; Body = (New-ProvBody $provHash $commit) }
    }
    $post = Assert-DeployLiveWorkerTursoHostMatchesBackup -Phase PostDeploy -Fetch $fetchRollover -MaxAttempts 5 -DelaySeconds 0 6>$null
    Assert-True ($post -eq "Match" -and $script:provCalls -eq 3) "post-deploy: waits for the new version, then matches"

    $postMismatch = ""
    $fetchNewDr = { [pscustomobject]@{ StatusCode = 200; Body = (New-ProvBody $provDrHash "new5678") } }
    try { Assert-DeployLiveWorkerTursoHostMatchesBackup -Phase PostDeploy -Fetch $fetchNewDr -DelaySeconds 0 6>$null | Out-Null } catch { $postMismatch = $_.Exception.Message }
    Assert-True ($postMismatch -match "post-deploy provenance check" -and $postMismatch -match "Roll back") "post-deploy: new Worker on another DB fails with rollback guidance"
}
finally {
    $script:DeployFreshBackupMetadata = $null
    $script:DeployLiveProvenanceBootstrap = $false
    [Environment]::SetEnvironmentVariable("FT_BUILD_COMMIT_SHA", $previousBuildSha, "Process")
}

$productionDeployText = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot "deploy-production-local.ps1")
Assert-True ($productionDeployText -match '(?s)Invoke-DeployWorkerBuild[^\n]*\n\s*if \(\$UseFreshTursoCheckpoint\) \{.*?Assert-DeployMigrateTargetMatchesBackupHost.*?\}\s*\n\s*Invoke-DeployEmdashCoreMigrate') "deploy-production-local.ps1 checks the migrate host after build, before migrate"
Assert-True ($productionDeployText -match '(?s)Assert-DeployFreshEmDashTursoBackup\s*\n(\s*#[^\n]*\n)*\s*Assert-DeployLiveWorkerTursoHostMatchesBackup -Phase PreDeploy') "deploy-production-local.ps1 checks the live Worker right after selecting the backup (before build/migrate)"
Assert-True ($productionDeployText -match '(?s)Invoke-DeployWorkerDeploy\s*\n\s*if \(\$UseFreshTursoCheckpoint\) \{.*?Assert-DeployLiveWorkerTursoHostMatchesBackup -Phase PostDeploy') "deploy-production-local.ps1 re-checks the new Worker right after wrangler deploy"


Write-Host "=== #148: prove the backup source is the live Worker's DB before backing up ==="
Assert-True ((Get-ProvOutcome PreBackup 200 (New-ProvBody $provHash)) -eq "Match") "pre-backup verdict: same host hash = Match"
Assert-True ((Get-ProvOutcome PreBackup 200 (New-ProvBody $provDrHash)) -eq "Mismatch") "pre-backup verdict: other host hash = Mismatch"
Assert-True ((Get-ProvOutcome PreBackup 404 "") -eq "BootstrapCandidate") "pre-backup verdict: 404 = BootstrapCandidate (same #144 rules as pre-deploy)"
Assert-True ((Get-ProvOutcome PreBackup 302 "") -eq "Fail") "pre-backup verdict: redirect = Fail"
Assert-True ((Get-ProvOutcome PreBackup 403 "") -eq "Fail") "pre-backup verdict: 403 = Fail"
Assert-True ((Get-ProvOutcome PreBackup 200 "<html>x</html>") -eq "Fail") "pre-backup verdict: non-JSON = Fail"
Assert-True ((Get-ProvOutcome PreBackup 503 "") -eq "Retry") "pre-backup verdict: 5xx = Retry"

$previousBuildSha148 = [Environment]::GetEnvironmentVariable("FT_BUILD_COMMIT_SHA", "Process")
try {
    # PreBackup must not need (or touch) a selected backup: it runs before one exists.
    $script:DeployFreshBackupMetadata = $null
    $script:DeployLiveProvenanceBootstrap = $false
    $env:FT_BUILD_COMMIT_SHA = "new5678"
    $fetchLive = { [pscustomobject]@{ StatusCode = 200; Body = (New-ProvBody $provHash "09f4ec1") } }
    Assert-True ((Assert-DeployLiveWorkerTursoHostMatchesBackup -Phase PreBackup -ExpectedTursoHost $provHost -Fetch $fetchLive -DelaySeconds 0 6>$null) -eq "Match") "pre-backup: source host = live Worker host proceeds"

    $msg = ""
    try { Assert-DeployLiveWorkerTursoHostMatchesBackup -Phase PreBackup -ExpectedTursoHost $provDrHost -Fetch $fetchLive -DelaySeconds 0 6>$null | Out-Null } catch { $msg = $_.Exception.Message }
    Assert-True ($msg -match "Refusing to back up" -and $msg -match "Nothing was backed up, migrated or deployed" -and $msg -match "TURSO_PRODUCTION_EMDASH_DB_URL") "pre-backup: source on another DB than the live Worker refuses before any branch"
    Assert-True ($msg -notmatch [regex]::Escape($provHost) -and $msg -notmatch [regex]::Escape($provDrHost)) "pre-backup mismatch message never prints a hostname"

    $msg = ""
    try { Assert-DeployLiveWorkerTursoHostMatchesBackup -Phase PreBackup -ExpectedTursoHost "" -Fetch $fetchLive -DelaySeconds 0 6>$null | Out-Null } catch { $msg = $_.Exception.Message }
    Assert-True ($msg -match "no backup source host" -and $msg -match "Nothing was backed up") "pre-backup: no resolved source host refuses"

    $msg = ""
    try { Assert-DeployLiveWorkerTursoHostMatchesBackup -Phase PreBackup -ExpectedTursoHost $provHost -Fetch { [pscustomobject]@{ StatusCode = 200; Body = (New-ProvBody $null) } } -DelaySeconds 0 6>$null | Out-Null } catch { $msg = $_.Exception.Message }
    Assert-True ($msg -match "no Turso host hash" -and $msg -match "Nothing was backed up") "pre-backup: live Worker without a host hash refuses"

    foreach ($case in @(@{ S = 302; N = "redirect" }, @{ S = 401; N = "401" }, @{ S = 418; N = "unexpected status" })) {
        $msg = ""
        $st = $case.S
        $fetchBad = { [pscustomobject]@{ StatusCode = $st; Body = "" } }.GetNewClosure()
        try { Assert-DeployLiveWorkerTursoHostMatchesBackup -Phase PreBackup -ExpectedTursoHost $provHost -Fetch $fetchBad -DelaySeconds 0 6>$null | Out-Null } catch { $msg = $_.Exception.Message }
        Assert-True ($msg -match "Refusing to back up" -and $msg -match "Nothing was backed up") "pre-backup: $($case.N) refuses"
    }

    $script:prebackupCalls = 0
    $fetchDown = { $script:prebackupCalls++; [pscustomobject]@{ StatusCode = 0; Body = "" } }
    $msg = ""
    try { Assert-DeployLiveWorkerTursoHostMatchesBackup -Phase PreBackup -ExpectedTursoHost $provHost -Fetch $fetchDown -MaxAttempts 3 -DelaySeconds 0 6>$null | Out-Null } catch { $msg = $_.Exception.Message }
    Assert-True ($msg -match "gave up after 3 attempts" -and $msg -match "Nothing was backed up" -and $script:prebackupCalls -eq 3) "pre-backup: site unreachable retries, then refuses"

    $script:prebackupCalls = 0
    $fetchFlaky = { $script:prebackupCalls++; if ($script:prebackupCalls -lt 2) { [pscustomobject]@{ StatusCode = 503; Body = "" } } else { [pscustomobject]@{ StatusCode = 200; Body = (New-ProvBody $provHash) } } }
    Assert-True ((Assert-DeployLiveWorkerTursoHostMatchesBackup -Phase PreBackup -ExpectedTursoHost $provHost -Fetch $fetchFlaky -MaxAttempts 3 -DelaySeconds 0 6>$null) -eq "Match") "pre-backup: one 5xx then a match proceeds"

    $bootstrap = Assert-DeployLiveWorkerTursoHostMatchesBackup -Phase PreBackup -ExpectedTursoHost $provHost -Fetch $fetch404 -FetchVersion $fetchVersionPre -GitOps $gitPre -DelaySeconds 0 3>$null 6>$null
    Assert-True ($bootstrap -eq "Bootstrap" -and -not $script:DeployLiveProvenanceBootstrap) "pre-backup: 404 from a Worker that predates the endpoint = bootstrap (#144), deploy flag untouched"
    $ci = Invoke-WithGitHubStepSummary { Assert-DeployLiveWorkerTursoHostMatchesBackup -Phase PreBackup -ExpectedTursoHost $provHost -Fetch $fetch404 -FetchVersion $fetchVersionPre -GitOps $gitPre -DelaySeconds 0 }
    Assert-True ($ci.Host -match '::warning title=Live Worker provenance bootstrap \(#148\)::' -and $ci.Host -notmatch '\(#142\)::') "pre-backup bootstrap: warning title names #148, not the deploy check"
    Assert-True ($ci.Summary -match '\(PreBackup, #148\): \*\*bootstrap\*\*' -and $ci.Summary -match 'backup source not proven' -and $ci.Summary -notmatch 'secret-vs-backup') "pre-backup bootstrap: job summary says the backup source is unproven (no deploy wording)"
    Assert-True ($ci.Host -notmatch [regex]::Escape($provHost) -and $ci.Summary -notmatch [regex]::Escape($provHost)) "pre-backup bootstrap output never prints the hostname"

    $msg = ""
    try { Assert-DeployLiveWorkerTursoHostMatchesBackup -Phase PreBackup -ExpectedTursoHost $provHost -Fetch $fetch404 -FetchVersion $fetchVersionLater -GitOps $gitPre -DelaySeconds 0 3>$null 6>$null | Out-Null } catch { $msg = $_.Exception.Message }
    Assert-True ($msg -match "Not a provenance bootstrap \(#144\)" -and $msg -match "Nothing was backed up") "pre-backup: 404 from a Worker that ships the endpoint refuses"

    $msg = ""
    try { Assert-DeployLiveWorkerTursoHostMatchesBackup -Phase PreBackup -ExpectedTursoHost $provHost -Fetch $fetch404 -FetchVersion $fetchVersionDown -GitOps $gitPre -DelaySeconds 0 3>$null 6>$null | Out-Null } catch { $msg = $_.Exception.Message }
    Assert-True ($msg -match "Not a provenance bootstrap" -and $msg -match "Nothing was backed up") "pre-backup: 404 with version.json unreachable refuses"
}
finally {
    $script:DeployFreshBackupMetadata = $null
    $script:DeployLiveProvenanceBootstrap = $false
    [Environment]::SetEnvironmentVariable("FT_BUILD_COMMIT_SHA", $previousBuildSha148, "Process")
}

# Caveat reporting: one notice on a match, warnings otherwise.
$previousGha = $env:GITHUB_ACTIONS
try {
    $resolverWarns = @("Using env fallback TURSO_PRODUCTION_EMDASH_DB_URL. Confirm hostname matches.", "Resolved database name is 'freedomtimes-emdash-production'. That named DB has been stale/thin.") # pragma: allowlist secret
    $env:GITHUB_ACTIONS = "true"
    $matchOut = & { Write-DeployBackupSourceCaveats -LiveProvenance match -ResolverWarnings $resolverWarns -SourceDatabase "freedomtimes-emdash-production" -ResolveSource "TURSO_PRODUCTION_EMDASH_DB_URL" } 3>&1 6>&1 | ForEach-Object { "$_" } # pragma: allowlist secret
    $matchWarnings = @(& { Write-DeployBackupSourceCaveats -LiveProvenance match -ResolverWarnings $resolverWarns -SourceDatabase "freedomtimes-emdash-production" } 3>&1 6>$null) # pragma: allowlist secret
    Assert-True ($matchWarnings.Count -eq 0) "caveats after a live match: no warnings"
    Assert-True (@($matchOut).Count -eq 1 -and "$matchOut" -match '^::notice title=Backup source verified \(#148\)::' -and "$matchOut" -match "3 resolver caveat") "caveats after a live match: exactly one ::notice:: on CI"
    foreach ($lp in @("bootstrap", "skipped")) {
        $warns = @(& { Write-DeployBackupSourceCaveats -LiveProvenance $lp -ResolverWarnings $resolverWarns -SourceDatabase "freedomtimes-emdash-production" } 3>&1 6>$null) # pragma: allowlist secret
        Assert-True ($warns.Count -eq 3) "caveats when unproven ($lp): every resolver caveat stays a warning"
    }
    $env:GITHUB_ACTIONS = $null
    $localOut = @(& { Write-DeployBackupSourceCaveats -LiveProvenance match -ResolverWarnings @() -ResolveSource "wrangler-getPlatformProxy-production" } 3>&1 6>&1 | ForEach-Object { "$_" })
    Assert-True ($localOut.Count -eq 1 -and $localOut[0] -notmatch '^::') "caveats after a live match locally: one plain line, no workflow command"
}
finally {
    $env:GITHUB_ACTIONS = $previousGha
}

$backupScriptText = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot "backup-production-emdash.ps1")
$preBackupIdx = $backupScriptText.IndexOf("Assert-DeployLiveWorkerTursoHostMatchesBackup -Phase PreBackup -ExpectedTursoHost `$workerHost")
$caveatIdx = $backupScriptText.IndexOf("Write-DeployBackupSourceCaveats -LiveProvenance")
$preflightIdx = $backupScriptText.IndexOf("Test-TursoSourceDatabase -")
$dryRunIdx = $backupScriptText.IndexOf("if (`$DryRun)")
$branchIdx = $backupScriptText.IndexOf("db create")
Assert-True ($preBackupIdx -gt 0 -and $preBackupIdx -lt $caveatIdx -and $caveatIdx -lt $preflightIdx -and $preflightIdx -lt $branchIdx -and $preBackupIdx -lt $dryRunIdx) "backup-production-emdash.ps1 proves the live Worker host before caveats, preflight, -DryRun and any branch"
Assert-True ($backupScriptText -notmatch '(?m)^\s*Write-Warning \$w\s*$' -and $backupScriptText -notmatch 'Write-Warning "Source is the named production DB') "backup-production-emdash.ps1 has no unconditional resolver-caveat warnings left"
Assert-True ($backupScriptText -match 'SkipLiveProvenanceCheck -and \$env:GITHUB_ACTIONS -eq "true"\)\s*\{\s*throw') "backup-production-emdash.ps1 refuses -SkipLiveProvenanceCheck on GitHub Actions"
Assert-True ($backupScriptText -match 'liveProvenanceCheck\s*=\s*\$liveProvenance') "backup metadata records liveProvenanceCheck"

# #148 / DR: the disaster-recovery safety backup can forward the explicit opt-in.
$drScriptPath = Join-Path $PSScriptRoot "disaster-recover-production-emdash.ps1"
$drScriptText = Get-Content -Raw -LiteralPath $drScriptPath
$drAst = [System.Management.Automation.Language.Parser]::ParseFile($drScriptPath, [ref]$null, [ref]$null)
$drParams = @($drAst.ParamBlock.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath })
Assert-True ($drParams -contains "SkipLiveProvenanceCheck") "disaster-recover-production-emdash.ps1 has an explicit -SkipLiveProvenanceCheck switch"
Assert-True ($drScriptText -match '& \$backupScript -AllowProduction [^\n]*-SkipLiveProvenanceCheck:\$SkipLiveProvenanceCheck') "DR safety backup forwards -SkipLiveProvenanceCheck to backup-production-emdash.ps1"
Assert-True ($drScriptText -match '\[dry-run\] backup-production-emdash\.ps1 -AllowProduction\$skipLiveArg') "DR -DryRun shows whether the live check is skipped"
Assert-True ($drScriptText -match 'catch \{\s*throw "Safety backup failed: \$\(\$_\.Exception\.Message\) \$\(Get-DrSafetyBackupHint -Message \$_\.Exception\.Message') "DR safety-backup failure message carries the #148 hint"
$drHintAst = $drAst.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq "Get-DrSafetyBackupHint" }, $true)
Assert-True ($null -ne $drHintAst) "DR script defines Get-DrSafetyBackupHint"
if ($null -ne $drHintAst) {
    . ([scriptblock]::Create($drHintAst.Extent.Text))
    $downMsg = "Refusing to back up (live Worker provenance, #148): gave up after 4 attempts: unreachable. Nothing was backed up, migrated or deployed."
    $mismatchMsg = "Refusing to back up (live Worker provenance, #148): The live production Worker reads a different Turso DB host than the backup source. Nothing was backed up, migrated or deployed."
    $downHint = Get-DrSafetyBackupHint -Message $downMsg
    Assert-True ($downHint -match "-SkipLiveProvenanceCheck" -and $downHint -match "Do not use -SkipSafetyBackup") "DR hint: site down points to -SkipLiveProvenanceCheck, not -SkipSafetyBackup"
    $mismatchHint = Get-DrSafetyBackupHint -Message $mismatchMsg
    Assert-True ($mismatchHint -notmatch "re-run with -SkipLiveProvenanceCheck" -and $mismatchHint -match "do not skip the check") "DR hint: a host mismatch is never told to skip the check"
    Assert-True ((Get-DrSafetyBackupHint -Message $downMsg -SkipLiveProvenanceCheck) -notmatch "SkipLiveProvenanceCheck") "DR hint: already skipping, no repeat advice"
    Assert-True ((Get-DrSafetyBackupHint -Message "verify FAIL") -notmatch "SkipLiveProvenanceCheck") "DR hint: other backup failures get the generic advice"
}

$deployWorkflowText = Get-Content -Raw -LiteralPath (Join-Path (Split-Path $PSScriptRoot -Parent) ".github/workflows/deploy-worker.yml")
$backupStep = [regex]::Match($deployWorkflowText, '(?s)backup-production-emdash\.ps1 -AllowProduction[^\n]*')
Assert-True ($backupStep.Success -and $backupStep.Value -notmatch 'SkipLiveProvenanceCheck') "deploy-worker.yml never skips the pre-backup live check"
Assert-True ($deployWorkflowText -match '(?s)DEPLOY_PROVENANCE_TOKEN: \$\{\{ secrets\.DEPLOY_PROVENANCE_TOKEN \}\}\s*\n\s*run: \|\s*\n\s*\$group =') "deploy-worker.yml passes DEPLOY_PROVENANCE_TOKEN to the backup step"

Write-Host ""
Write-Host "passed=$script:Passed failed=$script:Failed"
if ($script:Failed -gt 0) {
    exit 1
}
exit 0
