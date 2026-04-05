param(
    [ValidateSet("Staging", "Production")]
    [string]$Target = "Staging",
    [switch]$SyncCloudflareWorkerSecrets,
    [switch]$DryRun,
    [switch]$AllowProduction
)

# --- GUARDRAIL: Prevent accidental production updates ---
if ($Target -eq "Production" -and -not $AllowProduction) {
    Write-Error "[GUARDRAIL] Refusing to update production secrets. Use -AllowProduction to override, but only with explicit approval."
    exit 1
}

# --- DEBUG: Show all parameter values at script start ---
Write-Host "[DEBUG] Script parameters: Target='$Target' SyncCloudflareWorkerSecrets='$SyncCloudflareWorkerSecrets' DryRun='$DryRun'" -ForegroundColor Magenta
Write-Host "[DEBUG] PSBoundParameters: $($PSBoundParameters | Out-String)" -ForegroundColor Magenta

# Main function containing the sync logic
function Main {
    Write-Host "[DEBUG] Main function entered" -ForegroundColor Cyan
    Write-Host "[DEBUG] SyncCloudflareWorkerSecrets: $SyncCloudflareWorkerSecrets" -ForegroundColor Cyan
    Write-Host "[DEBUG] baseEnvPath: $baseEnvPath" -ForegroundColor Cyan
    Write-Host "[DEBUG] stagingEnvPath: $stagingEnvPath" -ForegroundColor Cyan
    Write-Host "[DEBUG] productionEnvPath: $productionEnvPath" -ForegroundColor Cyan
    Write-Host "[DEBUG] About to check $SyncCloudflareWorkerSecrets..." -ForegroundColor Cyan
    if ($SyncCloudflareWorkerSecrets) {
        Write-Host "[DEBUG] Entered Cloudflare Worker secret sync block" -ForegroundColor Cyan
        if ($Target -eq "Staging") {
            Write-Host "\nSyncing Cloudflare Worker secrets for STAGING..." -ForegroundColor Cyan
            Write-Host "Reading credentials from local env: .env.staging" -ForegroundColor Gray
            $stagingEnvValues = Merge-EnvValues -Base $baseEnvValues -Override $stagingOverlayValues
            Write-Host "[DEBUG] stagingEnvValues: $($stagingEnvValues | Out-String)" -ForegroundColor Yellow
            $stagingAuth0Domain = Get-EnvValue -Values $stagingEnvValues -Keys @("AUTH0_DOMAIN", "TF_VAR_auth0_domain")
            Write-Host "[LOG] Setting AUTH0_DOMAIN for staging: '$stagingAuth0Domain'" -ForegroundColor Magenta
            $stagingClientId = Get-EnvValue -Values $stagingEnvValues -Keys @("AUTH0_LOGIN_APP_CLIENT_ID", "AUTH0_CLIENT_ID", "AUTH0_LOGIN_APP_CLIENT_ID_STAGING")
            $stagingClientSecret = Get-EnvValue -Values $stagingEnvValues -Keys @("AUTH0_LOGIN_APP_CLIENT_SECRET", "AUTH0_CLIENT_SECRET", "AUTH0_LOGIN_APP_CLIENT_SECRET_STAGING")
            Write-Host "[DEBUG] Will set AUTH0_CLIENT_ID (from AUTH0_LOGIN_APP_CLIENT_ID): '$stagingClientId'" -ForegroundColor Yellow
            Write-Host "[DEBUG] Will set AUTH0_CLIENT_SECRET (from AUTH0_LOGIN_APP_CLIENT_SECRET): '$stagingClientSecret'" -ForegroundColor Yellow
            Set-WorkerSecret -ConfigPath $stagingWranglerConfig -Name "AUTH0_DOMAIN" -Value $stagingAuth0Domain -WhatIfOnly:$DryRun
            Set-WorkerSecret -ConfigPath $stagingWranglerConfig -Name "AUTH0_CLIENT_ID" -Value $stagingClientId -WhatIfOnly:$DryRun
            Set-WorkerSecret -ConfigPath $stagingWranglerConfig -Name "AUTH0_CLIENT_SECRET" -Value $stagingClientSecret -WhatIfOnly:$DryRun
        }
        elseif ($Target -eq "Production") {
            Write-Host "\nSyncing Cloudflare Worker secrets for PRODUCTION..." -ForegroundColor Red
            Write-Host "Reading credentials from local env: .env.production" -ForegroundColor Gray
            $productionEnvValues = Merge-EnvValues -Base $baseEnvValues -Override $productionOverlayValues
            Write-Host "[DEBUG] productionEnvValues: $($productionEnvValues | Out-String)" -ForegroundColor Yellow
            $productionAuth0Domain = Get-EnvValue -Values $productionEnvValues -Keys @("AUTH0_DOMAIN", "TF_VAR_auth0_domain")
            Write-Host "[LOG] Setting AUTH0_DOMAIN for production: '$productionAuth0Domain'" -ForegroundColor Magenta
            $productionClientId = Get-EnvValue -Values $productionEnvValues -Keys @("AUTH0_CLIENT_ID", "AUTH0_LOGIN_APP_CLIENT_ID", "AUTH0_LOGIN_APP_CLIENT_ID_PRODUCTION")
            $productionClientSecret = Get-EnvValue -Values $productionEnvValues -Keys @("AUTH0_CLIENT_SECRET", "AUTH0_LOGIN_APP_CLIENT_SECRET", "AUTH0_LOGIN_APP_CLIENT_SECRET_PRODUCTION")
            Push-Location (Join-Path $repoRoot "web")
            try {
                Set-WorkerSecret -ConfigPath "wrangler.production.jsonc" -Name "AUTH0_DOMAIN" -Value $productionAuth0Domain -WhatIfOnly:$DryRun
                Set-WorkerSecret -ConfigPath "wrangler.production.jsonc" -Name "AUTH0_CLIENT_ID" -Value $productionClientId -WhatIfOnly:$DryRun
                Set-WorkerSecret -ConfigPath "wrangler.production.jsonc" -Name "AUTH0_CLIENT_SECRET" -Value $productionClientSecret -WhatIfOnly:$DryRun
            }
            finally {
                Pop-Location
            }
        }
    }
}


