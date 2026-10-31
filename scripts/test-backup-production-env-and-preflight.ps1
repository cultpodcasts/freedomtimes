# Local tests for the production backup's .env.dev fill-missing loader and the
# read-only `turso db show` preflight. No network, no Turso, no real .env.dev.
# Run: pwsh -NoProfile -File ./scripts/test-backup-production-env-and-preflight.ps1
# Local only (this repo has no CI). Uses fake values in a temp dir.
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

. "$PSScriptRoot/lib/EnvFile.ps1"
. "$PSScriptRoot/lib/TursoSourcePreflight.ps1"
. "$PSScriptRoot/lib/BackupVerifyReport.ps1"

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

# The allowlist the backup script uses, read from the script so the test cannot drift.
$backupScript = Get-Content -LiteralPath (Join-Path $PSScriptRoot "backup-production-emdash.ps1") -Raw
$allowBlock = [regex]::Match($backupScript, '\$script:ProductionBackupEnvDevKeys = @\(([^)]*)\)').Groups[1].Value
$allowlist = @([regex]::Matches($allowBlock, '"([A-Z0-9_]+)"') | ForEach-Object { $_.Groups[1].Value })

$touched = @($allowlist) + @("TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN", "CLOUDFLARE_API_TOKEN", "FT_TEST_ENVFILE_OTHER")
$saved = @{}
foreach ($k in $touched) { $saved[$k] = [Environment]::GetEnvironmentVariable($k, "Process") }
function Clear-Touched { foreach ($k in $touched) { [Environment]::SetEnvironmentVariable($k, $null, "Process") } }

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("ft-envfile-test-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tmp | Out-Null
$fakeBin = Join-Path $tmp "bin"
New-Item -ItemType Directory -Path $fakeBin | Out-Null
$savedPath = $env:PATH

try {
    Write-Host "=== allowlist ==="
    Assert-True ($allowlist.Count -eq 8) "backup allowlist has 8 keys"
    Assert-True ($allowlist -contains "EMDASH_STAGING_PAT") "allowlist includes EMDASH_STAGING_PAT (#161 staging compare)"
    Assert-True ($allowlist -contains "EMDASH_STAGING_TOKEN") "allowlist includes EMDASH_STAGING_TOKEN (#161 staging compare)"
    Assert-True ($allowlist -contains "TURSO_PRODUCTION_EMDASH_DB_URL") "allowlist includes TURSO_PRODUCTION_EMDASH_DB_URL"
    Assert-True ($allowlist -contains "TF_VAR_TURSO_ORGANIZATION") "allowlist includes TF_VAR_TURSO_ORGANIZATION"
    Assert-True (-not ($allowlist -contains "TURSO_DATABASE_URL")) "allowlist excludes TURSO_DATABASE_URL"
    Assert-True (-not ($allowlist -contains "TURSO_AUTH_TOKEN")) "allowlist excludes TURSO_AUTH_TOKEN"

    Write-Host "=== Read-EnvFileEntries ==="
    $envPath = Join-Path $tmp ".env.dev"
    $content = ([char]0xFEFF) + "TURSO_PRODUCTION_EMDASH_DB_URL=libsql://fake-db-fakeorg.aws-eu-west-1.turso.io`n" +
        "# TURSO_PRODUCTION_EMDASH_DB_NAME=commented-out`n" +
        "`n" +
        "TURSO_PRODUCTION_EMDASH_DB_TOKEN=`n" +
        "not a valid line`n" +
        "1BAD=starts-with-digit`n" +
        "  TF_VAR_TURSO_ORGANIZATION=fakeorg  `n" +
        "FT_TEST_ENVFILE_OTHER = space-before-equals`n" +
        "TURSO_ORGANIZATION=preset-should-win-file`n" +
        "TURSO_DATABASE_URL=libsql://stale-db-fakeorg.turso.io`n" +
        "TURSO_AUTH_TOKEN=fake-generic-token`n" +
        "CLOUDFLARE_API_TOKEN=fake-cf`n" +
        "TF_VAR_TURSO_DATABASE_GROUP_PRODUCTION=group-first`n" +
        "TF_VAR_TURSO_DATABASE_GROUP_PRODUCTION=group-second`n"
    [IO.File]::WriteAllText($envPath, $content, [Text.UTF8Encoding]::new($false))
    $entries = Read-EnvFileEntries -Path $envPath
    $keys = @($entries | ForEach-Object { $_.Key })
    Assert-True ($keys[0] -eq "TURSO_PRODUCTION_EMDASH_DB_URL") "BOM on first line is trimmed from the key"
    Assert-True (-not ($keys -contains "TURSO_PRODUCTION_EMDASH_DB_NAME")) "commented line is skipped"
    Assert-True (-not ($keys -contains "1BAD")) "malformed key is skipped"
    Assert-True (-not ($keys -contains "FT_TEST_ENVFILE_OTHER")) "space before = is malformed and skipped"
    Assert-True (@($entries | Where-Object { $_.Key -eq "TF_VAR_TURSO_ORGANIZATION" })[0].Value -eq "fakeorg") "key and value are trimmed"
    Assert-True ((Read-EnvFileEntries -Path (Join-Path $tmp "missing.env")).Count -eq 0) "missing file yields no entries"

    Write-Host "=== Import-EnvFileFillMissing ==="
    Clear-Touched
    $env:TURSO_ORGANIZATION = "preset-org"
    $filled = Import-EnvFileFillMissing -Path $envPath -Keys $allowlist
    Assert-True ($env:TURSO_PRODUCTION_EMDASH_DB_URL -eq "libsql://fake-db-fakeorg.aws-eu-west-1.turso.io") "allowlisted key filled (BOM line)"
    Assert-True ([string]::IsNullOrEmpty($env:TURSO_PRODUCTION_EMDASH_DB_TOKEN)) "empty file value does not set the key"
    Assert-True ([string]::IsNullOrEmpty($env:TURSO_PRODUCTION_EMDASH_DB_NAME)) "commented key not set"
    Assert-True ($env:TF_VAR_TURSO_ORGANIZATION -eq "fakeorg") "trimmed allowlisted value filled"
    Assert-True ($env:TURSO_ORGANIZATION -eq "preset-org") "preset process value wins"
    Assert-True ($env:TF_VAR_TURSO_DATABASE_GROUP_PRODUCTION -eq "group-first") "first occurrence in file wins"
    Assert-True ([string]::IsNullOrEmpty($env:TURSO_DATABASE_URL)) "non-allowlisted TURSO_DATABASE_URL ignored"
    Assert-True ([string]::IsNullOrEmpty($env:TURSO_AUTH_TOKEN)) "non-allowlisted TURSO_AUTH_TOKEN ignored"
    Assert-True ([string]::IsNullOrEmpty($env:CLOUDFLARE_API_TOKEN)) "non-allowlisted CLOUDFLARE_API_TOKEN ignored"
    Assert-True ((@($filled) -join ",") -eq "TURSO_PRODUCTION_EMDASH_DB_URL,TF_VAR_TURSO_ORGANIZATION,TF_VAR_TURSO_DATABASE_GROUP_PRODUCTION") "returns filled key names only, in allowlist order"

    Clear-Touched
    $filledMissing = Import-EnvFileFillMissing -Path (Join-Path $tmp "missing.env") -Keys $allowlist
    Assert-True (@($filledMissing).Count -eq 0) "missing file is a no-op (no throw)"
    Assert-True ([string]::IsNullOrEmpty($env:TURSO_PRODUCTION_EMDASH_DB_URL)) "missing file sets nothing"

    Write-Host "=== Format-TursoSourcePreflightFailure ==="
    $msg = Format-TursoSourcePreflightFailure -DatabaseName "fake-db" -ExitCode 1 -WorkerHost "fake-db-fakeorg.turso.io" `
        -Organization "fakeorg" -Output @("Error: you are not logged in", "auth token: abc.def.ghi", "JWT expired")
    Assert-True ($msg -match [regex]::Escape("Could not confirm Turso database 'fake-db' exists (exit 1)")) "says could not confirm, with exit code"
    Assert-True ($msg -match "resolver org 'fakeorg'") "names the resolver org"
    Assert-True ($msg -match "not logged in \(turso auth login\)") "native login hint"
    Assert-True ($msg -match "Error: you are not logged in") "includes captured CLI output"
    Assert-True (-not ($msg -match "abc\.def\.ghi")) "token-like line redacted"
    Assert-True (-not ($msg -match "JWT expired")) "jwt line redacted"
    Assert-True (-not ($msg -match "\(freedomtimes\)")) "no hard-coded org"
    $msgWsl = Format-TursoSourcePreflightFailure -DatabaseName "fake-db" -ExitCode 2 -Organization "" -Output @() -UseWsl
    Assert-True ($msgWsl -match "resolver org 'unset'") "unset org reported as unset"
    Assert-True ($msgWsl -match "WSL has its own ~/.turso login") "WSL login hint"
    Assert-True ($msgWsl -match "\(no output\)") "empty output noted"

    Write-Host "=== Test-TursoSourceDatabase (fake turso on PATH) ==="
    if ($IsWindows) {
        Write-Host "skip  fake turso shim is bash-only; run on Linux/WSL for these cases"
    }
    else {
        $shim = Join-Path $fakeBin "turso"
        Set-Content -LiteralPath $shim -Value @'
#!/usr/bin/env bash
if [ "$1 $2" = "db show" ] && [ "$3" = "present-db" ]; then
  echo "Name: present-db"; exit 0
fi
echo "Error: database $3 not found" >&2; exit 1
'@
        chmod +x $shim
        $env:PATH = "$fakeBin$([IO.Path]::PathSeparator)$savedPath"
        Assert-True ((Get-Command turso).Source -eq $shim) "fake turso shim shadows any real CLI"
        $ok = Test-TursoSourceDatabase -DatabaseName "present-db"
        Assert-True ($ok.Ok -and $ok.ExitCode -eq 0) "existing DB confirmed"
        $bad = Test-TursoSourceDatabase -DatabaseName "missing-db"
        Assert-True ((-not $bad.Ok) -and $bad.ExitCode -eq 1) "non-zero exit reported, no throw"
        Assert-True ((@($bad.Output) -join "`n") -match "missing-db not found") "stderr captured"
    }

    Write-Host "=== BackupVerifyReport (#161) ==="
    $out = @(
        "Resolving…",
        '{"pass":false,"error":"staging_token_missing","message":"none of EMDASH_STAGING_PAT, EMDASH_STAGING_TOKEN is set","stagingStatus":null,"stagingTokenSource":null}'
    )
    $f = Get-BackupVerifyFailureFromOutput -Output $out
    Assert-True ($null -ne $f -and $f.error -eq "staging_token_missing") "failure line parsed from verify output"
    Assert-True ($null -eq (Get-BackupVerifyFailureFromOutput -Output @("{", '"pass": true', "}", "PASS"))) "pretty-printed PASS report is not a failure"
    Assert-True ((Get-LastJsonObjectFromOutput -Output @("x", '{"pass":true,"stagingTokenSource":"EMDASH_STAGING_PAT"}')).stagingTokenSource -eq "EMDASH_STAGING_PAT") "last JSON object line read"
    Assert-True ($null -eq (Get-LastJsonObjectFromOutput -Output @("no json here"))) "no JSON line gives null"

    $rec = New-BackupVerificationRecord -ReportPath (Join-Path $tmp "absent.json") -ExitCode 2 -Output $out
    Assert-True ($rec.pass -eq $false -and $rec.error -eq "staging_token_missing" -and $rec.exitCode -eq 2) "no report: record built from the JSON error line"
    $rec = New-BackupVerificationRecord -ReportPath "" -ExitCode 3 -Output @("boom")
    Assert-True ($rec.pass -eq $false -and $rec.error -eq "verify_no_report" -and $rec.message -match "exited 3") "no report, no JSON: verify_no_report with the exit code"
    $reportPath = Join-Path $tmp "verify.json"
    Set-Content -LiteralPath $reportPath -Value '{"pass":true,"backupCount":3,"liveCount":3,"failures":[]}'
    $rec = New-BackupVerificationRecord -ReportPath $reportPath -ExitCode 0 -Output @()
    Assert-True ($rec.pass -eq $true -and $rec.backupCount -eq 3) "report file wins when present"
    Set-Content -LiteralPath $reportPath -Value 'not json'
    $rec = New-BackupVerificationRecord -ReportPath $reportPath -ExitCode 1 -Output @()
    Assert-True ($rec.pass -eq $false -and $rec.error -eq "verify_report_unreadable") "unreadable report recorded, not thrown"

    $rejected = [pscustomobject]@{ pass = $false; error = "staging_token_rejected"; message = "Staging EmDash rejected the token from EMDASH_STAGING_PAT (HTTP 401)."; stagingTokenSource = "EMDASH_STAGING_PAT" }
    $msg = Format-StagingAuthPreflightFailure -Failure $rejected -ExitCode 2 -FilledFromEnvDev @("EMDASH_STAGING_PAT")
    Assert-True ($msg -match "^STAGING COMPARE CANNOT RUN \(staging_token_rejected\)") "preflight failure names the error kind"
    Assert-True ($msg -match "EMDASH_STAGING_PAT was loaded from \.env\.dev") "preflight failure says the token came from .env.dev"
    Assert-True ($msg -match "Nothing was backed up") "preflight failure says nothing was backed up"
    $msg = Format-StagingAuthPreflightFailure -Failure $rejected -ExitCode 2 -FilledFromEnvDev @()
    Assert-True ($msg -match "overrides \.env\.dev") "preset env token: says it overrides .env.dev"
    $msg = Format-StagingAuthPreflightFailure -Failure $null -ExitCode 2
    Assert-True ($msg -match "staging_check_failed" -and $msg -match "exited 2") "no JSON line: generic kind and exit code"

    $mismatch = [pscustomobject]@{ pass = $false; failures = @("missing in backup: secret-slug") }
    $local = Format-BackupVerifyFailedMessage -Verification $mismatch -VerifyReportPath "v.json" -MetadataPath "m.json"
    Assert-True ($local -match "VERIFY FAILED \(inventory_mismatch\): missing in backup: secret-slug") "local verify failure lists the failures"
    $public = Format-BackupVerifyFailedMessage -Verification $mismatch -VerifyReportPath "v.json" -MetadataPath "m.json" -PublicLog
    Assert-True ($public -match "inventory_mismatch" -and $public -notmatch "secret-slug" -and $public -match "1 failure") "public log: kind and count, no slug"
    $public = Format-BackupVerifyFailedMessage -Verification $rejected -VerifyReportPath "v.json" -MetadataPath "m.json" -PublicLog
    Assert-True ($public -match "\(staging_token_rejected\)" -and $public -notmatch "HTTP 401") "public log: error kind only"
    $local = Format-BackupVerifyFailedMessage -Verification $rejected -VerifyReportPath "v.json" -MetadataPath "m.json" -FilledFromEnvDev @("EMDASH_STAGING_PAT")
    Assert-True ($local -match "staging_token_rejected" -and $local -match "HTTP 401" -and $local -match "verification field") "local: kind, message and where to look"
}
finally {
    $env:PATH = $savedPath
    foreach ($k in $touched) { [Environment]::SetEnvironmentVariable($k, $saved[$k], "Process") }
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "passed=$script:Passed failed=$script:Failed"
if ($script:Failed -gt 0) { exit 1 }
