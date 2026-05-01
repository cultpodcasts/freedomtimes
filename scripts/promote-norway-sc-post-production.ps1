
[CmdletBinding()]
param(
    [string]$Slug = "norway-supreme-court-rules-in-jehovahs-witnesses-case-what-happened-what-it-mean"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path $PSScriptRoot -Parent
$script = Join-Path $repoRoot "web\scripts\promote-post-staging-to-production.mjs"

if (-not (Test-Path $script)) {
    throw "Missing $script"
}

Write-Host "Delegating to Node promoter (media + bylines + UTF-8-safe data)..." -ForegroundColor Cyan
Push-Location $repoRoot
try {
    & node $script posts $Slug
    if ($LASTEXITCODE -ne 0) {
        throw "promote-post-staging-to-production.mjs failed with exit code $LASTEXITCODE"
    }
}
finally {
    Pop-Location
}
