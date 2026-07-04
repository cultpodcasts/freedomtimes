Set-StrictMode -Version Latest

<#
.SYNOPSIS
  Resolve EmDash Turso build credentials for Astro (TURSO_DATABASE_URL + TURSO_AUTH_TOKEN).

.DESCRIPTION
  Prefers Terraform outputs when present; falls back to repo-root .env.dev (and optional
  production-prefixed aliases). Does not require terraform apply when .env.dev is populated.

  Dot-source this file and call Set-TursoBuildEnv.
#>

function Import-EnvFileForTurso {
    param([string]$Path)

    if (-not (Test-Path $Path)) {
        return
    }

    Get-Content $Path | ForEach-Object {
        $line = $_.Trim()
        if ([string]::IsNullOrWhiteSpace($line) -or $line.StartsWith("#")) { return }
        if ($line -match '^[A-Za-z_][A-Za-z0-9_]*=') {
            $parts = $line -split '=', 2
            $key = $parts[0].Trim().Trim([char]0xFEFF)
            $value = $parts[1].Trim().Trim([char]0xFEFF)
            if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
                $value = $value.Substring(1, $value.Length - 2)
            }
            [Environment]::SetEnvironmentVariable($key, $value, "Process")
        }
    }
}

function Get-EnvFileValueForTurso {
    param(
        [string]$Path,
        [string]$Key
    )

    if (-not (Test-Path $Path)) { return "" }

    $pattern = "^" + [Regex]::Escape($Key) + "="
    foreach ($line in Get-Content -Path $Path) {
        if ($line -match $pattern) {
            $value = $line.Substring($line.IndexOf("=") + 1).Trim()
            if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
                $value = $value.Substring(1, $value.Length - 2)
            }
            return $value.Trim()
        }
    }

    return ""
}

function Get-FirstNonEmptyTursoValue {
    param([string[]]$Values)

    foreach ($value in $Values) {
        if (-not [string]::IsNullOrWhiteSpace($value)) {
            return $value.Trim()
        }
    }
    return ""
}

function Test-IsProductionEmdashLibsqlUrl {
    param([string]$Url)
    return (-not [string]::IsNullOrWhiteSpace($Url)) -and ($Url -match 'freedomtimes-emdash-production')
}

function Get-TursoHostSuffixFromLibsqlUrl {
    param([string]$Url)

    if ([string]::IsNullOrWhiteSpace($Url)) {
        throw "Cannot derive Turso host suffix from an empty libsql URL."
    }

    $hostPart = $Url -replace "^libsql://", "" -replace "^https://", ""
    $hostPart = ($hostPart -split "\?")[0]
    $at = $hostPart.LastIndexOf("@")
    if ($at -ge 0) {
        $hostPart = $hostPart.Substring($at + 1)
    }

    if ($hostPart -match "^freedomtimes-(?:emdash|subscriptions|scheduler|tips)-(?:staging|production)-(.+)$") {
        return $Matches[1]
    }

    $dash = $hostPart.IndexOf("-")
    if ($dash -lt 0) {
        throw "Unexpected Turso libsql host '$hostPart'."
    }

    return $hostPart.Substring($dash + 1)
}

function Get-ProductionTursoHostSuffixFromEnv {
    param(
        [string]$EnvDevPath,
        [string]$TerraformExe,
        [string]$TerraformEnvDir
    )

    $suffixSourceKeys = @(
        "TURSO_PRODUCTION_EMDASH_DB_URL",
        "TURSO_SUBSCRIPTIONS_DATABASE_URL",
        "TURSO_PRODUCTION_SUBSCRIPTIONS_DB_URL",
        "TURSO_SCHEDULER_DATABASE_URL",
        "TURSO_PRODUCTION_SCHEDULER_DB_URL",
        "TURSO_TIPS_DATABASE_URL",
        "TURSO_PRODUCTION_TIPS_DB_URL"
    )

    foreach ($key in $suffixSourceKeys) {
        $candidate = Get-FirstNonEmptyTursoValue @(
            ([Environment]::GetEnvironmentVariable($key, "Process")),
            (Get-EnvFileValueForTurso -Path $EnvDevPath -Key $key)
        )
        if (-not [string]::IsNullOrWhiteSpace($candidate)) {
            return @{
                Suffix = Get-TursoHostSuffixFromLibsqlUrl -Url $candidate
                Source = $key
            }
        }
    }

    $terraformEmdashUrl = Try-TerraformOutputRaw -TerraformExe $TerraformExe -TerraformEnvDir $TerraformEnvDir -OutputName "turso_database_url"
    if (-not [string]::IsNullOrWhiteSpace($terraformEmdashUrl)) {
        return @{
            Suffix = Get-TursoHostSuffixFromLibsqlUrl -Url $terraformEmdashUrl
            Source = "terraform output turso_database_url"
        }
    }

    throw @"
Cannot derive production Turso host suffix. Set one of these in .env.dev to a libsql:// URL:
  $($suffixSourceKeys -join ', ')
Or run: pwsh ./scripts/sync-production-turso-env-dev.ps1
"@
}

