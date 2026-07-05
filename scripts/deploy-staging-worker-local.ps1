# Wrapper — shared implementation: scripts/Invoke-EnvironmentRebuild.ps1 (-SkipTerraform)
[CmdletBinding()]
param(
    [switch]$SyncCloudflareWorkerSecrets,
    [switch]$SkipVersionBump
)

& "$PSScriptRoot/Invoke-EnvironmentRebuild.ps1" -Environment staging -SkipTerraform @PSBoundParameters
