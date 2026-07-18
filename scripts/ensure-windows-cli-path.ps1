Set-StrictMode -Version Latest

# Directories commonly missing from PATH in non-interactive shells (Cursor agents, CI-like pwsh).
# Only Windows-native CLIs belong here — Turso runs in WSL (see docs/CLI_PATHS_WINDOWS.md).
$script:WindowsCliPathCandidates = @(
    (Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Links")
    (Join-Path $env:ProgramFiles "Terraform")
    (Join-Path $env:LOCALAPPDATA "Programs\Terraform")
    (Join-Path $env:USERPROFILE "scoop\shims")
)

function Initialize-WindowsCliPath {
    [CmdletBinding()]
    param()

    $existingPath = [string]$env:Path
    $segments = $existingPath -split ';' | ForEach-Object { $_.Trim() } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    $prepend = New-Object System.Collections.Generic.List[string]

    foreach ($candidate in $script:WindowsCliPathCandidates) {
        if ([string]::IsNullOrWhiteSpace($candidate)) {
            continue
        }
        if (-not (Test-Path -LiteralPath $candidate)) {
            continue
        }
        $normalized = $candidate.TrimEnd('\')
        if ($segments -contains $normalized) {
            continue
        }
        [void]$prepend.Add($normalized)
    }

    if ($prepend.Count -eq 0) {
        return
    }

    $env:Path = (($prepend.ToArray() + $segments) -join ';')
}

function Resolve-TerraformExecutable {
    [CmdletBinding()]
    param()

    Initialize-WindowsCliPath

    $cmd = Get-Command terraform -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source) {
        return $cmd.Source
    }

    $wingetLink = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Links\terraform.exe"
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

    # where.exe exit 1 when missing must not poison the caller's process exit code
    # if a later best-effort path succeeds or the caller falls back.
    $global:LASTEXITCODE = 0

    throw @"
terraform executable not found.
Install: winget install Hashicorp.Terraform
Verify: where.exe terraform
See: docs/CLI_PATHS_WINDOWS.md
"@
}

function Assert-TerraformAvailable {
    [CmdletBinding()]
    param()

    $null = Resolve-TerraformExecutable
}
