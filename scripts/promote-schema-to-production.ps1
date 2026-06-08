<#
.SYNOPSIS
    Diff EmDash schema between staging and production, then interactively apply missing changes to production.

.DESCRIPTION
    Fetches the full schema from staging and production, computes the diff (new collections, new fields),
    presents the required CLI commands for human review, and only applies them after explicit confirmation.

    Schema changes that exist in production but not staging are reported as warnings and never removed.
    Destructive operations (delete collection, remove-field) are never generated — use the CLI manually.

.PARAMETER StagingUrl
    EmDash staging instance URL (or set EMDASH_STAGING_URL).

.PARAMETER StagingToken
    EmDash staging API token (or set EMDASH_STAGING_TOKEN). If omitted, the script
    falls back to the token stored by `emdash login`.

.PARAMETER ProductionUrl
    EmDash production instance URL (or set EMDASH_PRODUCTION_URL).

.PARAMETER ProductionToken
    EmDash production API token (or set EMDASH_PRODUCTION_TOKEN). If omitted, the script
    falls back to the token stored by `emdash login`.

.PARAMETER RollbackMetadataFile
    Path to the rollback metadata JSON produced by `turso-create-rollback-branch.ps1`.
    Required for non-dry-run production schema changes.

.PARAMETER DryRun
    Print the diff and generated commands but do not apply anything.

.PARAMETER AllowProduction
    Required guardrail flag. Must be passed explicitly to apply changes to production.

.EXAMPLE
    .\scripts\promote-schema-to-production.ps1 -AllowProduction -DryRun
    .\scripts\promote-schema-to-production.ps1 -AllowProduction
#>

[CmdletBinding()]
param(
    [string]$StagingUrl    = $env:EMDASH_STAGING_URL,
    [string]$StagingToken  = $env:EMDASH_STAGING_TOKEN,
    [string]$ProductionUrl = $env:EMDASH_PRODUCTION_URL,
    [string]$ProductionToken = $env:EMDASH_PRODUCTION_TOKEN,
    [string]$RollbackMetadataFile,

    [switch]$DryRun,
    [switch]$AllowProduction
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ── Guards ─────────────────────────────────────────────────────────────────────

if (-not $AllowProduction) {
    Write-Error "Pass -AllowProduction to confirm you intend to diff/apply to production."
    exit 1
}

if (-not $DryRun -and [string]::IsNullOrWhiteSpace($RollbackMetadataFile)) {
    Write-Error "Non-dry-run schema promotion requires -RollbackMetadataFile from a pre-created Turso rollback branch."
    exit 1
}

if (-not $DryRun) {
    if (-not (Test-Path $RollbackMetadataFile)) {
        Write-Error "Rollback metadata file not found: $RollbackMetadataFile"
        exit 1
    }

    try {
        $rollbackMetadata = Get-Content -Path $RollbackMetadataFile -Raw | ConvertFrom-Json
    }
    catch {
        Write-Error "Failed to read rollback metadata JSON from $RollbackMetadataFile. $_"
        exit 1
    }

    if ([string]::IsNullOrWhiteSpace($rollbackMetadata.rollbackDatabase)) {
        Write-Error "Rollback metadata file does not contain rollbackDatabase. Refusing to apply production schema changes."
        exit 1
    }
}

foreach ($param in @(
    @{ Name = "StagingUrl";    Value = $StagingUrl },
    @{ Name = "ProductionUrl"; Value = $ProductionUrl }
)) {
    if ([string]::IsNullOrWhiteSpace($param.Value)) {
        Write-Error "Missing required parameter: $($param.Name). Set via argument or environment variable."
        exit 1
    }
}

if (-not (Get-Command "npx" -ErrorAction SilentlyContinue)) {
    Write-Error "npx is not available. Run 'npm install' in the web/ directory or ensure Node.js is on PATH."
    exit 1
}

# ── Helpers ────────────────────────────────────────────────────────────────────

function Get-StoredEmdashAccessToken {
    param([string]$Url)

    $authPath = Join-Path $HOME ".config\emdash\auth.json"
    if (-not (Test-Path $authPath)) {
        return $null
    }

    try {
        $auth = Get-Content -Path $authPath -Raw | ConvertFrom-Json
    }
    catch {
        Write-Error "Failed to parse EmDash auth JSON from $authPath. $_"
        exit 1
    }

    $entry = $auth.PSObject.Properties[$Url]
    if ($null -eq $entry) {
        return $null
    }

    $value = $entry.Value
    if ($value.PSObject.Properties["accessToken"] -and -not [string]::IsNullOrWhiteSpace($value.accessToken)) {
        return $value.accessToken
    }

    if ($value.PSObject.Properties["refreshToken"] -and -not [string]::IsNullOrWhiteSpace($value.refreshToken)) {
        throw @"
Stored EmDash OAuth credential for $Url has no accessToken (likely expired).
Refresh it interactively, then re-run this script:

  cd web
  npx emdash login -u $Url

Or pass -StagingToken / -ProductionToken, or set EMDASH_STAGING_TOKEN / EMDASH_PRODUCTION_TOKEN.
"@
    }

    return $null
}

function Invoke-EmdashSchema {
    param([string]$Subcommand, [string]$Url, [string]$Token, [string[]]$ExtraArgs = @())
    $argList = @("--prefix", "web", "emdash", "schema") + $Subcommand.Split(" ") + @("-u", $Url, "-t", $Token, "--json") + $ExtraArgs
    $output = & npx @argList 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Error "emdash schema $Subcommand failed:`n$output"
        exit 1
    }
    return $output | ConvertFrom-Json
}

