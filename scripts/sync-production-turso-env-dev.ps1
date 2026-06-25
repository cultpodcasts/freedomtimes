[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path $PSScriptRoot -Parent
$envDir = Join-Path $repoRoot "infra/terraform/environments/production"
$envDevPath = Join-Path $repoRoot ".env.dev"

function Normalize-EnvValue {
    param([string]$Value)

    if ([string]::IsNullOrWhiteSpace($Value)) {
        return $Value
    }

    $v = $Value.Trim()
    if (($v.StartsWith('"') -and $v.EndsWith('"')) -or ($v.StartsWith("'") -and $v.EndsWith("'"))) {
        $v = $v.Substring(1, $v.Length - 2)
    }

    return $v.Trim()
}

function Import-EnvFile {
    param([string]$Path)

    if (-not (Test-Path $Path)) {
        return
    }

    Get-Content $Path | ForEach-Object {
        $line = $_.Trim()
        if ([string]::IsNullOrWhiteSpace($line) -or $line.StartsWith("#")) {
            return
        }
        if ($line -match '^[A-Za-z_][A-Za-z0-9_]*=') {
            $parts = $line -split '=', 2
            $key = $parts[0].Trim().Trim([char]0xFEFF)
            $value = Normalize-EnvValue $parts[1]
            [System.Environment]::SetEnvironmentVariable($key, $value, "Process")
        }
    }
}

function Test-LooksLikeTursoDatabaseJwt {
    param([string]$Value)

    if ([string]::IsNullOrWhiteSpace($Value)) {
        return $false
    }

    $v = $Value.Trim()
    return $v.StartsWith("eyJ") -and ($v.Split(".").Count -ge 3)
}

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

function Get-EnvFileValue {
    param(
        [string]$Path,
        [string]$Key
    )

    if (-not (Test-Path $Path)) {
        return $null
    }

    $pattern = "^" + [Regex]::Escape($Key) + "="
    foreach ($line in Get-Content -Path $Path) {
        if ($line -match $pattern) {
            return (Normalize-EnvValue $line.Substring($line.IndexOf("=") + 1))
        }
    }

    return $null
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
        $prevEap = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        $stderrFile = [System.IO.Path]::GetTempFileName()
        $stdoutFile = [System.IO.Path]::GetTempFileName()
        $proc = Start-Process -FilePath $TerraformExe -ArgumentList @("output", "-raw", $OutputName) -Wait -PassThru -NoNewWindow -RedirectStandardOutput $stdoutFile -RedirectStandardError $stderrFile
        $ErrorActionPreference = $prevEap
        $stderr = Get-Content $stderrFile -Raw -ErrorAction SilentlyContinue
        $stdout = Get-Content $stdoutFile -Raw -ErrorAction SilentlyContinue
        Remove-Item $stderrFile, $stdoutFile -Force -ErrorAction SilentlyContinue
        if ($proc.ExitCode -ne 0) {
            if ($stderr -match 'Output "[^"]+" not found') {
                return $null
            }
            throw "terraform output -raw $OutputName failed with exit code $($proc.ExitCode)"
        }
        return $stdout.TrimEnd()
    }
    finally {
        Pop-Location
    }
}

function Get-TursoHostSuffixFromEmdashUrl {
    param([string]$EmdashUrl)

    if ([string]::IsNullOrWhiteSpace($EmdashUrl)) {
        throw "Cannot derive Turso host suffix: production terraform output turso_database_url is missing or empty."
    }

    $hostPart = $EmdashUrl -replace "^libsql://", "" -replace "^https://", ""
    $hostPart = ($hostPart -split "\?")[0]
    $at = $hostPart.LastIndexOf("@")
    if ($at -ge 0) {
        $hostPart = $hostPart.Substring($at + 1)
    }

    if ($hostPart -match "^freedomtimes-emdash-production-(.+)$") {
        return $Matches[1]
    }

    $dash = $hostPart.IndexOf("-")
    if ($dash -lt 0) {
        throw "Unexpected production emdash libsql host '$hostPart'; check terraform output turso_database_url."
    }

    return $hostPart.Substring($dash + 1)
}

function Get-TursoOrganizationFromEnv {
    $org = [System.Environment]::GetEnvironmentVariable("TF_VAR_TURSO_ORGANIZATION", "Process")
    if ([string]::IsNullOrWhiteSpace($org)) {
        $org = [System.Environment]::GetEnvironmentVariable("TF_VAR_turso_organization", "Process")
    }
    if ([string]::IsNullOrWhiteSpace($org)) {
        throw "TF_VAR_TURSO_ORGANIZATION is not set in .env.dev (required to mint Turso DB tokens when Terraform auth_token outputs are missing)."
    }

    return (Normalize-EnvValue $org)
}

