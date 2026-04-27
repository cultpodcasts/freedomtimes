param(
    [switch]$UseCurrentLoginTokens
)

function Set-UserEnvVar {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [Parameter(Mandatory = $true)]
        [string]$Value
    )

    [Environment]::SetEnvironmentVariable($Name, $Value, "User")
    Set-Item -Path "Env:$Name" -Value $Value
}

if ($UseCurrentLoginTokens) {
    $authPath = Join-Path $HOME ".config\emdash\auth.json"

    if (-not (Test-Path $authPath)) {
        throw "Could not find $authPath. Run emdash login first or set tokens manually."
    }

    $auth = Get-Content $authPath -Raw | ConvertFrom-Json
    $stagingToken = $auth."https://staging.freedomtimes.news".accessToken
    $productionToken = $auth."https://freedomtimes.news".accessToken

    if (-not $stagingToken -or -not $productionToken) {
        throw "Missing staging or production access token in auth.json."
    }

    Set-UserEnvVar -Name "EMDASH_STAGING_PAT" -Value $stagingToken
    Set-UserEnvVar -Name "EMDASH_PRODUCTION_PAT" -Value $productionToken

    Write-Host "Set EMDASH_STAGING_PAT and EMDASH_PRODUCTION_PAT from current emdash login tokens."
    Write-Host "Note: login tokens expire. For long-lived access, set PAT values manually."
    exit 0
}

$staging = Read-Host -Prompt "Enter staging token (ec_pat_... or ec_oat_...)"
$production = Read-Host -Prompt "Enter production token (ec_pat_... or ec_oat_...)"

if ([string]::IsNullOrWhiteSpace($staging) -or [string]::IsNullOrWhiteSpace($production)) {
    throw "Both staging and production tokens are required."
}

Set-UserEnvVar -Name "EMDASH_STAGING_PAT" -Value $staging
Set-UserEnvVar -Name "EMDASH_PRODUCTION_PAT" -Value $production

Write-Host "Saved EMDASH_STAGING_PAT and EMDASH_PRODUCTION_PAT for this user profile."
Write-Host "Restart VS Code (or run Developer: Reload Window) so MCP servers pick up new values."