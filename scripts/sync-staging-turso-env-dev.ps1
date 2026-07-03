[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path $PSScriptRoot -Parent
$envDir = Join-Path $repoRoot "infra/terraform/environments/staging"
$envDevPath = Join-Path $repoRoot ".env.dev"

function Resolve-TerraformExecutable {
    $cmd = Get-Command terraform -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source) {
        return $cmd.Source
    }

    $wingetLink = "C:\Users\jonbr\AppData\Local\Microsoft\WinGet\Links\terraform.exe"
    if (Test-Path -LiteralPath $wingetLink) {
        return $wingetLink
    }

    $whereOutput = & where.exe terraform 2>$null
    if ($whereOutput) {
        $first = ($whereOutput | Select-Object -First 1).ToString().Trim()
        if ($first) {
            return $first
        }
    }

    throw "terraform executable not found (checked PATH, WinGet Links, and where.exe)"
}

function Set-Or-AddEnvFileValue {
    param(
        [string]$Path,
        [string]$Key,
        [string]$Value
    )

    if (-not (Test-Path $Path)) {
        throw "Env file not found: $Path"
    }

    $lines = [System.Collections.Generic.List[string]]::new()
    $lines.AddRange([string[]](Get-Content -Path $Path))

    $pattern = "^" + [Regex]::Escape($Key) + "="
    $updated = $false
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match $pattern) {
            $lines[$i] = "$Key=$Value"
            $updated = $true
            break
        }
    }

    if (-not $updated) {
        $lines.Add("$Key=$Value")
    }

    Set-Content -Path $Path -Value $lines -Encoding UTF8
}

function Get-TerraformOutputRaw {
    param(
        [string]$TerraformExe,
        [string]$OutputName
    )

    Push-Location $envDir
    try {
        $value = & $TerraformExe output -raw $OutputName
        if ($LASTEXITCODE -ne 0) {
            throw "terraform output -raw $OutputName failed with exit code $LASTEXITCODE"
        }
        return $value.TrimEnd()
    }
    finally {
        Pop-Location
    }
}

$terraformExe = Resolve-TerraformExecutable
Write-Host "Using terraform: $terraformExe" -ForegroundColor DarkGray
Write-Host "Reading staging outputs from: $envDir" -ForegroundColor DarkGray

$outputMap = [ordered]@{
    subscriptions_turso_database_url       = "TURSO_STAGING_SUBSCRIPTIONS_DB_URL"
    subscriptions_turso_database_auth_token = "TURSO_STAGING_SUBSCRIPTIONS_DB_TOKEN"
    scheduler_turso_database_url           = "TURSO_STAGING_SCHEDULER_DB_URL"
    scheduler_turso_database_auth_token    = "TURSO_STAGING_SCHEDULER_DB_TOKEN"
    tips_turso_database_url                = "TURSO_STAGING_TIPS_DB_URL"
    tips_turso_database_auth_token         = "TURSO_STAGING_TIPS_DB_TOKEN"
}

$updatedKeys = [System.Collections.Generic.List[string]]::new()
foreach ($entry in $outputMap.GetEnumerator()) {
    $tfOutput = $entry.Key
    $envKey = $entry.Value
    $raw = Get-TerraformOutputRaw -TerraformExe $terraformExe -OutputName $tfOutput
    if ([string]::IsNullOrWhiteSpace($raw)) {
        throw "terraform output '$tfOutput' returned an empty value"
    }
    Set-Or-AddEnvFileValue -Path $envDevPath -Key $envKey -Value $raw
    $updatedKeys.Add($envKey)
}

Write-Host "Updated .env.dev keys:" -ForegroundColor Green
foreach ($key in $updatedKeys) {
    Write-Host "  - $key"
}