function Get-ExistingDatabaseTokenFromEnvFile {
    param([string[]]$TokenKeys)

    foreach ($key in $TokenKeys) {
        $value = Get-EnvFileValue -Path $envDevPath -Key $key
        if (-not [string]::IsNullOrWhiteSpace($value)) {
            return @{ Key = $key; Value = $value }
        }
    }

    return $null
}

function Resolve-TursoPlatformApiToken {
    $candidates = @(
        @{ Name = "TURSO_PLATFORM_API_TOKEN"; AllowJwt = $false },
        @{ Name = "TF_VAR_turso_api_token"; AllowJwt = $false },
        @{ Name = "TURSO_TOKEN"; AllowJwt = $false }
    )
    foreach ($entry in $candidates) {
        $name = $entry.Name
        $value = Normalize-EnvValue ([System.Environment]::GetEnvironmentVariable($name, "Process"))
        if ([string]::IsNullOrWhiteSpace($value)) {
            continue
        }
        if (-not $entry.AllowJwt -and (Test-LooksLikeTursoDatabaseJwt $value)) {
            if ($name -eq "TURSO_TOKEN") {
                Write-Warning "TURSO_TOKEN looks like a libsql database JWT, not a Turso Platform API token; skipping it for API mint."
            }
            else {
                Write-Warning "$name looks like a libsql database JWT, not a Turso Platform API token; skipping it for API mint."
            }
            continue
        }
        return $value
    }

    throw @"
Cannot mint Turso database tokens: set TURSO_PLATFORM_API_TOKEN or TF_VAR_turso_api_token in .env.dev to your Turso Platform API token (Turso dashboard -> Settings -> API tokens).
TURSO_TOKEN may be used only when it is a Platform API token (not a database JWT). Do not put TURSO_AUTH_TOKEN or TURSO_SUBSCRIPTIONS_AUTH_TOKEN in TURSO_TOKEN (see .env.dev.example).
"@
}

function New-TursoDatabaseAuthToken {
    param(
        [string]$Organization,
        [string]$DatabaseName,
        [string]$PlatformApiToken,
        [string]$Expiration = "8760h"
    )

    $encodedOrg = [Uri]::EscapeDataString($Organization)
    $encodedDb = [Uri]::EscapeDataString($DatabaseName)
    $uri = "https://api.turso.tech/v1/organizations/$encodedOrg/databases/$encodedDb/auth/tokens"
    $headers = @{
        Authorization  = "Bearer $PlatformApiToken"
        "Content-Type" = "application/json"
    }
    $body = @{ expiration = $Expiration } | ConvertTo-Json -Compress

    try {
        $response = Invoke-RestMethod -Method Post -Uri $uri -Headers $headers -Body $body
    }
    catch {
        $detail = $_.ErrorDetails.Message
        if ([string]::IsNullOrWhiteSpace($detail)) {
            $detail = $_.Exception.Message
        }
        throw "Turso Platform API token mint failed for database '$DatabaseName': $detail"
    }

    $jwt = $null
    if ($null -ne $response) {
        if ($response.PSObject.Properties.Match("jwt").Count -gt 0) {
            $jwt = [string]$response.jwt
        }
        elseif ($response.PSObject.Properties.Match("token").Count -gt 0) {
            $jwt = [string]$response.token
        }
    }

    if ([string]::IsNullOrWhiteSpace($jwt)) {
        throw "Turso Platform API returned no jwt/token for database '$DatabaseName'."
    }

    return $jwt.Trim()
}

function Resolve-LibsqlUrl {
    param(
        [string]$TerraformExe,
        [string]$UrlOutputName,
        [string]$NameOutputName,
        [string]$HostSuffix
    )

    $url = Get-TerraformOutputRaw -TerraformExe $TerraformExe -OutputName $UrlOutputName
    if (-not [string]::IsNullOrWhiteSpace($url)) {
        return $url
    }

    $dbName = Get-TerraformOutputRaw -TerraformExe $TerraformExe -OutputName $NameOutputName
    if ([string]::IsNullOrWhiteSpace($dbName)) {
        throw "terraform output '$UrlOutputName' is missing and '$NameOutputName' is empty. Ensure the production workspace state includes scheduler/subscriptions Turso database names."
    }

    Write-Warning "terraform output '$UrlOutputName' not in remote state; deriving libsql URL from '$NameOutputName' ($dbName)."
    return "libsql://${dbName}-${HostSuffix}"
}

