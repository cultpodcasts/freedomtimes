# Sets FT_BUILD_COMMIT_SHA / FT_BUILD_TREE_DIRTY / GITHUB_REPOSITORY before `npm run build`.
# Dot-source from deploy scripts: . "$PSScriptRoot/build-provenance-env.ps1"

function Set-BuildProvenanceEnv {
    param(
        [string]$RepoRoot = (Split-Path $PSScriptRoot -Parent)
    )

    $git = Get-Command git -ErrorAction SilentlyContinue
    if ($null -eq $git) {
        Write-Warning "git not found; build provenance commit SHA will be unknown."
        return
    }

    $commitSha = (& git -C $RepoRoot rev-parse HEAD 2>$null).Trim()
    if ($commitSha) {
        [Environment]::SetEnvironmentVariable("FT_BUILD_COMMIT_SHA", $commitSha, "Process")
    }

    $dirtyOutput = (& git -C $RepoRoot status --porcelain 2>$null)
    $isDirty = -not [string]::IsNullOrWhiteSpace($dirtyOutput)
    [Environment]::SetEnvironmentVariable("FT_BUILD_TREE_DIRTY", $(if ($isDirty) { "1" } else { "0" }), "Process")

    if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable("GITHUB_REPOSITORY", "Process"))) {
        [Environment]::SetEnvironmentVariable("GITHUB_REPOSITORY", "cultpodcasts/freedomtimes", "Process")
    }
}
