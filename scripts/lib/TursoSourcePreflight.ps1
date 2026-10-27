# Read-only Turso preflight for production backups. Dot-source only; no side effects.
#
# `turso db show <name>` exits non-zero for several reasons, not only "no such database":
# an expired or missing CLI login (WSL keeps its own ~/.turso login), a network failure,
# or the CLI's active org differing from the org the resolver used. The failure message
# therefore says "could not confirm" and carries the captured CLI output.

function Get-RedactedTursoCliOutput {
    <#
    .SYNOPSIS
      Turso CLI output lines with anything token-like replaced. `db show` prints name,
      id, URL and locations, never tokens, but this stays defensive.
    #>
    param([object[]]$Lines)
    $out = [System.Collections.Generic.List[string]]::new()
    foreach ($l in @($Lines)) {
        if ($null -eq $l) { continue }
        $text = [string]$l
        if ($text -match '(?i)token|jwt') {
            $out.Add("[redacted line]")
        }
        else {
            $out.Add($text)
        }
    }
    return , $out.ToArray()
}

function Format-TursoSourcePreflightFailure {
    param(
        [Parameter(Mandatory)][string]$DatabaseName,
        [Parameter(Mandatory)][int]$ExitCode,
        [string]$WorkerHost,
        [string]$Organization,
        [object[]]$Output,
        [switch]$UseWsl
    )
    $org = if ([string]::IsNullOrWhiteSpace($Organization)) { "unset" } else { $Organization.Trim() }
    $cli = if ($UseWsl) { "turso CLI in WSL" } else { "turso CLI" }
    $loginHint = if ($UseWsl) {
        "the $cli is not logged in (WSL has its own ~/.turso login: wsl bash -lc '`$HOME/.turso/turso auth login')"
    }
    else {
        "the $cli is not logged in (turso auth login)"
    }
    $lines = @(
        "Could not confirm Turso database '$DatabaseName' exists (exit $ExitCode). Worker host '$WorkerHost'.",
        "Refusing to create a backup branch or export.",
        "Possible causes: $loginHint; a network failure; the CLI's active org differs from the resolver org '$org';",
        "or the database name still carries the org slug (the name must be the Turso name without '-<org>').",
        "The resolver org comes from TF_VAR_TURSO_ORGANIZATION / TURSO_ORGANIZATION (the Turso org, not the GitHub org).",
        "turso db show output:"
    )
    $redacted = Get-RedactedTursoCliOutput -Lines $Output
    if ($redacted.Count -eq 0) {
        $lines += "  (no output)"
    }
    else {
        $lines += ($redacted | ForEach-Object { "  $_" })
    }
    return ($lines -join "`n")
}

function Test-TursoSourceDatabase {
    <#
    .SYNOPSIS
      Run `turso db show <name>` (native or via WSL) and return
      [pscustomobject]@{ Ok; ExitCode; Output }. Never throws on CLI failure.
    #>
    param(
        [Parameter(Mandatory)][string]$DatabaseName,
        [switch]$UseWsl
    )
    if ($UseWsl) {
        $quoted = "'" + ($DatabaseName -replace "'", "'\''") + "'"
        $lines = & wsl bash -lc ('$HOME/.turso/turso db show ' + $quoted) 2>&1
    }
    else {
        $lines = & turso db show $DatabaseName 2>&1
    }
    $exitCode = $LASTEXITCODE
    return [pscustomobject]@{
        Ok       = ($exitCode -eq 0)
        ExitCode = $exitCode
        Output   = @($lines)
    }
}