function Resolve-TursoDatabaseAuthToken {
    param(
        [string]$TerraformExe,
        [string]$TokenOutputName,
        [string]$NameOutputName
    )

    $token = Get-TerraformOutputRaw -TerraformExe $TerraformExe -OutputName $TokenOutputName
    if (-not [string]::IsNullOrWhiteSpace($token)) {
        return $token
    }

    $dbName = Get-TerraformOutputRaw -TerraformExe $TerraformExe -OutputName $NameOutputName
    if ([string]::IsNullOrWhiteSpace($dbName)) {
        throw "terraform output '$TokenOutputName' is missing and '$NameOutputName' is empty; cannot mint a Turso DB token."
    }

    Write-Warning "terraform output '$TokenOutputName' not in remote state; minting token via Turso Platform API for '$dbName'."
    $org = Get-TursoOrganizationFromEnv
    $platformToken = Resolve-TursoPlatformApiToken
    return New-TursoDatabaseAuthToken -Organization $org -DatabaseName $dbName -PlatformApiToken $platformToken
}

# Each Terraform output maps to multiple .env.dev keys (inspect scripts prefer TURSO_*_DATABASE_URL first).
$logicalOutputs = @(
    @{
        UrlOutput  = "subscriptions_turso_database_url"
        NameOutput = "subscriptions_turso_database_name"
        TokenOutput = "subscriptions_turso_database_auth_token"
        EnvKeysUrl = @("TURSO_SUBSCRIPTIONS_DATABASE_URL", "TURSO_PRODUCTION_SUBSCRIPTIONS_DB_URL")
        EnvKeysToken = @("TURSO_SUBSCRIPTIONS_AUTH_TOKEN", "TURSO_PRODUCTION_SUBSCRIPTIONS_DB_TOKEN")
    },
    @{
        UrlOutput  = "scheduler_turso_database_url"
        NameOutput = "scheduler_turso_database_name"
        TokenOutput = "scheduler_turso_database_auth_token"
        EnvKeysUrl = @("TURSO_SCHEDULER_DATABASE_URL", "TURSO_PRODUCTION_SCHEDULER_DB_URL")
        EnvKeysToken = @("TURSO_SCHEDULER_AUTH_TOKEN", "TURSO_PRODUCTION_SCHEDULER_DB_TOKEN")
    }
)

Import-EnvFile -Path $envDevPath

$terraformExe = Resolve-TerraformExecutable
Write-Host "Using terraform: $terraformExe" -ForegroundColor DarkGray
Write-Host "Reading production outputs from: $envDir" -ForegroundColor DarkGray

$productionEmdashUrl = Get-TerraformOutputRaw -TerraformExe $terraformExe -OutputName "turso_database_url"
$hostSuffix = Get-TursoHostSuffixFromEmdashUrl -EmdashUrl $productionEmdashUrl

$updatedKeys = [System.Collections.Generic.List[string]]::new()
foreach ($entry in $logicalOutputs) {
    $url = Resolve-LibsqlUrl -TerraformExe $terraformExe -UrlOutputName $entry.UrlOutput -NameOutputName $entry.NameOutput -HostSuffix $hostSuffix
    if ([string]::IsNullOrWhiteSpace($url)) {
        throw "Resolved empty URL for $($entry.UrlOutput)"
    }

    foreach ($envKey in $entry.EnvKeysUrl) {
        Set-Or-AddEnvFileValue -Path $envDevPath -Key $envKey -Value $url
        $updatedKeys.Add($envKey)
    }

    $existingToken = Get-ExistingDatabaseTokenFromEnvFile -TokenKeys $entry.EnvKeysToken
    if ($null -ne $existingToken) {
        Write-Host "Keeping existing token ($($existingToken.Key)); refreshing URL(s) from Terraform only." -ForegroundColor DarkGray
        continue
    }

    $token = Resolve-TursoDatabaseAuthToken -TerraformExe $terraformExe -TokenOutputName $entry.TokenOutput -NameOutputName $entry.NameOutput
    foreach ($envKey in $entry.EnvKeysToken) {
        Set-Or-AddEnvFileValue -Path $envDevPath -Key $envKey -Value $token
        $updatedKeys.Add($envKey)
    }
}

Write-Host "Updated .env.dev keys:" -ForegroundColor Green
foreach ($key in $updatedKeys) {
    Write-Host "  - $key"
}