function Try-TerraformOutputRaw {
    param(
        [string]$TerraformExe,
        [string]$TerraformEnvDir,
        [string]$OutputName
    )

    Push-Location $TerraformEnvDir
    try {
        $stderrFile = [System.IO.Path]::GetTempFileName()
        $stdoutFile = [System.IO.Path]::GetTempFileName()
        $proc = Start-Process -FilePath $TerraformExe -ArgumentList @("output", "-raw", $OutputName) -Wait -PassThru -NoNewWindow -RedirectStandardOutput $stdoutFile -RedirectStandardError $stderrFile
        $stderr = Get-Content $stderrFile -Raw -ErrorAction SilentlyContinue
        $stdout = Get-Content $stdoutFile -Raw -ErrorAction SilentlyContinue
        Remove-Item $stderrFile, $stdoutFile -Force -ErrorAction SilentlyContinue
        if ($proc.ExitCode -ne 0) {
            return $null
        }
        if ([string]::IsNullOrWhiteSpace($stdout)) {
            return $null
        }
        return $stdout.TrimEnd()
    }
    finally {
        Pop-Location
    }
}

function Resolve-ProductionEmdashTursoUrl {
    param(
        [string]$EnvDevPath,
        [string]$TerraformExe,
        [string]$TerraformEnvDir
    )

    $terraformUrl = Try-TerraformOutputRaw -TerraformExe $TerraformExe -TerraformEnvDir $TerraformEnvDir -OutputName "turso_database_url"
    if (-not [string]::IsNullOrWhiteSpace($terraformUrl)) {
        return @{ Value = $terraformUrl; Source = "terraform output turso_database_url" }
    }

    $directUrl = Get-FirstNonEmptyTursoValue @(
        ([Environment]::GetEnvironmentVariable("TURSO_PRODUCTION_EMDASH_DB_URL", "Process")),
        (Get-EnvFileValueForTurso -Path $EnvDevPath -Key "TURSO_PRODUCTION_EMDASH_DB_URL")
    )
    if (-not [string]::IsNullOrWhiteSpace($directUrl)) {
        return @{ Value = $directUrl; Source = "TURSO_PRODUCTION_EMDASH_DB_URL" }
    }

    $sharedUrl = Get-FirstNonEmptyTursoValue @(
        ([Environment]::GetEnvironmentVariable("TURSO_DATABASE_URL", "Process")),
        (Get-EnvFileValueForTurso -Path $EnvDevPath -Key "TURSO_DATABASE_URL")
    )
    if (Test-IsProductionEmdashLibsqlUrl -Url $sharedUrl) {
        return @{ Value = $sharedUrl; Source = "TURSO_DATABASE_URL (production emdash)" }
    }

    $dbName = Get-FirstNonEmptyTursoValue @(
        (Try-TerraformOutputRaw -TerraformExe $TerraformExe -TerraformEnvDir $TerraformEnvDir -OutputName "turso_database_name"),
        ([Environment]::GetEnvironmentVariable("TF_VAR_TURSO_DATABASE_NAME_PRODUCTION", "Process")),
        (Get-EnvFileValueForTurso -Path $EnvDevPath -Key "TF_VAR_TURSO_DATABASE_NAME_PRODUCTION"),
        "freedomtimes-emdash-production"
    )

    $suffixInfo = Get-ProductionTursoHostSuffixFromEnv -EnvDevPath $EnvDevPath -TerraformExe $TerraformExe -TerraformEnvDir $TerraformEnvDir
    $derived = "libsql://${dbName}-$($suffixInfo.Suffix)"
    return @{
        Value  = $derived
        Source = "derived from $dbName + $($suffixInfo.Source)"
    }
}

function Resolve-ProductionEmdashTursoToken {
    param(
        [string]$EnvDevPath,
        [string]$TerraformExe,
        [string]$TerraformEnvDir,
        [string]$ResolvedUrl
    )

    $terraformToken = Try-TerraformOutputRaw -TerraformExe $TerraformExe -TerraformEnvDir $TerraformEnvDir -OutputName "turso_database_auth_token"
    if (-not [string]::IsNullOrWhiteSpace($terraformToken)) {
        return @{ Value = $terraformToken; Source = "terraform output turso_database_auth_token" }
    }

    $directToken = Get-FirstNonEmptyTursoValue @(
        ([Environment]::GetEnvironmentVariable("TURSO_PRODUCTION_EMDASH_DB_TOKEN", "Process")),
        (Get-EnvFileValueForTurso -Path $EnvDevPath -Key "TURSO_PRODUCTION_EMDASH_DB_TOKEN")
    )
    if (-not [string]::IsNullOrWhiteSpace($directToken)) {
        return @{ Value = $directToken; Source = "TURSO_PRODUCTION_EMDASH_DB_TOKEN" }
    }

    if (Test-IsProductionEmdashLibsqlUrl -Url $ResolvedUrl) {
        $pairedToken = Get-FirstNonEmptyTursoValue @(
            ([Environment]::GetEnvironmentVariable("TURSO_AUTH_TOKEN", "Process")),
            (Get-EnvFileValueForTurso -Path $EnvDevPath -Key "TURSO_AUTH_TOKEN")
        )
        if (-not [string]::IsNullOrWhiteSpace($pairedToken)) {
            return @{ Value = $pairedToken; Source = "TURSO_AUTH_TOKEN (paired with production emdash URL)" }
        }
    }

    throw @"
Missing production EmDash Turso auth token. Set one of these in .env.dev:
  TURSO_PRODUCTION_EMDASH_DB_TOKEN, TURSO_AUTH_TOKEN (when TURSO_DATABASE_URL is production emdash),
  or refresh via: pwsh ./scripts/sync-production-turso-env-dev.ps1
"@
}

