# Tests for scripts/lib/PathEntry.ps1 (#114): the native-Turso ~/.turso/turso fallback must change
# $env:PATH on Linux (case-sensitive env names) and on Windows (case-insensitive). No network, no
# Turso: a fake CLI in a temp HOME. Runs on Linux (CI: ci-guards.yml) and Windows (local).
# Run: pwsh -NoProfile -File ./scripts/test-path-entry.ps1
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

. "$PSScriptRoot/lib/PathEntry.ps1"

$script:Failed = 0
$script:Passed = 0
function Assert-True {
    param([bool]$Condition, [string]$Message)
    if ($Condition) { $script:Passed++; Write-Host "ok  $Message" }
    else { $script:Failed++; Write-Host "FAIL  $Message" -ForegroundColor Red }
}

$sep = [IO.Path]::PathSeparator
$savedPath = $env:PATH
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("ft-pathentry-test-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tmp | Out-Null
$emptyDir = Join-Path $tmp "empty"
New-Item -ItemType Directory -Path $emptyDir | Out-Null
# A PATH with no turso on it but the OS basics (so Get-Command works normally).
$bareSystemPath = if ($IsWindows) { "$emptyDir$sep$env:SystemRoot\System32" } else { "$emptyDir$sep/usr/bin$sep/bin" }

function New-FakeHomeWithTurso {
    param([string]$Name, [switch]$NotExecutable)
    $homeDir = Join-Path $tmp $Name
    $dir = Join-Path $homeDir ".turso"
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    if ($IsWindows) {
        # Any real executable renamed turso.exe resolves through PATHEXT like the real CLI.
        Copy-Item -LiteralPath (Join-Path $env:SystemRoot "System32\whoami.exe") -Destination (Join-Path $dir "turso.exe")
    }
    else {
        $shim = Join-Path $dir "turso"
        Set-Content -LiteralPath $shim -Value "#!/bin/sh`necho fake-turso `"`$@`"" -NoNewline
        if (-not $NotExecutable) { & chmod +x $shim }
    }
    return $homeDir
}

try {
    Write-Host "=== Add-PathEntry / Test-PathEntryPresent ==="
    $env:PATH = $bareSystemPath
    $d1 = Join-Path $tmp "d1"
    Add-PathEntry -Directory $d1
    Assert-True ($env:PATH.StartsWith("$d1$sep")) "Add-PathEntry prepends to `$env:PATH"
    Assert-True ($env:PATH -eq "$d1$sep$bareSystemPath") "rest of PATH is unchanged"
    if ($IsWindows) {
        Assert-True ($env:Path -eq $env:PATH) "Windows: `$env:Path and `$env:PATH are the same variable"
    }
    else {
        Assert-True ($null -eq [Environment]::GetEnvironmentVariable("Path", "Process")) "Linux: no separate 'Path' variable is created"
    }
    Add-PathEntry -Directory $d1
    Assert-True (@($env:PATH.Split($sep) | Where-Object { $_ -eq $d1 }).Count -eq 1) "adding the same directory twice is a no-op"
    Add-PathEntry -Directory "$d1$([IO.Path]::DirectorySeparatorChar)"
    Assert-True (@($env:PATH.Split($sep)).Count -eq @("$d1$sep$bareSystemPath".Split($sep)).Count) "a trailing separator counts as the same entry"
    $upper = $d1.ToUpperInvariant()
    if ($IsWindows) {
        Assert-True (Test-PathEntryPresent -Directory $upper -PathValue $env:PATH) "Windows: entries compare case-insensitively"
    }
    else {
        Assert-True (-not (Test-PathEntryPresent -Directory $upper -PathValue $env:PATH)) "Linux: entries compare case-sensitively"
    }
    Assert-True (-not (Test-PathEntryPresent -Directory $d1 -PathValue "")) "empty PATH has no entries"
    $env:PATH = ""
    Add-PathEntry -Directory $d1
    Assert-True ($env:PATH -eq $d1) "empty PATH becomes just the directory (no leading separator)"

    if (-not $IsWindows) {
        Write-Host "=== Linux: the #114 bug this replaces ==="
        $env:PATH = $bareSystemPath
        $env:Path = "/x$sep$env:PATH"
        Assert-True (-not $env:PATH.StartsWith("/x$sep")) "Linux: `$env:Path = ... leaves `$env:PATH untouched (why the old fallback did nothing)"
        Remove-Item Env:Path -ErrorAction SilentlyContinue
    }

    Write-Host "=== Initialize-NativeTursoCli ==="
    $fakeHome = New-FakeHomeWithTurso -Name "home-ok"
    $env:PATH = $bareSystemPath
    Assert-True ($null -eq (Get-Command turso -ErrorAction SilentlyContinue)) "precondition: turso is not on the bare PATH"
    $resolved = Initialize-NativeTursoCli -HomeDirectory $fakeHome -MissingMessage "missing"
    $expectedDir = Join-Path $fakeHome ".turso"
    Assert-True ($env:PATH.StartsWith("$expectedDir$sep")) "turso absent from PATH: ~/.turso is prepended to `$env:PATH"
    Assert-True ($null -ne (Get-Command turso -ErrorAction SilentlyContinue)) "turso now resolves via Get-Command"
    Assert-True ((Split-Path $resolved -Parent) -eq $expectedDir) "returns the ~/.turso CLI path"
    if (-not $IsWindows) {
        Assert-True ((& turso db list) -eq "fake-turso db list") "& turso runs the ~/.turso CLI (as the backup / DR calls do)"
    }
    $before = $env:PATH
    $again = Initialize-NativeTursoCli -HomeDirectory (Join-Path $tmp "no-such-home") -MissingMessage "missing"
    Assert-True ($env:PATH -eq $before -and $again -eq $resolved) "turso already on PATH: PATH unchanged, existing CLI returned"

    $env:PATH = $bareSystemPath
    $threw = $null
    try { $null = Initialize-NativeTursoCli -HomeDirectory (Join-Path $tmp "no-such-home") -MissingMessage "Turso CLI not on PATH (test)" } catch { $threw = $_.Exception.Message }
    Assert-True ($threw -eq "Turso CLI not on PATH (test)") "no turso anywhere: throws the caller's message"
    Assert-True ($env:PATH -eq $bareSystemPath) "no turso anywhere: PATH unchanged"

    if (-not $IsWindows) {
        $nx = New-FakeHomeWithTurso -Name "home-noexec" -NotExecutable
        $env:PATH = $bareSystemPath
        $threw = $null
        try { $null = Initialize-NativeTursoCli -HomeDirectory $nx -MissingMessage "missing" } catch { $threw = $_.Exception.Message }
        Assert-True ($env:PATH -eq $bareSystemPath) "Linux: non-executable ~/.turso/turso leaves PATH unchanged"
        Assert-True ($null -ne $threw -and $threw -match "is not executable: chmod \+x") "Linux: non-executable ~/.turso/turso fails here with a clear message, not later as 'command not found'"
    }

    Write-Host "=== scripts use the helper, not `$env:Path ==="
    $env:PATH = $savedPath
    foreach ($name in "backup-production-emdash.ps1", "disaster-recover-production-emdash.ps1", "turso-create-rollback-branch.ps1") {
        $text = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot $name)
        Assert-True ($text -match '(?m)^\. "\$PSScriptRoot/lib/PathEntry\.ps1"') "$name dot-sources lib/PathEntry.ps1"
        Assert-True ($text -match 'Initialize-NativeTursoCli -MissingMessage') "$name resolves native turso with Initialize-NativeTursoCli"
        Assert-True ($text -notmatch '\.turso/turso"\)?\s*\r?\n\s*if \(Test-Path') "$name has no hand-rolled ~/.turso fallback left"
    }
    # Windows-only scripts may keep $env:Path (case-insensitive there); everything else must use $env:PATH.
    $pathAssign = '\$env:Path\s*\+?='
    Assert-True ('$env:Path = "x"' -cmatch $pathAssign) "guard regex matches `$env:Path ="
    Assert-True ('$env:Path += ";x"' -cmatch $pathAssign) "guard regex matches `$env:Path +="
    Assert-True ('$env:Path+=":x"' -cmatch $pathAssign) "guard regex matches `$env:Path+="
    Assert-True (-not ('$env:PATH = "x"' -cmatch $pathAssign)) "guard regex allows `$env:PATH ="
    $windowsOnly = @("build-android-capacitor.ps1", "ensure-windows-cli-path.ps1")
    $offenders = @(Get-ChildItem -LiteralPath $PSScriptRoot -Filter *.ps1 -Recurse |
        Where-Object { $windowsOnly -notcontains $_.Name -and $_.Name -ne "test-path-entry.ps1" } |
        Where-Object { (Get-Content -Raw -LiteralPath $_.FullName) -cmatch $pathAssign } |
        ForEach-Object { $_.Name })
    Assert-True ($offenders.Count -eq 0) "no cross-platform script assigns `$env:Path (found: $($offenders -join ', '))"
}
finally {
    $env:PATH = $savedPath
    if (-not $IsWindows) { Remove-Item Env:Path -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "passed=$script:Passed failed=$script:Failed"
if ($script:Failed -gt 0) { exit 1 }
exit 0
