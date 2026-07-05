Set-StrictMode -Version Latest

$script:TerraformEnvironmentLockHeld = $false
$script:TerraformEnvironmentLockPath = $null

function Get-TerraformEnvironmentLockDirectory {
    param([string]$RepoRoot)

    return Join-Path $RepoRoot ".terraform-locks"
}

function Get-TerraformEnvironmentLockPath {
    param(
        [string]$Environment,
        [string]$RepoRoot
    )

    $lockDir = Get-TerraformEnvironmentLockDirectory -RepoRoot $RepoRoot
    return Join-Path $lockDir "$Environment.lock"
}

function Test-TerraformLockProcessAlive {
    param([int]$ProcessId)

    if ($ProcessId -le 0) {
        return $false
    }

    try {
        $proc = Get-Process -Id $ProcessId -ErrorAction Stop
        return $null -ne $proc -and -not $proc.HasExited
    }
    catch {
        return $false
    }
}

function Read-TerraformEnvironmentLock {
    param([string]$Path)

    if (-not (Test-Path $Path)) {
        return $null
    }

    try {
        $raw = Get-Content -Path $Path -Raw -ErrorAction Stop
        if ([string]::IsNullOrWhiteSpace($raw)) {
            return $null
        }

        return $raw | ConvertFrom-Json
    }
    catch {
        return $null
    }
}

function New-TerraformEnvironmentLockError {
    param(
        [string]$Environment,
        [string]$LockPath,
        [object]$Existing
    )

    $existingPid = [int]$Existing.pid
    $existingHost = [string]$Existing.hostname
    $existingOp = [string]$Existing.operation
    $existingStarted = [string]$Existing.startedAt
    $existingCaller = [string]$Existing.caller

    return @"
Terraform environment lock held for '$Environment'.
Another operation is already running (PID $existingPid on $existingHost): $existingOp started at $existingStarted.
Caller: $existingCaller
Wait for it to finish or, if you are sure the process is gone, delete: $LockPath
"@
}

function Enter-TerraformEnvironmentLock {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet("staging", "production", "auth0-shared")]
        [string]$Environment,
        [Parameter(Mandatory = $true)]
        [string]$Operation,
        [string]$RepoRoot,
        [string]$CallerInfo
    )

    if ($script:TerraformEnvironmentLockHeld) {
        throw "Enter-TerraformEnvironmentLock called while a Terraform environment lock is already held."
    }

    if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
        $RepoRoot = Split-Path $PSScriptRoot -Parent
    }

    $lockDir = Get-TerraformEnvironmentLockDirectory -RepoRoot $RepoRoot
    if (-not (Test-Path $lockDir)) {
        New-Item -ItemType Directory -Path $lockDir -Force | Out-Null
    }

    $lockPath = Get-TerraformEnvironmentLockPath -Environment $Environment -RepoRoot $RepoRoot

    if (Test-Path $lockPath) {
        $existing = Read-TerraformEnvironmentLock -Path $lockPath
        if ($null -ne $existing) {
            $existingPid = [int]$existing.pid
            if (Test-TerraformLockProcessAlive -ProcessId $existingPid) {
                throw (New-TerraformEnvironmentLockError -Environment $Environment -LockPath $lockPath -Existing $existing)
            }

            Write-Warning "Removing stale Terraform lock for '$Environment' (PID $existingPid on $($existing.hostname) is no longer running)."
        }
        else {
            Write-Warning "Removing unreadable Terraform lock for '$Environment' at $lockPath."
        }

        Remove-Item -Path $lockPath -Force -ErrorAction SilentlyContinue
    }

    $caller = if ([string]::IsNullOrWhiteSpace($CallerInfo)) {
        $MyInvocation.PSCommandPath
    }
    else {
        $CallerInfo
    }

    $lockRecord = [ordered]@{
        pid         = $PID
        hostname    = [System.Environment]::MachineName
        operation   = $Operation
        environment = $Environment
        startedAt   = (Get-Date).ToUniversalTime().ToString("o")
        caller      = $caller
    }

    $json = ($lockRecord | ConvertTo-Json -Compress) + [Environment]::NewLine

    try {
        $stream = [System.IO.File]::Open(
            $lockPath,
            [System.IO.FileMode]::CreateNew,
            [System.IO.FileAccess]::Write,
            [System.IO.FileShare]::None
        )
        try {
            $writer = New-Object System.IO.StreamWriter($stream, [System.Text.UTF8Encoding]::new($false))
            $writer.Write($json)
            $writer.Flush()
        }
        finally {
            $stream.Dispose()
        }
    }
    catch [System.IO.IOException] {
        if (Test-Path $lockPath) {
            $existing = Read-TerraformEnvironmentLock -Path $lockPath
            if ($null -ne $existing -and (Test-TerraformLockProcessAlive -ProcessId ([int]$existing.pid))) {
                throw (New-TerraformEnvironmentLockError -Environment $Environment -LockPath $lockPath -Existing $existing)
            }
        }

        throw "Failed to acquire Terraform environment lock for '$Environment' at $lockPath."
    }

    $script:TerraformEnvironmentLockHeld = $true
    $script:TerraformEnvironmentLockPath = $lockPath
}

function Exit-TerraformEnvironmentLock {
    if (-not $script:TerraformEnvironmentLockHeld -or [string]::IsNullOrWhiteSpace($script:TerraformEnvironmentLockPath)) {
        return
    }

    $lockPath = $script:TerraformEnvironmentLockPath

    try {
        if (Test-Path $lockPath) {
            $existing = Read-TerraformEnvironmentLock -Path $lockPath
            if ($null -eq $existing -or [int]$existing.pid -eq $PID) {
                Remove-Item -Path $lockPath -Force -ErrorAction SilentlyContinue
            }
        }
    }
    finally {
        $script:TerraformEnvironmentLockHeld = $false
        $script:TerraformEnvironmentLockPath = $null
    }
}
