Set-StrictMode -Version Latest

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
            "TURSO_TOKEN",
            "TURSO_PLATFORM_API_TOKEN",
            "TF_VAR_turso_api_token"
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

    $candidates = Get-TursoPlatformApiTokenCandidateNames -Environment $Environment
    if ($candidates.Count -eq 0) {
        return
    }

    foreach ($name in $candidates) {
        $value = Get-FirstProcessEnvValue -Names @($name)
        if ([string]::IsNullOrWhiteSpace($value)) {
            continue
        }

        [System.Environment]::SetEnvironmentVariable("TF_VAR_turso_api_token", $value, "Process")
        if ($name -ne "TF_VAR_turso_api_token") {
            Write-Host "Turso Platform API token for ${Environment} resolved from $name" -ForegroundColor DarkGray
        }
        return
    }
}
