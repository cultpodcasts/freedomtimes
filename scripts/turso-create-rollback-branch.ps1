[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ProductionDatabaseName,
    [string]$BranchName,
    [string]$MetadataDirectory = ".release/rollback-branches",
    [string]$TursoGroup,
    [string]$Notes,
    [switch]$AllowProduction,
    [switch]$DryRun,
    [switch]$UseNativeTurso
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $AllowProduction) {
    throw "Refusing to create production rollback checkpoint without -AllowProduction."
}

function Test-CommandAvailable {
    param([string]$CommandName)
    return $null -ne (Get-Command $CommandName -ErrorAction SilentlyContinue)
}

function Invoke-External {
    param(
        [string]$FilePath,
        [string[]]$Arguments,
        [switch]$CaptureOutput,
        [switch]$AllowFailure
    )

    if ($CaptureOutput) {
        $lines = & $FilePath @Arguments 2>&1
        $exitCode = $LASTEXITCODE
        if (-not $AllowFailure -and $exitCode -ne 0) {
            throw "$FilePath $($Arguments -join ' ') failed with exit code $exitCode"
        }
        return [pscustomobject]@{ ExitCode = $exitCode; Output = @($lines) }
    }

    & $FilePath @Arguments
    $exitCode = $LASTEXITCODE
    if (-not $AllowFailure -and $exitCode -ne 0) {
        throw "$FilePath $($Arguments -join ' ') failed with exit code $exitCode"
    }
    return [pscustomobject]@{ ExitCode = $exitCode; Output = @() }
}

if (-not (Test-CommandAvailable -CommandName "git")) {
    throw "git is required to capture release metadata."
}

$UseWslTurso = -not $UseNativeTurso

if ($UseWslTurso) {
    if (-not (Test-CommandAvailable -CommandName "wsl")) {
        throw "wsl is required for Turso (install Ubuntu WSL, then Turso: curl -sSfL https://get.tur.so/install.sh | bash). See docs/CLI_PATHS_WINDOWS.md"
    }
}
elseif (-not (Test-CommandAvailable -CommandName "turso")) {
    throw "Turso CLI not on Windows PATH. Use default WSL mode (-UseWslTurso) or install Turso in WSL. See docs/CLI_PATHS_WINDOWS.md and web/CONTENT_PROMOTION_RUNBOOK.md"
}

$repoRoot = Split-Path $PSScriptRoot -Parent
Push-Location $repoRoot
try {
    $timestampUtc = (Get-Date).ToUniversalTime().ToString("yyyyMMdd-HHmmss")
    if ([string]::IsNullOrWhiteSpace($BranchName)) {
        $BranchName = "prod-rollback-$timestampUtc"
    }

    $headHash = (Invoke-External -FilePath "git" -Arguments @("rev-parse", "HEAD") -CaptureOutput).Output[0].Trim()
    $headShortHash = (Invoke-External -FilePath "git" -Arguments @("rev-parse", "--short", "HEAD") -CaptureOutput).Output[0].Trim()
    $currentBranch = (Invoke-External -FilePath "git" -Arguments @("rev-parse", "--abbrev-ref", "HEAD") -CaptureOutput).Output[0].Trim()
    $originMain = Invoke-External -FilePath "git" -Arguments @("rev-parse", "origin/main") -CaptureOutput -AllowFailure
    $originMainHash = if ($originMain.ExitCode -eq 0 -and $originMain.Output.Count -gt 0) { $originMain.Output[0].Trim() } else { "" }
    $remoteUrlResult = Invoke-External -FilePath "git" -Arguments @("remote", "get-url", "origin") -CaptureOutput -AllowFailure
    $originRemoteUrl = if ($remoteUrlResult.ExitCode -eq 0 -and $remoteUrlResult.Output.Count -gt 0) { $remoteUrlResult.Output[0].Trim() } else { "" }
    $dirtyResult = Invoke-External -FilePath "git" -Arguments @("status", "--porcelain") -CaptureOutput
    $isDirty = $dirtyResult.Output.Count -gt 0

    if ($DryRun) {
        $dryExtra = if ([string]::IsNullOrWhiteSpace($TursoGroup)) { "" } else { " --group $TursoGroup" }
        Write-Host "[dry-run] turso db create $BranchName --from-db $ProductionDatabaseName$dryExtra" -ForegroundColor Yellow
    }
    else {
        Write-Host "Creating Turso rollback branch '$BranchName' from '$ProductionDatabaseName'" -ForegroundColor Cyan
        if ($UseWslTurso) {
            function Escape-BashSingleQuoted {
                param([string]$Value)
                return "'" + ($Value -replace "'", "'\''") + "'"
            }
            $bashLine = '$HOME/.turso/turso db create ' + (Escape-BashSingleQuoted $BranchName) + ' --from-db ' + (Escape-BashSingleQuoted $ProductionDatabaseName)
            if (-not [string]::IsNullOrWhiteSpace($TursoGroup)) {
                $bashLine += ' --group ' + (Escape-BashSingleQuoted $TursoGroup)
            }
            $null = Invoke-External -FilePath "wsl" -Arguments @("bash", "-lc", $bashLine)
        }
        else {
            $tursoArgs = @("db", "create", $BranchName, "--from-db", $ProductionDatabaseName)
            if (-not [string]::IsNullOrWhiteSpace($TursoGroup)) {
                $tursoArgs += @("--group", $TursoGroup)
            }
            $null = Invoke-External -FilePath "turso" -Arguments $tursoArgs
        }
        Write-Host "Turso rollback branch created." -ForegroundColor Green
    }

    $metadataPath = Join-Path $repoRoot $MetadataDirectory
    if (-not (Test-Path $metadataPath)) {
        New-Item -ItemType Directory -Path $metadataPath -Force | Out-Null
    }

    $metadataFileName = "$timestampUtc-$BranchName.json"
    $metadataFilePath = Join-Path $metadataPath $metadataFileName

    $metadata = [ordered]@{
        createdAtUtc = [DateTime]::UtcNow.ToString("o")
        sourceDatabase = $ProductionDatabaseName
        rollbackDatabase = $BranchName
        notes = $Notes
        git = [ordered]@{
            head = $headHash
            headShort = $headShortHash
            currentBranch = $currentBranch
            originMain = $originMainHash
            originRemote = $originRemoteUrl
            dirtyWorkingTree = $isDirty
        }
    }

    $metadata | ConvertTo-Json -Depth 8 | Set-Content -Path $metadataFilePath -Encoding UTF8

    Write-Host "Rollback metadata saved: $metadataFilePath" -ForegroundColor Green
    Write-Host "Next: generate branch token and database URL for emergency failback secret switching." -ForegroundColor Cyan
}
finally {
    Pop-Location
}