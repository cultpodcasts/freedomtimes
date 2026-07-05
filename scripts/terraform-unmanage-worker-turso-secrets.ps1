[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("staging", "production")]
    [string]$Environment,
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path $PSScriptRoot -Parent
$envDir = Join-Path $repoRoot "infra/terraform/environments/$Environment"
. "$PSScriptRoot/ensure-windows-cli-path.ps1"
Initialize-WindowsCliPath

$secretAddresses = @(
    'module.cloudflare_holding_page.cloudflare_workers_secret.script_secrets["TURSO_AUTH_TOKEN"]'
    'module.cloudflare_holding_page.cloudflare_workers_secret.script_secrets["TURSO_DATABASE_URL"]'
)

Push-Location $envDir
try {
    foreach ($address in $secretAddresses) {
        $listed = & terraform state list 2>$null | Where-Object { $_ -eq $address }
        if (-not $listed) {
            Write-Host "[skip] Not in state: $address" -ForegroundColor DarkGray
            continue
        }

        if ($DryRun) {
            Write-Host "[dry-run] terraform state rm $address" -ForegroundColor Yellow
            continue
        }

        Write-Host "Removing from state (live Worker secret unchanged): $address" -ForegroundColor Cyan
        & terraform state rm $address
        if ($LASTEXITCODE -ne 0) {
            throw "terraform state rm failed for $address"
        }
    }
}
finally {
    Pop-Location
}

Write-Host @"
Done. Terraform no longer tracks TURSO_* Worker secrets for $Environment.
Live secrets remain on the Worker; manage them with wrangler / deploy scripts only.
Re-run plan — expect 0 changes and no TURSO secret destroys.
"@ -ForegroundColor Green
