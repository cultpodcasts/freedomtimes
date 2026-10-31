# PATH helpers shared by the backup / DR / rollback-branch scripts (#114).
#
# Why: on Linux, PowerShell environment variables are case-sensitive. Assigning to `$env:Path` there
# creates a second variable named `Path` and leaves `PATH` (the one the OS and `Get-Command`
# use) untouched, so a "~/.turso/turso" fallback written that way silently did nothing and the
# later `& turso ...` failed with "command not found". `$env:PATH` is correct on both: Windows
# environment variables are case-insensitive, so `$env:PATH` and `$env:Path` are the same
# variable there.
#
# Dot-source: . "$PSScriptRoot/lib/PathEntry.ps1"   (from scripts/)

function Test-PathEntryPresent {
    <#
    .SYNOPSIS
      True if Directory is already one of the entries in PathValue (case-insensitive on Windows,
      case-sensitive elsewhere; a trailing separator is ignored).
    #>
    param(
        [Parameter(Mandatory)][string]$Directory,
        [AllowNull()][AllowEmptyString()][string]$PathValue = $env:PATH
    )
    if ([string]::IsNullOrEmpty($PathValue)) { return $false }
    $comparison = if ($IsWindows) { [StringComparison]::OrdinalIgnoreCase } else { [StringComparison]::Ordinal }
    $want = $Directory.TrimEnd([char[]]@('/', '\'))
    foreach ($entry in $PathValue.Split([IO.Path]::PathSeparator)) {
        if ([string]::IsNullOrEmpty($entry)) { continue }
        if ([string]::Equals($entry.TrimEnd([char[]]@('/', '\')), $want, $comparison)) { return $true }
    }
    return $false
}

function Add-PathEntry {
    <#
    .SYNOPSIS
      Prepend Directory to this process's PATH (always `$env:PATH`, never `$env:Path`; see the
      file header). No-op if it is already an entry. Process scope only: never User/Machine.
    #>
    param([Parameter(Mandatory)][string]$Directory)
    if (Test-PathEntryPresent -Directory $Directory -PathValue $env:PATH) { return }
    $env:PATH = if ([string]::IsNullOrEmpty($env:PATH)) { $Directory } else { "$Directory$([IO.Path]::PathSeparator)$env:PATH" }
}

function Get-HomeTursoCliPath {
    <# The Turso installer's default location: $HOME/.turso/turso (turso.exe on Windows). #>
    param([string]$HomeDirectory = $HOME)
    $dir = Join-Path $HomeDirectory ".turso"
    $names = if ($IsWindows) { @("turso.exe", "turso") } else { @("turso") }
    foreach ($n in $names) {
        $candidate = Join-Path $dir $n
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
    return $null
}

function Initialize-NativeTursoCli {
    <#
    .SYNOPSIS
      Make `turso` resolvable for native (non-WSL) Turso calls. If `turso` is not on PATH but the
      installer's $HOME/.turso/turso exists, prepend its directory to `$env:PATH`, then confirm
      `Get-Command turso` now resolves. A non-executable file (Linux) or a CLI that still does not
      resolve fails here with a clear message, not later as "command not found" / "Permission
      denied". Throws MissingMessage when there is no CLI.
      Returns the resolved command path.
    #>
    param(
        [Parameter(Mandatory)][string]$MissingMessage,
        [string]$HomeDirectory = $HOME
    )
    $cmd = Get-Command turso -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd) { return $cmd.Source }
    $homeTurso = Get-HomeTursoCliPath -HomeDirectory $HomeDirectory
    if (-not $homeTurso) { throw $MissingMessage }
    if (-not $IsWindows) {
        # PowerShell's Get-Command also lists files without the execute bit, so check it here: the
        # alternative is a "Permission denied" from the first `& turso`, after the resolver ran.
        $mode = [IO.File]::GetUnixFileMode($homeTurso)
        if (-not ($mode -band [IO.UnixFileMode]::UserExecute)) {
            throw "Found $homeTurso but it is not executable: chmod +x $homeTurso"
        }
    }
    Add-PathEntry -Directory (Split-Path $homeTurso -Parent)
    $cmd = Get-Command turso -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $cmd) {
        throw "Found $homeTurso and added its directory to PATH, but 'turso' still does not resolve (is it executable? chmod +x $homeTurso)."
    }
    return $cmd.Source
}
