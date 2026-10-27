# Pure plan-JSON check for scripts/terraform-plan-guard-worker-script-upload.ps1. Dot-source only.
#
# Why: any create/update/replace of cloudflare_workers_script.holding_page makes provider v5.22
# PUT the Worker script. Its content is the refreshed FIRST multipart part of the live script only
# (content is in ignore_changes), uploaded as main_module "worker.js". The live Astro/EmDash Worker
# is a multi-module Wrangler upload, so that PUT is not a harmless metadata change. Only the deploy
# pipeline (which runs wrangler deploy straight after) or an explicit break-glass may apply it.
# Canonical statement: NON_TERRAFORM_RESOURCES.md § Wrangler-owned Worker settings.

$script:WorkerScriptUploadResourceType = "cloudflare_workers_script"
$script:WorkerScriptUploadResourceName = "holding_page"

function Get-WorkerScriptUploadChanges {
    <#
    .SYNOPSIS
      Return "<address> (<actions>)" for every planned change that would upload the web Worker script.
      Input is the JSON from `terraform show -json <planfile>`. No-op and read actions are ignored.
    #>
    [CmdletBinding()]
    [OutputType([string[]])]
    param([Parameter(Mandatory)][AllowEmptyString()][string]$PlanJson)

    if ([string]::IsNullOrWhiteSpace($PlanJson)) {
        throw "Empty plan JSON: cannot prove the plan leaves the Worker script alone."
    }
    $plan = $PlanJson | ConvertFrom-Json -Depth 100
    $changes = [System.Collections.Generic.List[string]]::new()
    $resourceChanges = if ($plan.PSObject.Properties.Name -contains "resource_changes") { @($plan.resource_changes) } else { @() }
    foreach ($rc in $resourceChanges) {
        if ($null -eq $rc) { continue }
        if ($rc.type -ne $script:WorkerScriptUploadResourceType -or $rc.name -ne $script:WorkerScriptUploadResourceName) { continue }
        if ($rc.PSObject.Properties.Name -contains "mode" -and $rc.mode -ne "managed") { continue }
        $actions = @($rc.change.actions)
        $mutating = @($actions | Where-Object { $_ -ne "no-op" -and $_ -ne "read" })
        if ($mutating.Count -eq 0) { continue }
        $changes.Add("$($rc.address) ($($actions -join ', '))")
    }
    return , $changes.ToArray()
}

function Get-WorkerScriptUploadGuardMessage {
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)][string]$Environment,
        [Parameter(Mandatory)][string[]]$Changes
    )
    $deploy = if ($Environment -eq "production") { "pwsh scripts/deploy-production-local.ps1" } else { "pwsh scripts/deploy-staging-local.ps1" }
    return @"
BLOCKED: this $Environment plan would re-upload the web Worker script outside the deploy pipeline:
  $($Changes -join "$([Environment]::NewLine)  ")

Provider v5.22 re-uploads only the first module of the live multi-module Worker, as worker.js
(NON_TERRAFORM_RESOURCES.md#terraform-holding-page-drift). The plan shows this after every
Wrangler deploy (binding drift), so it is expected in a plan, but it must not be applied on its own.

To change other resources, target them and leave the Worker out, for example:
  pwsh scripts/terraform-run.ps1 -Environment $Environment -Operation apply -AutoApprove -Target 'cloudflare_dns_record.api_custom_hostname'
To apply Worker bindings or secrets (secret_text, PAGE_VIEWS, EMAIL), run the full deploy, which runs
wrangler deploy straight after the apply:
  $deploy
Break-glass only (then redeploy with Wrangler and verify): add -AllowWorkerScriptUpload.
"@
}