function Resolve-StagingEmdashTursoUrl {
    param(
        [string]$EnvDevPath,
        [string]$TerraformExe,
        [string]$TerraformEnvDir
    )

    $terraformUrl = Try-TerraformOutputRaw -TerraformExe $TerraformExe -TerraformEnvDir $TerraformEnvDir -OutputName "turso_database_url"
    if (-not [string]::IsNullOrWhiteSpace($terraformUrl)) {
        return @{ Value = $terraformUrl; Source = "terraform output turso_database_url" }
    }

    $envUrl = Get-FirstNonEmptyTursoValue @(
        ([Environment]::GetEnvironmentVariable("TURSO_DATABASE_URL", "Process")),
        (Get-EnvFileValueForTurso -Path $EnvDevPath -Key "TURSO_DATABASE_URL")
    )
    if (-not [string]::IsNullOrWhiteSpace($envUrl)) {
        return @{ Value = $envUrl; Source = "TURSO_DATABASE_URL" }
    }

    throw "Missing staging EmDash Turso URL. Set TURSO_DATABASE_URL in .env.dev or run terraform apply."
}

function Resolve-StagingEmdashTursoToken {
    param(
        [string]$EnvDevPath,
        [string]$TerraformExe,
        [string]$TerraformEnvDir
    )

    $terraformToken = Try-TerraformOutputRaw -TerraformExe $TerraformExe -TerraformEnvDir $TerraformEnvDir -OutputName "turso_database_auth_token"
    if (-not [string]::IsNullOrWhiteSpace($terraformToken)) {
        return @{ Value = $terraformToken; Source = "terraform output turso_database_auth_token" }
    }

    $envToken = Get-FirstNonEmptyTursoValue @(
        ([Environment]::GetEnvironmentVariable("TURSO_AUTH_TOKEN", "Process")),
        (Get-EnvFileValueForTurso -Path $EnvDevPath -Key "TURSO_AUTH_TOKEN")
    )
    if (-not [string]::IsNullOrWhiteSpace($envToken)) {
        return @{ Value = $envToken; Source = "TURSO_AUTH_TOKEN" }
    }

    throw "Missing staging EmDash Turso token. Set TURSO_AUTH_TOKEN in .env.dev or run terraform apply."
}

function Set-TursoBuildEnv {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet("staging", "production")]
        [string]$Environment,

        [string]$RepoRoot = (Split-Path $PSScriptRoot -Parent)
    )

    . "$PSScriptRoot/ensure-windows-cli-path.ps1"
    Initialize-WindowsCliPath

    $envDevPath = Join-Path $RepoRoot ".env.dev"
    $terraformEnvDir = Join-Path $RepoRoot "infra/terraform/environments/$Environment"
    $terraformExe = Resolve-TerraformExecutable

    Import-EnvFileForTurso -Path $envDevPath

    if ($Environment -eq "production") {
        $urlBinding = Resolve-ProductionEmdashTursoUrl -EnvDevPath $envDevPath -TerraformExe $terraformExe -TerraformEnvDir $terraformEnvDir
        $tokenBinding = Resolve-ProductionEmdashTursoToken -EnvDevPath $envDevPath -TerraformExe $terraformExe -TerraformEnvDir $terraformEnvDir -ResolvedUrl $urlBinding.Value
    }
    else {
        $urlBinding = Resolve-StagingEmdashTursoUrl -EnvDevPath $envDevPath -TerraformExe $terraformExe -TerraformEnvDir $terraformEnvDir
        $tokenBinding = Resolve-StagingEmdashTursoToken -EnvDevPath $envDevPath -TerraformExe $terraformExe -TerraformEnvDir $terraformEnvDir
    }

    $env:TURSO_DATABASE_URL = $urlBinding.Value
    $env:TURSO_AUTH_TOKEN   = $tokenBinding.Value

    return [pscustomobject]@{
        Environment = $Environment
        Url         = $urlBinding
        Token       = $tokenBinding
    }
}