# --- Function definitions ---
function Parse-EnvFile {
    param([string]$Path)
    $values = @{}
    Get-Content $Path | ForEach-Object {
        $line = $_.Trim()
        if ([string]::IsNullOrWhiteSpace($line) -or $line.StartsWith("#")) {
            return
        }
        if ($line -match '^[A-Za-z_][A-Za-z0-9_]*=') {
            $parts = $line -split '=', 2
            $key = $parts[0].Trim().Trim([char]0xFEFF)
            $value = $parts[1].Trim().Trim([char]0xFEFF)
            $values[$key] = $value
        }
    }
    return $values
}

function Merge-EnvValues {
    param(
        [hashtable]$Base,
        [hashtable]$Override
    )
    $merged = @{}
    if ($null -ne $Base) {
        foreach ($key in $Base.Keys) {
            $merged[$key] = $Base[$key]
        }
    }
    if ($null -ne $Override) {
        foreach ($key in $Override.Keys) {
            $merged[$key] = $Override[$key]
        }
    }
    return $merged
}

function Get-EnvValue {
    param(
        [hashtable]$Values,
        [string[]]$Keys,
        [string]$Default = ""
    )
    foreach ($key in $Keys) {
        if ($Values.ContainsKey($key) -and -not [string]::IsNullOrWhiteSpace([string]$Values[$key])) {
            return [string]$Values[$key]
        }
    }
    return $Default
}

function Set-GhSecret {
    param(
        [string]$Name,
        [string]$Value,
        [string]$Repository,
        [switch]$WhatIfOnly
    )
    if ([string]::IsNullOrWhiteSpace($Value)) {
        Write-Warning "Skipping secret $Name - value is empty in the loaded env values"
        return
    }
    if ($WhatIfOnly) {
        Write-Host "  [dry-run] gh secret set $Name --repo $Repository" -ForegroundColor Yellow
        return
    }
    gh secret set $Name --repo $Repository --body $Value
    Write-Host "  [ok] $Name" -ForegroundColor Green
}

