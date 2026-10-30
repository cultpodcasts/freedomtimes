Set-StrictMode -Version Latest

<#
.SYNOPSIS
  Resolve EmDash Turso build credentials for Astro (TURSO_DATABASE_URL + TURSO_AUTH_TOKEN).

.DESCRIPTION
  Prefers Terraform outputs when present; falls back to repo-root .env.dev (and optional
  production-prefixed aliases). Does not require terraform apply when .env.dev is populated.

  Staging uses TURSO_DATABASE_URL / TURSO_AUTH_TOKEN. When TURSO_PRODUCTION_EMDASH_DB_URL
  is set, that is the production EmDash URL — do not treat TURSO_DATABASE_URL as production.

  Dot-source this file and call Set-TursoBuildEnv.
#>

function Import-EnvFileForTurso {
    param([string]$Path)

    if (-not (Test-Path $Path)) {
        return
    }

    foreach ($rawLine in Get-Content -Path $Path) {
        $line = $rawLine.Trim()
        if ([string]::IsNullOrWhiteSpace($line) -or $line.StartsWith("#")) { continue }
        if ($line -match '^[A-Za-z_][A-Za-z0-9_]*=') {
            $parts = $line -split '=', 2
            $key = $parts[0].Trim().Trim([char]0xFEFF)
            $value = $parts[1].Trim().Trim([char]0xFEFF)
            if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
                $value = $value.Substring(1, $value.Length - 2)
            }
            $existing = [Environment]::GetEnvironmentVariable($key, "Process")
            if (-not [string]::IsNullOrWhiteSpace($existing)) {
                continue
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
    return (-not [string]::IsNullOrWhiteSpace($Url)) -and ($Url -match '-emdash-production')
}

function Test-ProcessTursoUrlIsProductionShadow {
    param(
        [string]$ProcessUrl,
        [string]$ProductionHint
    )

    if ([string]::IsNullOrWhiteSpace($ProcessUrl)) {
        return $false
    }

    if (-not [string]::IsNullOrWhiteSpace($ProductionHint) -and (Test-TursoLibsqlUrlsEqual -Left $ProcessUrl -Right $ProductionHint)) {
        return $true
    }

    return Test-IsProductionEmdashLibsqlUrl -Url $ProcessUrl
}

function Assert-StagingEmdashTursoUrlNotProduction {
    param(
        [string]$Url,
        [string]$ProductionHint
    )

    if ([string]::IsNullOrWhiteSpace($Url)) {
        return
    }

    if (-not [string]::IsNullOrWhiteSpace($ProductionHint) -and (Test-TursoLibsqlUrlsEqual -Left $Url -Right $ProductionHint)) {
        throw "TURSO_DATABASE_URL matches TURSO_PRODUCTION_EMDASH_DB_URL. Staging deploy would hit production EmDash. Keep TURSO_DATABASE_URL as staging in .env.dev (production on TURSO_PRODUCTION_EMDASH_DB_URL). Do not copy the process production pair into .env.dev."
    }

    if (Test-IsProductionEmdashLibsqlUrl -Url $Url) {
        throw "TURSO_DATABASE_URL looks like production EmDash. Staging deploy would hit production EmDash. Keep TURSO_DATABASE_URL as staging in .env.dev. Do not copy the process production pair into .env.dev."
    }
}

function Test-TursoLibsqlUrlsEqual {
    param(
        [string]$Left,
        [string]$Right
    )

    if ([string]::IsNullOrWhiteSpace($Left) -or [string]::IsNullOrWhiteSpace($Right)) {
        return $false
    }

    $normalize = {
        param([string]$Url)
        $hostPart = $Url.Trim() -replace "^libsql://", "" -replace "^https://", ""
        $hostPart = ($hostPart -split "\?")[0]
        $at = $hostPart.LastIndexOf("@")
        if ($at -ge 0) {
            $hostPart = $hostPart.Substring($at + 1)
        }
        return $hostPart.TrimEnd("/").ToLowerInvariant()
    }

    return (& $normalize $Left) -eq (& $normalize $Right)
}

function Get-ProductionEmdashUrlHint {
    param([string]$EnvDevPath)

    return Get-FirstNonEmptyTursoValue @(
        ([Environment]::GetEnvironmentVariable("TURSO_PRODUCTION_EMDASH_DB_URL", "Process")),
        (Get-EnvFileValueForTurso -Path $EnvDevPath -Key "TURSO_PRODUCTION_EMDASH_DB_URL")
    )
}

# Cursor Cloud often injects process TURSO_DATABASE_URL / TURSO_AUTH_TOKEN that
# point at production EmDash while .env.dev still has staging. Prefer the file
# (or Terraform output). Never write the production pair into .env.dev.
function Select-StagingEmdashTursoUrl {
    param(
        [string]$TerraformUrl,
        [string]$ProcessUrl,
        [string]$FileUrl,
        [string]$ProductionHint
    )

    $processIsProductionShadow = Test-ProcessTursoUrlIsProductionShadow -ProcessUrl $ProcessUrl -ProductionHint $ProductionHint
    if ($processIsProductionShadow) {
        Write-Warning "Process TURSO_DATABASE_URL is production EmDash. Using staging Terraform / .env.dev instead. Not writing that pair into .env.dev."
    }

    if (-not [string]::IsNullOrWhiteSpace($TerraformUrl)) {
        Assert-StagingEmdashTursoUrlNotProduction -Url $TerraformUrl -ProductionHint $ProductionHint
        return @{
            Value = $TerraformUrl
            Source = "terraform output turso_database_url"
            IgnoredProcessProductionShadow = $processIsProductionShadow
        }
    }

    $candidate = ""
    $source = ""
    if (-not $processIsProductionShadow -and -not [string]::IsNullOrWhiteSpace($ProcessUrl)) {
        $candidate = $ProcessUrl
        $source = "TURSO_DATABASE_URL (process)"
    }
    elseif (-not [string]::IsNullOrWhiteSpace($FileUrl)) {
        $candidate = $FileUrl
        $source = "TURSO_DATABASE_URL (.env.dev)"
    }

    if ([string]::IsNullOrWhiteSpace($candidate)) {
        throw "Missing staging EmDash Turso URL. Set TURSO_DATABASE_URL in .env.dev or run terraform apply."
    }

    Assert-StagingEmdashTursoUrlNotProduction -Url $candidate -ProductionHint $ProductionHint

    return @{
        Value = $candidate
        Source = $source
        IgnoredProcessProductionShadow = $processIsProductionShadow
    }
}

function Select-StagingEmdashTursoToken {
    param(
        [string]$TerraformToken,
        [string]$ProcessToken,
        [string]$FileToken,
        [bool]$IgnoredProcessProductionShadow
    )

    if (-not [string]::IsNullOrWhiteSpace($TerraformToken)) {
        return @{ Value = $TerraformToken; Source = "terraform output turso_database_auth_token" }
    }

    if (-not $IgnoredProcessProductionShadow -and -not [string]::IsNullOrWhiteSpace($ProcessToken)) {
        return @{ Value = $ProcessToken; Source = "TURSO_AUTH_TOKEN (process)" }
    }

    if (-not [string]::IsNullOrWhiteSpace($FileToken)) {
        return @{ Value = $FileToken; Source = "TURSO_AUTH_TOKEN (.env.dev)" }
    }

    throw "Missing staging EmDash Turso token. Set TURSO_AUTH_TOKEN in .env.dev or run terraform apply."
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

    if ([string]::IsNullOrWhiteSpace($TerraformExe) -or -not (Test-Path -LiteralPath $TerraformEnvDir)) {
        return $null
    }

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
    <#
    .SYNOPSIS
      Resolve the production EmDash JWT without ever borrowing the staging token.

    .PARAMETER ProcessTursoUrl
      Process TURSO_DATABASE_URL as it was BEFORE .env.dev was imported (Set-TursoBuildEnv passes the
      snapshot). Defaults to the current process value for direct callers.

    .PARAMETER ProcessTursoToken
      Process TURSO_AUTH_TOKEN from the same snapshot. Defaults to the current process value.
    #>
    param(
        [string]$EnvDevPath,
        [string]$ResolvedUrl,
        [string]$ProcessTursoUrl = ([Environment]::GetEnvironmentVariable("TURSO_DATABASE_URL", "Process")),
        [string]$ProcessTursoToken = ([Environment]::GetEnvironmentVariable("TURSO_AUTH_TOKEN", "Process"))
    )

    # TURSO_PRODUCTION_EMDASH_DB_TOKEN is the single source for the production EmDash JWT
    # (AGENTS.md CA-21, issue #137). The Terraform-minted turso_database_auth_token output was
    # rejected by Turso ("auth role not found") and has been retired, so it is never read here.
    $directToken = Get-FirstNonEmptyTursoValue @(
        ([Environment]::GetEnvironmentVariable("TURSO_PRODUCTION_EMDASH_DB_TOKEN", "Process")),
        (Get-EnvFileValueForTurso -Path $EnvDevPath -Key "TURSO_PRODUCTION_EMDASH_DB_TOKEN")
    )
    if (-not [string]::IsNullOrWhiteSpace($directToken)) {
        return @{ Value = $directToken; Source = "TURSO_PRODUCTION_EMDASH_DB_TOKEN" }
    }

    # Cloud Agent case (CA-14): a process TURSO_AUTH_TOKEN is the production JWT only when the
    # process TURSO_DATABASE_URL that travels with it is the production EmDash URL being deployed.
    # The .env.dev TURSO_DATABASE_URL / TURSO_AUTH_TOKEN pair always stays staging, so it is never
    # a candidate: a process token copied from that file (file URL not production) is rejected too.
    $pairedUrlMatches = (Test-IsProductionEmdashLibsqlUrl -Url $ProcessTursoUrl) -and
        (Test-TursoLibsqlUrlsEqual -Left $ProcessTursoUrl -Right $ResolvedUrl)
    if ($pairedUrlMatches -and -not [string]::IsNullOrWhiteSpace($ProcessTursoToken)) {
        $fileToken = Get-EnvFileValueForTurso -Path $EnvDevPath -Key "TURSO_AUTH_TOKEN"
        $fileUrl = Get-EnvFileValueForTurso -Path $EnvDevPath -Key "TURSO_DATABASE_URL"
        $tokenIsStagingFileToken = (-not [string]::IsNullOrWhiteSpace($fileToken)) -and
            ($fileToken.Trim() -eq $ProcessTursoToken.Trim()) -and
            -not (Test-TursoLibsqlUrlsEqual -Left $fileUrl -Right $ResolvedUrl)
        if (-not $tokenIsStagingFileToken) {
            return @{ Value = $ProcessTursoToken.Trim(); Source = "TURSO_AUTH_TOKEN (process, paired with production emdash TURSO_DATABASE_URL)" }
        }
    }

    throw @"
Missing production EmDash Turso auth token. Set TURSO_PRODUCTION_EMDASH_DB_TOKEN in .env.dev or the
process (the .env.dev TURSO_AUTH_TOKEN is staging and is never used for production, AGENTS.md CA-14).
Terraform no longer mints this token (AGENTS.md CA-21, #137). Mint it with
pwsh ./scripts/sync-production-turso-env-dev.ps1 or: turso db tokens create freedomtimes-emdash-production
"@
}

function Resolve-StagingEmdashTursoUrl {
    param(
        [string]$EnvDevPath,
        [string]$TerraformExe,
        [string]$TerraformEnvDir
    )

    $terraformUrl = Try-TerraformOutputRaw -TerraformExe $TerraformExe -TerraformEnvDir $TerraformEnvDir -OutputName "turso_database_url"
    $processUrl = [Environment]::GetEnvironmentVariable("TURSO_DATABASE_URL", "Process")
    $fileUrl = Get-EnvFileValueForTurso -Path $EnvDevPath -Key "TURSO_DATABASE_URL"
    $productionHint = Get-ProductionEmdashUrlHint -EnvDevPath $EnvDevPath

    return Select-StagingEmdashTursoUrl `
        -TerraformUrl $terraformUrl `
        -ProcessUrl $processUrl `
        -FileUrl $fileUrl `
        -ProductionHint $productionHint
}

function Resolve-StagingEmdashTursoToken {
    param(
        [string]$EnvDevPath,
        [string]$TerraformExe,
        [string]$TerraformEnvDir,
        [bool]$IgnoredProcessProductionShadow = $false
    )

    $terraformToken = Try-TerraformOutputRaw -TerraformExe $TerraformExe -TerraformEnvDir $TerraformEnvDir -OutputName "turso_database_auth_token"
    $processToken = [Environment]::GetEnvironmentVariable("TURSO_AUTH_TOKEN", "Process")
    $fileToken = Get-EnvFileValueForTurso -Path $EnvDevPath -Key "TURSO_AUTH_TOKEN"

    return Select-StagingEmdashTursoToken `
        -TerraformToken $terraformToken `
        -ProcessToken $processToken `
        -FileToken $fileToken `
        -IgnoredProcessProductionShadow $IgnoredProcessProductionShadow
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
    $terraformExe = ""
    try {
        $terraformExe = Resolve-TerraformExecutable
    }
    catch {
        # -WorkerOnly must resolve TURSO_* from env / .env.dev without Terraform.
        $terraformExe = ""
    }

    # Snapshot the process pair before .env.dev fills gaps, so a staging file token can never be
    # mistaken for the CA-14 paired production token (Resolve-ProductionEmdashTursoToken).
    $processTursoUrl = [Environment]::GetEnvironmentVariable("TURSO_DATABASE_URL", "Process")
    $processTursoToken = [Environment]::GetEnvironmentVariable("TURSO_AUTH_TOKEN", "Process")

    Import-EnvFileForTurso -Path $envDevPath

    if ($Environment -eq "production") {
        $urlBinding = Resolve-ProductionEmdashTursoUrl -EnvDevPath $envDevPath -TerraformExe $terraformExe -TerraformEnvDir $terraformEnvDir
        $tokenBinding = Resolve-ProductionEmdashTursoToken -EnvDevPath $envDevPath -ResolvedUrl $urlBinding.Value `
            -ProcessTursoUrl $processTursoUrl -ProcessTursoToken $processTursoToken
    }
    else {
        $urlBinding = Resolve-StagingEmdashTursoUrl -EnvDevPath $envDevPath -TerraformExe $terraformExe -TerraformEnvDir $terraformEnvDir
        $ignoredShadow = [bool]$urlBinding.IgnoredProcessProductionShadow
        $tokenBinding = Resolve-StagingEmdashTursoToken -EnvDevPath $envDevPath -TerraformExe $terraformExe -TerraformEnvDir $terraformEnvDir -IgnoredProcessProductionShadow $ignoredShadow
    }

    $env:TURSO_DATABASE_URL = $urlBinding.Value
    $env:TURSO_AUTH_TOKEN   = $tokenBinding.Value

    return [pscustomobject]@{
        Environment = $Environment
        Url         = $urlBinding
        Token       = $tokenBinding
    }
}
