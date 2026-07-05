
[CmdletBinding()]
param(
    [switch]$SyncCloudflareWorkerSecrets,
    [switch]$AllowProduction,
    [switch]$DryRun,
    [switch]$BumpVersion,
    [switch]$SkipVersionBump
)

<#
.SYNOPSIS
  Build and deploy the production Cloudflare Worker without GitHub Actions.

.DESCRIPTION
  Wrapper around scripts/Invoke-EnvironmentRebuild.ps1 (-Environment production -SkipTerraform).
  Resolves EmDash Turso build credentials from Terraform outputs when present,
  otherwise from repo-root .env.dev. Terraform apply is not required when .env.dev is populated.

  Use -DryRun to verify credential resolution without building or deploying.

.EXAMPLE
  pwsh ./scripts/deploy-production-worker-local.ps1 -AllowProduction -DryRun

.NOTES
  Version bump default: no bump unless -BumpVersion. See web/docs/DEPLOY_TROUBLESHOOTING.md.
  Staging vs production step differences: scripts/Invoke-EnvironmentRebuild.ps1 header table.
#>

& "$PSScriptRoot/Invoke-EnvironmentRebuild.ps1" -Environment production -SkipTerraform @PSBoundParameters
