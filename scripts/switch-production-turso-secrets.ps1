[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$DatabaseUrl,
    [Parameter(Mandatory = $true)]
    [string]$AuthToken,
    [string]$DatabaseName,
    [string]$Repository = "cultpodcasts/freedomtimes",
    [switch]$SyncGitHub,
    [switch]$AllowProduction,
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $AllowProduction) {
    throw "Refusing to switch production Turso secrets without -AllowProduction."
}

function Test-CommandAvailable {
    param([string]$CommandName)
    return $null -ne (Get-Command $CommandName -ErrorAction SilentlyContinue)
}

function Set-WorkerSecret {
    param(
        [string]$ConfigPath,
        [string]$Environment,
        [string]$Name,
        [string]$Value,
        [switch]$WhatIfOnly
    )

    if ([string]::IsNullOrWhiteSpace($Value)) {
        throw "Worker secret '$Name' value cannot be empty."
    }

    if ($WhatIfOnly) {
        Write-Host "[dry-run] npx wrangler secret put $Name --config $ConfigPath --env $Environment" -ForegroundColor Yellow
        return
    }

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = "npx"
    $psi.Arguments = "wrangler secret put $Name --config `"$ConfigPath`" --env $Environment"
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true

    $proc = New-Object System.Diagnostics.Process
    $proc.StartInfo = $psi
    $proc.Start() | Out-Null
    $proc.StandardInput.WriteLine($Value)
    $proc.StandardInput.Close()

    $stdout = $proc.StandardOutput.ReadToEnd()
    $stderr = $proc.StandardError.ReadToEnd()
    $proc.WaitForExit()

    if ($proc.ExitCode -ne 0) {
        if (-not [string]::IsNullOrWhiteSpace($stdout)) {
            Write-Host $stdout -ForegroundColor Red
        }
        if (-not [string]::IsNullOrWhiteSpace($stderr)) {
            Write-Host $stderr -ForegroundColor Red
        }
        throw "Failed to set production Worker secret '$Name'."
    }

    Write-Host "[ok] Worker secret $Name updated for production" -ForegroundColor Green
}

if (-not (Test-CommandAvailable -CommandName "npx")) {
    throw "npx is required to switch Cloudflare Worker secrets."
}

if ($SyncGitHub -and -not (Test-CommandAvailable -CommandName "gh")) {
    throw "gh is required for -SyncGitHub."
}

$repoRoot = Split-Path $PSScriptRoot -Parent
$wranglerConfigPath = Join-Path $repoRoot "web/wrangler.jsonc"

if (-not (Test-Path $wranglerConfigPath)) {
    throw "Wrangler config not found at $wranglerConfigPath"
}

Write-Host "Updating production Worker Turso secrets" -ForegroundColor Cyan
Set-WorkerSecret -ConfigPath $wranglerConfigPath -Environment "production" -Name "TURSO_DATABASE_URL" -Value $DatabaseUrl -WhatIfOnly:$DryRun
Set-WorkerSecret -ConfigPath $wranglerConfigPath -Environment "production" -Name "TURSO_AUTH_TOKEN" -Value $AuthToken -WhatIfOnly:$DryRun

if ($SyncGitHub) {
    if ($DryRun) {
        Write-Host "[dry-run] gh secret set TURSO_TOKEN --repo $Repository --body <redacted>" -ForegroundColor Yellow
    }
    else {
        gh secret set TURSO_TOKEN --repo $Repository --body $AuthToken
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to update GitHub secret TURSO_TOKEN"
        }
        Write-Host "[ok] GitHub secret TURSO_TOKEN updated" -ForegroundColor Green
    }

    if (-not [string]::IsNullOrWhiteSpace($DatabaseName)) {
        if ($DryRun) {
            Write-Host "[dry-run] gh variable set TF_VAR_TURSO_DATABASE_NAME_PRODUCTION --repo $Repository --body $DatabaseName" -ForegroundColor Yellow
        }
        else {
            gh variable set TF_VAR_TURSO_DATABASE_NAME_PRODUCTION --repo $Repository --body $DatabaseName
            if ($LASTEXITCODE -ne 0) {
                throw "Failed to update GitHub variable TF_VAR_TURSO_DATABASE_NAME_PRODUCTION"
            }
            Write-Host "[ok] GitHub variable TF_VAR_TURSO_DATABASE_NAME_PRODUCTION updated" -ForegroundColor Green
        }
    }
    elseif (-not $DryRun) {
        Write-Warning "-SyncGitHub was used without -DatabaseName. TF_VAR_TURSO_DATABASE_NAME_PRODUCTION was not updated."
    }
}

Write-Host "Production Turso secret switch complete." -ForegroundColor Green