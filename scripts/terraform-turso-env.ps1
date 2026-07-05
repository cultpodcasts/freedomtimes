Set-StrictMode -Version Latest

function Test-LooksLikeTursoDatabaseJwt {
    param([string]$Value)

    if ([string]::IsNullOrWhiteSpace($Value)) {
        return $false
    }

    $v = $Value.Trim()
    return $v.StartsWith("eyJ") -and ($v.Split(".").Count -ge 3)
}

function Test-IsWrongTursoPlatformTokenVarName {
    param([string]$Name)

    # Database JWT env keys must never be used as Platform API token sources.
    return $Name -match '_AUTH_TOKEN$' -or $Name -match '_DB_TOKEN$'
}

function Test-TursoPlatformApiToken {
    param([string]$Token)

    if ([string]::IsNullOrWhiteSpace($Token)) {
        return $false
    }

    $headers = @{
        Authorization = "Bearer $($Token.Trim())"
    }

    try {
        $response = Invoke-WebRequest -Method Get -Uri "https://api.turso.tech/v1/organizations" -Headers $headers -UseBasicParsing
        return $response.StatusCode -eq 200
    }
    catch {
        $statusCode = $null
        if ($null -ne $_.Exception.Response) {
            $statusCode = [int]$_.Exception.Response.StatusCode
        }

        if ($statusCode -eq 401) {
            return $false
        }

        throw "Turso Platform API probe failed: $($_.Exception.Message)"
    }
}

function Get-TursoPlatformApiTokenCandidateNames {
    param([string]$Environment)

    if ($Environment -eq "staging") {
        return @(
            "TURSO_TOKEN_STAGING",
            "TURSO_PLATFORM_API_TOKEN",
            "TF_VAR_turso_api_token",
            "TURSO_TOKEN"
        )
    }

    if ($Environment -eq "production") {
        return @(
            "TURSO_PLATFORM_API_TOKEN",
            "TF_VAR_turso_api_token",
            "TURSO_TOKEN"
        )
    }

    return @()
}

function Get-FirstProcessEnvValue {
    param([string[]]$Names)

    foreach ($name in $Names) {
        $value = [System.Environment]::GetEnvironmentVariable($name, "Process")
        if (-not [string]::IsNullOrWhiteSpace([string]$value)) {
            return [string]$value.Trim()
        }
    }

    return ""
}

function Set-TursoPlatformApiTokenForEnvironment {
    param([string]$Environment)

    # Wrap in @() so an empty return from the helper is an empty array, not $null
    # (StrictMode rejects .Count on $null — auth0-shared has no Turso candidates).
    $candidates = @(Get-TursoPlatformApiTokenCandidateNames -Environment $Environment)
    if ($candidates.Count -eq 0) {
        return
    }

    foreach ($name in $candidates) {
        if (Test-IsWrongTursoPlatformTokenVarName $name) {
            Write-Warning "${name} is a database JWT env key, not a Turso Platform API token source; skipping for Terraform."
            continue
        }

        $value = Get-FirstProcessEnvValue -Names @($name)
        if ([string]::IsNullOrWhiteSpace($value)) {
            continue
        }

        if (Test-TursoPlatformApiToken $value) {
            [System.Environment]::SetEnvironmentVariable("TF_VAR_turso_api_token", $value, "Process")
            if ($name -ne "TF_VAR_turso_api_token") {
                Write-Host "Turso Platform API token for ${Environment} resolved from $name" -ForegroundColor DarkGray
            }
            return
        }

        if (Test-LooksLikeTursoDatabaseJwt $value) {
            Write-Warning "${name} looks like a libsql database JWT and failed Turso Platform API probe; skipping for Terraform."
        }
        else {
            Write-Warning "${name} is not a valid Turso Platform API token (Turso API returned 401); skipping for Terraform."
        }
    }
}