function Set-GhVariable {
    param(
        [string]$Name,
        [string]$Value,
        [string]$Repository,
        [switch]$WhatIfOnly
    )
    if ([string]::IsNullOrWhiteSpace($Value)) {
        Write-Warning "Skipping variable $Name - value is empty in the loaded env values"
        return
    }
    if ($WhatIfOnly) {
        Write-Host "  [dry-run] gh variable set $Name --repo $Repository --body <value>" -ForegroundColor Yellow
        return
    }
    gh variable set $Name --repo $Repository --body $Value
    Write-Host "  [ok] $Name = $Value" -ForegroundColor Green
}

function Get-TfcTokenFromCredentials {
    param([string]$FilePath)
    if (-not (Test-Path $FilePath)) {
        return ""
    }
    try {
        $json = Get-Content $FilePath -Raw | ConvertFrom-Json
        return [string]$json.credentials."app.terraform.io".token
    }
    catch {
        return ""
    }
}

function Set-WorkerSecret {
    param(
        [string]$ConfigPath,
        [string]$Name,
        [string]$Value,
        [switch]$WhatIfOnly
    )
    Write-Host "[DEBUG] Set-WorkerSecret called for $Name (Config: $ConfigPath) Value: '$Value'" -ForegroundColor Cyan
    if ([string]::IsNullOrWhiteSpace($Value)) {
        Write-Warning "Skipping Worker secret $Name for $ConfigPath - value is empty"
        return
    }
    Write-Host "[DEBUG] Would run command: npx wrangler secret put $Name --config $ConfigPath (value: '$Value')" -ForegroundColor Yellow
    if ($WhatIfOnly) {
        Write-Host "  [dry-run] wrangler secret put $Name --config $ConfigPath (value: '$Value')" -ForegroundColor Yellow
        return
    }
    $processInfo = New-Object System.Diagnostics.ProcessStartInfo
    $processInfo.FileName = "npx"
    $processInfo.Arguments = "wrangler secret put $Name --config $ConfigPath"
    $processInfo.RedirectStandardInput = $true
    $processInfo.RedirectStandardOutput = $true
    $processInfo.RedirectStandardError = $true
    $processInfo.UseShellExecute = $false
    $processInfo.CreateNoWindow = $true
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $processInfo
    $process.Start() | Out-Null
    $process.StandardInput.WriteLine($Value)
    $process.StandardInput.Close()
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) {
        Write-Host $stdout -ForegroundColor Red
        Write-Host $stderr -ForegroundColor Red
        throw "Failed to set Worker secret $Name via $ConfigPath"
    }
    Write-Host $stdout -ForegroundColor Green
    Write-Host "  [ok] Worker secret $Name via $ConfigPath" -ForegroundColor Green
}

function Add-EntryIfTargetMatches {
    param(
        [System.Collections.IDictionary]$Map,
        [string]$Name,
        [string]$Value,
        [string]$EntryTarget,
        [string]$RequestedTarget
    )
    if ($RequestedTarget -eq "All" -or $RequestedTarget -eq $EntryTarget) {
        $Map[$Name] = $Value
    }
}

# --- Main script logic ---
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot ".."))
$baseEnvPath = Join-Path $repoRoot ".env.dev"
$stagingEnvPath = Join-Path $repoRoot ".env.staging"
$productionEnvPath = Join-Path $repoRoot ".env.production"
$stagingWranglerConfig = Join-Path $repoRoot "web/wrangler.jsonc --env staging"
$productionWranglerConfig = Join-Path $repoRoot "web/wrangler.jsonc --env production"

$baseEnvValues = if (Test-Path $baseEnvPath) { Parse-EnvFile -Path $baseEnvPath } else { @{} }
$stagingOverlayValues = if (Test-Path $stagingEnvPath) { Parse-EnvFile -Path $stagingEnvPath } else { @{} }
$productionOverlayValues = if (Test-Path $productionEnvPath) { Parse-EnvFile -Path $productionEnvPath } else { @{} }

Main @PSBoundParameters

# --- DEBUG: Show all parameter values at script start ---
Write-Host "[DEBUG] Script parameters: Target='$Target' SyncCloudflareWorkerSecrets='$SyncCloudflareWorkerSecrets' DryRun='$DryRun'" -ForegroundColor Magenta
Write-Host "[DEBUG] PSBoundParameters: $($PSBoundParameters | Out-String)" -ForegroundColor Magenta