function Get-FullSchema {
    param([string]$Url, [string]$Token, [string]$Label)
    Write-Host "  Fetching schema from $Label..." -ForegroundColor DarkGray
    $collections = Invoke-EmdashSchema -Subcommand "list" -Url $Url -Token $Token
    $result = @{}
    foreach ($col in $collections) {
        $detail = Invoke-EmdashSchema -Subcommand "get $($col.slug)" -Url $Url -Token $Token
        $result[$col.slug] = $detail
    }
    return $result
}

function Build-AddFieldCommand {
    param([string]$CollectionSlug, $Field)
    $cmd = "npx --prefix web emdash schema add-field $CollectionSlug $($Field.slug) --type $($Field.type)"
    if ($Field.PSObject.Properties["label"] -and -not [string]::IsNullOrWhiteSpace($Field.label)) {
        $cmd += " --label `"$($Field.label)`""
    }
    if ($Field.PSObject.Properties["required"] -and $Field.required -eq $true) {
        $cmd += " --required"
    }
    $cmd += " -u `$env:EMDASH_PRODUCTION_URL -t `$env:EMDASH_PRODUCTION_TOKEN --json"
    return @{
        Kind        = "add-field"
        Collection  = $CollectionSlug
        Description = "New field: $CollectionSlug.$($Field.slug) (type: $($Field.type))"
        Command     = $cmd
    }
}

if ([string]::IsNullOrWhiteSpace($StagingToken)) {
    $StagingToken = Get-StoredEmdashAccessToken -Url $StagingUrl
}

if ([string]::IsNullOrWhiteSpace($ProductionToken)) {
    $ProductionToken = Get-StoredEmdashAccessToken -Url $ProductionUrl
}

foreach ($param in @(
    @{ Name = "StagingToken";    Value = $StagingToken; Url = $StagingUrl },
    @{ Name = "ProductionToken"; Value = $ProductionToken; Url = $ProductionUrl }
)) {
    if ([string]::IsNullOrWhiteSpace($param.Value)) {
        Write-Error "Missing required parameter: $($param.Name). Set via argument, environment variable, or run 'emdash login -u $($param.Url)' first."
        exit 1
    }
}

if ([string]::IsNullOrWhiteSpace($env:EMDASH_STAGING_URL)) {
    $env:EMDASH_STAGING_URL = $StagingUrl
}

if ([string]::IsNullOrWhiteSpace($env:EMDASH_STAGING_TOKEN)) {
    $env:EMDASH_STAGING_TOKEN = $StagingToken
}

if ([string]::IsNullOrWhiteSpace($env:EMDASH_PRODUCTION_URL)) {
    $env:EMDASH_PRODUCTION_URL = $ProductionUrl
}

if ([string]::IsNullOrWhiteSpace($env:EMDASH_PRODUCTION_TOKEN)) {
    $env:EMDASH_PRODUCTION_TOKEN = $ProductionToken
}

# ── Fetch ──────────────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "Fetching staging schema..." -ForegroundColor Cyan
$stagingSchema = Get-FullSchema -Url $StagingUrl -Token $StagingToken -Label "staging"

Write-Host "Fetching production schema..." -ForegroundColor Cyan
$productionSchema = Get-FullSchema -Url $ProductionUrl -Token $ProductionToken -Label "production"

# ── Diff ───────────────────────────────────────────────────────────────────────

$pendingCommands = [System.Collections.Generic.List[hashtable]]::new()
$warnings = [System.Collections.Generic.List[string]]::new()

# 1. Collections in staging that are missing from production
foreach ($slug in $stagingSchema.Keys) {
    $stagingCol = $stagingSchema[$slug]
    if (-not $productionSchema.ContainsKey($slug)) {
        $cmd = "npx --prefix web emdash schema create $slug --label `"$($stagingCol.label)`""
        if ($stagingCol.PSObject.Properties["labelSingular"] -and $stagingCol.labelSingular -ne $stagingCol.label) {
            $cmd += " --label-singular `"$($stagingCol.labelSingular)`""
        }
        if ($stagingCol.PSObject.Properties["description"] -and -not [string]::IsNullOrWhiteSpace($stagingCol.description)) {
            $cmd += " --description `"$($stagingCol.description)`""
        }
        $cmd += " -u `$env:EMDASH_PRODUCTION_URL -t `$env:EMDASH_PRODUCTION_TOKEN --json"
        $pendingCommands.Add(@{
            Kind        = "create-collection"
            Collection  = $slug
            Description = "New collection: $slug"
            Command     = $cmd
        })

        # All fields in this new collection also need to be created
        foreach ($field in $stagingCol.fields) {
            $pendingCommands.Add((Build-AddFieldCommand -CollectionSlug $slug -Field $field))
        }
    }
    else {
        # 2. Fields in staging collection that are missing from production collection
        $prodCol = $productionSchema[$slug]
        $prodFieldSlugs = @{}
        foreach ($f in $prodCol.fields) { $prodFieldSlugs[$f.slug] = $true }

        foreach ($field in $stagingCol.fields) {
            if (-not $prodFieldSlugs.ContainsKey($field.slug)) {
                $pendingCommands.Add((Build-AddFieldCommand -CollectionSlug $slug -Field $field))
            }
        }

        # 3. Fields in production but not in staging — warn, never remove
        $stagingFieldSlugs = @{}
        foreach ($f in $stagingCol.fields) { $stagingFieldSlugs[$f.slug] = $true }
        foreach ($f in $prodCol.fields) {
            if (-not $stagingFieldSlugs.ContainsKey($f.slug)) {
                $warnings.Add("  WARN: field '$($f.slug)' exists in production.$slug but not in staging.$slug - not removed (review manually)")
            }
        }
    }
}

