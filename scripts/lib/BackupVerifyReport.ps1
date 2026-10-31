# Verify-report helpers for backup-production-emdash.ps1 (#161). Dot-source only; defines
# functions and has no side effects.
#
# verify-production-emdash-backup.mjs prints its failures as one JSON line
# { "pass": false, "error": "<kind>", "message": "...", ... } and (since #161) also writes that
# object to --metadata-out. These helpers turn either into a verification record for the backup
# metadata and a failure message that names the cause, instead of a bare "VERIFY FAILED".
# Nothing here ever handles a token value: reports carry variable NAMES only.

function Get-LastJsonObjectFromOutput {
    <#
    .SYNOPSIS
      Last output line that parses as a JSON object, or $null.
    #>
    param([object[]]$Output)
    $found = $null
    foreach ($line in @($Output)) {
        $text = ([string]$line).Trim()
        if (-not $text.StartsWith("{") -or -not $text.EndsWith("}")) { continue }
        try {
            $found = $text | ConvertFrom-Json -ErrorAction Stop
        }
        catch {
            continue
        }
    }
    return $found
}

function Get-BackupVerifyFailureFromOutput {
    <#
    .SYNOPSIS
      Last JSON object line in verify output with pass=false and an error kind, or $null.
    #>
    param([object[]]$Output)
    $found = $null
    foreach ($line in @($Output)) {
        $text = ([string]$line).Trim()
        if (-not $text.StartsWith("{") -or -not $text.EndsWith("}")) { continue }
        try {
            $obj = $text | ConvertFrom-Json -ErrorAction Stop
        }
        catch {
            continue
        }
        $props = $obj.PSObject.Properties
        if ($props["pass"] -and $obj.pass -eq $false -and $props["error"] -and -not [string]::IsNullOrWhiteSpace([string]$obj.error)) {
            $found = $obj
        }
    }
    return $found
}

function Get-BackupVerifyProperty {
    param([object]$Object, [string]$Name)
    if ($null -eq $Object) { return $null }
    $p = $Object.PSObject.Properties[$Name]
    if ($p) { return $p.Value }
    return $null
}

function New-BackupVerificationRecord {
    <#
    .SYNOPSIS
      The metadata "verification" value: the verify report when it was written, otherwise a
      failure record built from the verify output, so the metadata always says why (#161).
    #>
    param(
        [string]$ReportPath,
        [int]$ExitCode,
        [object[]]$Output
    )
    if (-not [string]::IsNullOrWhiteSpace($ReportPath) -and (Test-Path -LiteralPath $ReportPath)) {
        try {
            return (Get-Content -LiteralPath $ReportPath -Raw | ConvertFrom-Json -ErrorAction Stop)
        }
        catch {
            return [pscustomobject][ordered]@{
                pass     = $false
                error    = "verify_report_unreadable"
                message  = "The verify report at $ReportPath is not valid JSON: $($_.Exception.Message)"
                exitCode = $ExitCode
            }
        }
    }
    $failure = Get-BackupVerifyFailureFromOutput -Output $Output
    if ($null -ne $failure) {
        $record = [ordered]@{ pass = $false; exitCode = $ExitCode }
        foreach ($p in $failure.PSObject.Properties) {
            if ($p.Name -ne "pass") { $record[$p.Name] = $p.Value }
        }
        return [pscustomobject]$record
    }
    return [pscustomobject][ordered]@{
        pass     = $false
        error    = "verify_no_report"
        message  = "verify-production-emdash-backup.mjs exited $ExitCode without a report or a JSON error line."
        exitCode = $ExitCode
    }
}

function Get-BackupTokenOriginNote {
    <#
    .SYNOPSIS
      Where the named token came from, for the failure message: .env.dev (filled by this
      script) or the environment (a preset value wins over .env.dev).
    #>
    param(
        [string]$TokenSource,
        [string[]]$FilledFromEnvDev = @()
    )
    if ([string]::IsNullOrWhiteSpace($TokenSource)) { return "" }
    if ($TokenSource -like "*auth.json") { return " (from $TokenSource)" }
    if (@($FilledFromEnvDev) -contains $TokenSource) { return " ($TokenSource was loaded from .env.dev)" }
    return " ($TokenSource came from the process or user environment, which overrides .env.dev: update or remove that variable too)"
}

function Format-StagingAuthPreflightFailure {
    <#
    .SYNOPSIS
      Thrown before any Turso branch or export when the staging token check fails.
    #>
    param(
        [object]$Failure,
        [int]$ExitCode,
        [string[]]$FilledFromEnvDev = @()
    )
    $kind = [string](Get-BackupVerifyProperty $Failure "error")
    $message = [string](Get-BackupVerifyProperty $Failure "message")
    if ([string]::IsNullOrWhiteSpace($kind)) { $kind = "staging_check_failed" }
    if ([string]::IsNullOrWhiteSpace($message)) { $message = "verify-production-emdash-backup.mjs --check-staging-auth exited $ExitCode without a JSON error line." }
    $origin = Get-BackupTokenOriginNote -TokenSource ([string](Get-BackupVerifyProperty $Failure "stagingTokenSource")) -FilledFromEnvDev $FilledFromEnvDev
    return "STAGING COMPARE CANNOT RUN ($kind)${origin}: $message Nothing was backed up (no Turso branch, no .db)."
}

function Format-BackupVerifyFailedMessage {
    <#
    .SYNOPSIS
      The final throw when verify fails. In GitHub Actions only the error kind and counts
      (public logs never carry slugs); locally the message and failures too.
    #>
    param(
        [object]$Verification,
        [string]$VerifyReportPath,
        [string]$MetadataPath,
        [string[]]$FilledFromEnvDev = @(),
        [switch]$PublicLog
    )
    $kind = [string](Get-BackupVerifyProperty $Verification "error")
    $failures = @(Get-BackupVerifyProperty $Verification "failures" | Where-Object { $null -ne $_ })
    $reason = if (-not [string]::IsNullOrWhiteSpace($kind)) {
        $kind
    }
    elseif ($failures.Count -gt 0) {
        "inventory_mismatch"
    }
    else {
        "unknown"
    }
    $detail = ""
    if (-not $PublicLog) {
        $message = [string](Get-BackupVerifyProperty $Verification "message")
        if (-not [string]::IsNullOrWhiteSpace($message)) {
            $origin = Get-BackupTokenOriginNote -TokenSource ([string](Get-BackupVerifyProperty $Verification "stagingTokenSource")) -FilledFromEnvDev $FilledFromEnvDev
            $detail = "${origin}: $message"
        }
        elseif ($failures.Count -gt 0) {
            $detail = ": " + ($failures -join "; ")
        }
    }
    elseif ($failures.Count -gt 0) {
        $detail = " ($($failures.Count) failure(s); detail withheld from public logs)"
    }
    return "PRODUCTION BACKUP VERIFY FAILED ($reason)$detail. Refusing to treat this checkpoint as good. See $VerifyReportPath and $MetadataPath (verification field)."
}
