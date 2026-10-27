# Live Worker settings verification (placement region, PAGE_CACHE & other wrangler.jsonc plain_text
# vars, ASSETS binding, last deployed by Wrangler). Dot-source only; defines functions, no side effects.
#
# Shared by scripts/terraform-run.ps1 (after a real apply) and scripts/Deploy-EnvironmentCommon.ps1
# (after wrangler deploy, and when a deploy stops between Terraform apply and wrangler deploy).
# The check itself is web/scripts/verify-worker-placement.mjs (read-only Cloudflare API GETs; it never
# prints the API token). See NON_TERRAFORM_RESOURCES.md § Wrangler-owned Worker settings.
#
# Verifier exit codes: 0 OK, 1 mismatch, 2 usage / auth / API / network error.

# terraform-run.ps1 exit codes for the post-apply check (documented in NON_TERRAFORM_RESOURCES.md).
$script:WorkerSettingsExitMismatch = 4
$script:WorkerSettingsExitUnverified = 5

function Get-WorkerSettingsRedeployHint {
    param([Parameter(Mandatory)][ValidateSet("staging", "production")][string]$Environment)
    if ($Environment -eq "production") { return "pwsh scripts/deploy-production-local.ps1 -WorkerOnly -SkipVersionBump" }
    return "pwsh scripts/deploy-staging-local.ps1 -WorkerOnly -SkipVersionBump"
}

function Invoke-WorkerSettingsVerifier {
    <#
    .SYNOPSIS
      Run web/scripts/verify-worker-placement.mjs and return its exit code as [int].

    .DESCRIPTION
      The verifier's stdout/stderr go to the host, never to this function's output stream, so callers
      can safely do `$code = Invoke-WorkerSettingsVerifier ...` (a leaked line would turn the result
      into an Object[] and `exit $code` into exit 0). $PSNativeCommandUseErrorActionPreference is
      neutralised for the call so a non-zero verifier exit is returned, not thrown.
    #>
    [CmdletBinding()]
    [OutputType([int])]
    param(
        [Parameter(Mandatory)][string]$RepoRoot,
        [Parameter(Mandatory)][ValidateSet("staging", "production")][string]$Environment
    )

    $verifier = Join-Path $RepoRoot "web/scripts/verify-worker-placement.mjs"
    # Function-scoped: shadows a caller's $true for this call only (no restore needed).
    $PSNativeCommandUseErrorActionPreference = $false
    $global:LASTEXITCODE = $null
    try {
        & node $verifier --env $Environment 2>&1 | ForEach-Object { Write-Host $_ }
        $code = $LASTEXITCODE
    }
    catch {
        Write-Host "[verify-worker-placement] could not run the verifier: $($_.Exception.Message)" -ForegroundColor Yellow
        $code = 2
    }
    # No exit code at all (node missing / not run) counts as "could not verify", never as OK.
    if ($null -eq $code) { return [int]2 }
    return [int]$code
}

function Invoke-PostApplyWorkerSettingsCheck {
    <#
    .SYNOPSIS
      After a successful terraform apply on staging/production, verify the live Worker still matches
      web/wrangler.jsonc. Returns the [int] exit code terraform-run.ps1 should exit with.

    .OUTPUTS
      0 = verified OK, deferred to the deploy pipeline (FT_WRANGLER_DEPLOY_FOLLOWS=1), skipped by
          -Skip, or not a Worker environment;
      4 = live settings differ from wrangler.jsonc (redeploy with Wrangler now);
      5 = could not verify (no usable token, API or network error).
    #>
    [CmdletBinding()]
    [OutputType([int])]
    param(
        [Parameter(Mandatory)][string]$RepoRoot,
        [Parameter(Mandatory)][string]$Environment,
        [switch]$Skip
    )

    if ($Environment -ne "staging" -and $Environment -ne "production") { return [int]0 }
    $hint = Get-WorkerSettingsRedeployHint -Environment $Environment
    $manual = "node web/scripts/verify-worker-placement.mjs --env $Environment"
    if ($Skip) {
        Write-Warning "Post-apply Worker settings check SKIPPED (-SkipWorkerSettingsVerification). Verify before walking away: $manual"
        return [int]0
    }
    if ($env:FT_WRANGLER_DEPLOY_FOLLOWS -eq "1") {
        Write-Host "Post-apply Worker settings check deferred: the deploy script runs it after wrangler deploy." -ForegroundColor DarkGray
        return [int]0
    }

    Write-Host "Verifying live Worker settings (placement, PAGE_CACHE, assets) after terraform apply..." -ForegroundColor Cyan
    $code = Invoke-WorkerSettingsVerifier -RepoRoot $RepoRoot -Environment $Environment
    if ($code -eq 0) { return [int]0 }
    if ($code -eq 1) {
        Write-Host "TERRAFORM APPLY CHANGED WRANGLER-OWNED WORKER SETTINGS for $Environment (see FAIL lines above). Restore them now with a Wrangler deploy: $hint" -ForegroundColor Red
        return [int]$script:WorkerSettingsExitMismatch
    }
    Write-Host "COULD NOT VERIFY the live $Environment Worker after a real terraform apply (verifier exit ${code}: no usable Cloudflare token, API or network error). Treat it as changed until checked: $manual  If it fails, redeploy: $hint  (PRODUCTION_RELEASE_RUNBOOK.md 5b)" -ForegroundColor Red
    return [int]$script:WorkerSettingsExitUnverified
}
