# Wrapper — shared implementation and staging vs production differences: scripts/Invoke-EnvironmentRebuild.ps1
[CmdletBinding()]
param(
    [switch]$SkipVersionBump
)

& "$PSScriptRoot/Invoke-EnvironmentRebuild.ps1" -Environment staging @PSBoundParameters