# 4. Collections in production but not in staging — warn only
foreach ($slug in $productionSchema.Keys) {
    if (-not $stagingSchema.ContainsKey($slug)) {
        $warnings.Add("  WARN: collection '$slug' exists in production but not in staging - not removed (review manually)")
    }
}

function Build-AddFieldCommand {
    param([string]$CollectionSlug, $Field)
    $cmd = "npx --prefix web emdash schema add-field $CollectionSlug $($Field.slug) --type $($Field.type)"
    if ($Field.PSObject.Properties["label"] -and -not [string]::IsNullOrWhiteSpace($Field.label)) {
        $cmd += " --label `"$($Field.label)`""
    }
    if ($Field.PSObject.Properties["required"] -and $Field.required -eq $true) {
        $cmd += " --required"
    }
    $cmd += " -u `$env:EMDASH_PRODUCTION_URL -t `$env:EMDASH_PRODUCTION_TOKEN --json"
    return @{
        Kind        = "add-field"
        Collection  = $CollectionSlug
        Description = "New field: $CollectionSlug.$($Field.slug) (type: $($Field.type))"
        Command     = $cmd
    }
}

# ── Report ─────────────────────────────────────────────────────────────────────

Write-Host ""

if ($warnings.Count -gt 0) {
    Write-Host "── Warnings (review manually, no action taken) ──" -ForegroundColor Yellow
    foreach ($w in $warnings) { Write-Host $w -ForegroundColor Yellow }
    Write-Host ""
}

if ($pendingCommands.Count -eq 0) {
    Write-Host "Schema is already in sync. No changes needed." -ForegroundColor Green
    exit 0
}

Write-Host "── Schema diff: $($pendingCommands.Count) change(s) to apply to production ──" -ForegroundColor Cyan
Write-Host ""
$i = 1
foreach ($cmd in $pendingCommands) {
    Write-Host "  [$i] $($cmd.Description)" -ForegroundColor White
    Write-Host "      $($cmd.Command)" -ForegroundColor DarkGray
    Write-Host ""
    $i++
}

if ($DryRun) {
    Write-Host "DryRun: no changes applied." -ForegroundColor Yellow
    exit 0
}

# ── Human confirmation ─────────────────────────────────────────────────────────

Write-Host "── Review the commands above carefully before proceeding. ──" -ForegroundColor Magenta
Write-Host ""
Write-Host "Rollback checkpoint: $($rollbackMetadata.rollbackDatabase)" -ForegroundColor Magenta
Write-Host "Metadata file: $RollbackMetadataFile" -ForegroundColor Magenta
Write-Host "Remove any commands you do not want applied, or abort now." -ForegroundColor Magenta
Write-Host ""
$confirm = Read-Host "Apply all $($pendingCommands.Count) command(s) to production? [yes/no]"
if ($confirm -ne "yes") {
    Write-Host "Aborted. No changes applied." -ForegroundColor Yellow
    exit 0
}

# ── Apply ──────────────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "Applying schema changes to production..." -ForegroundColor Cyan
$applied = 0
$failed  = 0

foreach ($item in $pendingCommands) {
    Write-Host "  → $($item.Description)" -ForegroundColor White
    # Expand env vars in command string before execution
    $expanded = $ExecutionContext.InvokeCommand.ExpandString($item.Command)
    # Strip the leading 'npx' and split into args for direct invocation
    $parts = $expanded -split '\s+(?=(?:[^"]*"[^"]*")*[^"]*$)'
    $exe   = $parts[0]
    $commandArgs = $parts[1..($parts.Length - 1)]
    & $exe @commandArgs
    if ($LASTEXITCODE -eq 0) {
        Write-Host "    OK" -ForegroundColor Green
        $applied++
    }
    else {
        Write-Host "    FAILED - stopping. Review production state before retrying." -ForegroundColor Red
        $failed++
        break
    }
}

Write-Host ""
if ($failed -eq 0) {
    Write-Host "Schema promotion complete. $applied change(s) applied." -ForegroundColor Green
    Write-Host "Run the parity check to confirm:" -ForegroundColor DarkGray
    Write-Host "  npx --prefix web emdash schema list -u `$env:EMDASH_PRODUCTION_URL -t `$env:EMDASH_PRODUCTION_TOKEN --json" -ForegroundColor DarkGray
}
else {
    Write-Host "$applied applied, $failed failed. Production schema may be in a partial state." -ForegroundColor Red
    exit 1
}
