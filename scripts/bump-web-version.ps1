# Bumps the semver version in web/package.json (and web/package-lock.json) before a deploy build.
# Dot-source from deploy scripts: . "$PSScriptRoot/bump-web-version.ps1"
# Then call: Invoke-WebVersionBump -RepoRoot $repoRoot [-Bump patch|minor|major]
#
# Uses `npm version <bump> --no-git-tag-version --allow-same-version` inside web/, which updates
# both web/package.json and web/package-lock.json in place. This intentionally does NOT create a
# git commit or tag, and does NOT push anything — the bump lands in the working tree only, same as
# any other build output. Commit it yourself (e.g. alongside the change that triggered the deploy,
# or as its own "chore: bump web version" commit) if you want the new version to persist in git.
#
# Why bump before build (not after deploy): the version is baked into the build the same way
# FT_BUILD_COMMIT_SHA is (see build-provenance-env.ps1) — running this first means the artifact
# that gets deployed already reflects the new version.

function Invoke-WebVersionBump {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot,

        [ValidateSet("patch", "minor", "major")]
        [string]$Bump = "patch"
    )

    $webDir = Join-Path $RepoRoot "web"
    $packageJsonPath = Join-Path $webDir "package.json"
    if (-not (Test-Path $packageJsonPath)) {
        throw "Cannot bump version: $packageJsonPath not found."
    }

    $previousVersion = (Get-Content $packageJsonPath -Raw | ConvertFrom-Json).version

    Push-Location $webDir
    try {
        $npmOutput = & npm version $Bump --no-git-tag-version --allow-same-version
        if ($LASTEXITCODE -ne 0) {
            throw "npm version $Bump failed in $webDir."
        }
        $newVersion = ([string]$npmOutput).Trim().TrimStart('v')
    }
    finally {
        Pop-Location
    }

    Write-Host "[version] web/package.json: $previousVersion -> $newVersion (uncommitted; commit web/package.json + web/package-lock.json to persist)" -ForegroundColor Cyan

    return $newVersion
}
