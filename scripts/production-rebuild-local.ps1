# Wrapper — shared implementation and staging vs production differences: scripts/Invoke-EnvironmentRebuild.ps1
#
# Version bump default: does NOT bump web/package.json by default — production ships the same
# version staging already bumped this release. Pass -BumpVersion to bump anyway.
[CmdletBinding()]
param(
    [switch]$BumpVersion,
    [switch]$SkipVersionBump
)

& "$PSScriptRoot/Invoke-EnvironmentRebuild.ps1" -Environment production @PSBoundParameters
