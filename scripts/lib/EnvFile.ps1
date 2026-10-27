# Shared .env file parsing. Dot-source only; defines functions and has no side effects.
#
# One parser for every caller (Deploy-EnvironmentCommon.ps1, backup-production-emdash.ps1):
# - blank lines and lines starting with # are skipped
# - a line must match KEY=VALUE where KEY is [A-Za-z_][A-Za-z0-9_]*; anything else is ignored
# - key and value are trimmed, including a UTF-8 BOM (U+FEFF)
# - values are taken literally (no quote stripping, no `export ` prefix handling)
#
# Never log values returned from these functions; they are usually secrets.

function Read-EnvFileEntries {
    <#
    .SYNOPSIS
      Parse a .env file into ordered KEY/VALUE entries (file order, duplicates kept).
      Returns an empty array when the file does not exist.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return , @()
    }

    $entries = [System.Collections.Generic.List[object]]::new()
    foreach ($raw in Get-Content -LiteralPath $Path) {
        $line = ([string]$raw).Trim().Trim([char]0xFEFF).Trim()
        if ([string]::IsNullOrWhiteSpace($line) -or $line.StartsWith("#")) { continue }
        if ($line -notmatch '^[A-Za-z_][A-Za-z0-9_]*=') { continue }
        $parts = $line -split '=', 2
        $entries.Add([pscustomobject]@{
                Key   = $parts[0].Trim().Trim([char]0xFEFF)
                Value = $parts[1].Trim().Trim([char]0xFEFF)
            })
    }
    return , $entries.ToArray()
}

function Import-EnvFileFillMissing {
    <#
    .SYNOPSIS
      Set process env vars from a .env file, only for the given keys, only where the
      process value is empty. Preset values always win; empty file values are skipped;
      the first occurrence of a key in the file wins. A missing file is a no-op.

    .OUTPUTS
      The key names that were filled (never values), in -Keys order.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string[]]$Keys
    )

    $fromFile = @{}
    foreach ($entry in (Read-EnvFileEntries -Path $Path)) {
        if ([string]::IsNullOrWhiteSpace($entry.Value)) { continue }
        if (-not $fromFile.ContainsKey($entry.Key)) {
            $fromFile[$entry.Key] = $entry.Value
        }
    }

    $filled = [System.Collections.Generic.List[string]]::new()
    foreach ($key in $Keys) {
        $existing = [Environment]::GetEnvironmentVariable($key, "Process")
        if (-not [string]::IsNullOrWhiteSpace($existing)) { continue }
        if (-not $fromFile.ContainsKey($key)) { continue }
        [Environment]::SetEnvironmentVariable($key, $fromFile[$key], "Process")
        $filled.Add($key)
    }
    return , $filled.ToArray()
}
