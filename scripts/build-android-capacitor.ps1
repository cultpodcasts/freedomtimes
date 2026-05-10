<#
.SYNOPSIS
  Sync Capacitor Android and build a Debug or Release APK for staging or production server URL.

.DESCRIPTION
  Sets CAPACITOR_SERVER_URL (read by web/capacitor.config.ts during `cap sync`), runs `npm run cap:sync:android`
  from web/, then Gradle assembleDebug or assembleRelease.

.PARAMETER BuildType
  Debug (default) or Release.

.PARAMETER Target
  Staging → https://staging.freedomtimes.news
  Production → https://freedomtimes.news

.PARAMETER JavaHome
  Optional JDK root (directory containing bin\java.exe). If omitted, uses $env:JAVA_HOME or a common Android Studio JDK path.

.PARAMETER SkipCapSync
  Only run Gradle (use only if assets/config are already synced for this Target).

.PARAMETER RefreshLauncherIcons
  Run `npm run android:launcher-icons` before sync (regenerates launcher PNGs from web/public/favicon.svg).

.EXAMPLE
  .\scripts\build-android-capacitor.ps1 -BuildType Debug -Target Staging

.EXAMPLE
  .\scripts\build-android-capacitor.ps1 -BuildType Release -Target Production -JavaHome 'C:\Program Files\Android\openjdk\jdk-21.0.8'
#>

[CmdletBinding()]
param(
    [Parameter()]
    [ValidateSet('Debug', 'Release')]
    [string]$BuildType = 'Debug',

    [Parameter()]
    [ValidateSet('Staging', 'Production')]
    [string]$Target = 'Staging',

    [Parameter()]
    [string]$JavaHome = '',

    [switch]$SkipCapSync,

    [switch]$RefreshLauncherIcons
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path $PSScriptRoot -Parent
$webRoot = Join-Path $repoRoot 'web'
$androidRoot = Join-Path $webRoot 'android'
$gradleBat = Join-Path $androidRoot 'gradlew.bat'

function Write-Step {
    param([string]$Message)
    $ts = Get-Date -Format 'yyyy-MM-ddTHH:mm:ssK'
    Write-Host "[$ts] $Message" -ForegroundColor Cyan
}

if (-not (Test-Path $gradleBat)) {
    throw "Gradle wrapper not found at $gradleBat"
}

$serverUrl = if ($Target -eq 'Production') {
    'https://freedomtimes.news'
} else {
    'https://staging.freedomtimes.news'
}

$jdk = if ($JavaHome) { $JavaHome.Trim() } else { '' }
if (-not $jdk -and $env:JAVA_HOME) {
    $jdk = $env:JAVA_HOME.Trim()
}
if (-not $jdk) {
    $candidate = 'C:\Program Files\Android\openjdk\jdk-21.0.8'
    if (Test-Path (Join-Path $candidate 'bin\java.exe')) {
        $jdk = $candidate
    }
}
if (-not $jdk -or -not (Test-Path (Join-Path $jdk 'bin\java.exe'))) {
    throw "JDK not found. Set -JavaHome or JAVA_HOME to a JDK root (e.g. C:\Program Files\Android\openjdk\jdk-21.0.8)."
}

$env:JAVA_HOME = $jdk
$env:Path = "$jdk\bin;$env:Path"

$env:CAPACITOR_SERVER_URL = $serverUrl

Write-Step "Target=$Target server URL: $serverUrl"
Write-Step "BuildType=$BuildType (JAVA_HOME=$jdk)"

if ($RefreshLauncherIcons) {
    Write-Step "Refreshing launcher icons from favicon.svg"
    Push-Location $webRoot
    try {
        & npm run android:launcher-icons
        if ($LASTEXITCODE -ne 0) { throw "android:launcher-icons failed." }
    }
    finally {
        Pop-Location
    }
}

if (-not $SkipCapSync) {
    Write-Step "Capacitor sync (android)"
    Push-Location $webRoot
    try {
        & npm run cap:sync:android
        if ($LASTEXITCODE -ne 0) { throw "cap:sync:android failed." }
    }
    finally {
        Pop-Location
    }
}

$gradleTask = if ($BuildType -eq 'Release') { 'assembleRelease' } else { 'assembleDebug' }
Write-Step "Gradle $gradleTask"

Push-Location $androidRoot
try {
    & .\gradlew.bat $gradleTask
    if ($LASTEXITCODE -ne 0) { throw "Gradle $gradleTask failed." }
}
finally {
    Pop-Location
}

$apkDir = Join-Path $androidRoot 'app\build\outputs\apk'
if ($BuildType -eq 'Release') {
    $apkPath = Join-Path $apkDir 'release\app-release.apk'
    if (-not (Test-Path $apkPath)) {
        $apkPath = Join-Path $apkDir 'release\app-release-unsigned.apk'
    }
} else {
    $apkPath = Join-Path $apkDir 'debug\app-debug.apk'
}

Write-Step "Build finished."
if (Test-Path $apkPath) {
    Write-Host "APK: $apkPath" -ForegroundColor Green
} else {
    Write-Warning "Expected APK not found at $apkPath — check app/build/outputs/apk/"
}
