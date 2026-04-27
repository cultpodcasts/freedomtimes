[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Collection,

    [Parameter(Mandatory = $true)]
    [string[]]$Ids,

    [string[]]$FieldNames = @("abstract"),
    [string]$StagingUrl = $env:EMDASH_STAGING_URL,
    [string]$StagingToken = $env:EMDASH_STAGING_TOKEN,
    [string]$ProductionUrl = $env:EMDASH_PRODUCTION_URL,
    [string]$ProductionToken = $env:EMDASH_PRODUCTION_TOKEN,
    [string]$RollbackMetadataFile,
    [switch]$AllowProduction,
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$MojibakePattern = 'ΓÇ|╬ô├ç├û'

function Test-CommandAvailable {
    param([string]$CommandName)
    return $null -ne (Get-Command $CommandName -ErrorAction SilentlyContinue)
}

function Get-StoredEmdashAccessToken {
    param([string]$Url)

    $authPath = Join-Path $HOME ".config\emdash\auth.json"
    if (-not (Test-Path $authPath)) {
        return $null
    }

    $auth = Get-Content -Path $authPath -Raw | ConvertFrom-Json
    $entry = $auth.PSObject.Properties[$Url]
    if ($null -eq $entry) {
        return $null
    }

    return $entry.Value.accessToken
}

function Test-Mojibake {
    param($Value)

    if ($null -eq $Value) {
        return $false
    }

    $serialized = $Value | ConvertTo-Json -Depth 50 -Compress
    return $serialized -match $MojibakePattern
}

function Invoke-EmdashContentJson {
    param(
        [string[]]$CommandArgs,
        [string]$Url,
        [string]$Token
    )

    $args = @("--prefix", "web", "emdash", "content") + $CommandArgs + @("-u", $Url, "-t", $Token, "--json")
    $output = & npx @args 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "emdash content $($CommandArgs -join ' ') failed.`n$output"
    }

    return ($output | ConvertFrom-Json)
}

function Set-ObjectPropertyValue {
    param(
        [Parameter(Mandatory = $true)]$Target,
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $false)]$Value
    )

    $property = $Target.PSObject.Properties[$Name]
    if ($null -ne $property) {
        $property.Value = $Value
        return
    }

    $Target | Add-Member -NotePropertyName $Name -NotePropertyValue $Value
}

if (-not $AllowProduction) {
    throw "Refusing to repair production content without -AllowProduction."
}

if (-not $DryRun -and [string]::IsNullOrWhiteSpace($RollbackMetadataFile)) {
    throw "Non-dry-run content repair requires -RollbackMetadataFile from a pre-created Turso rollback branch."
}

if (-not $DryRun) {
    if (-not (Test-Path $RollbackMetadataFile)) {
        throw "Rollback metadata file not found: $RollbackMetadataFile"
    }

    $rollbackMetadata = Get-Content -Path $RollbackMetadataFile -Raw | ConvertFrom-Json
    if ([string]::IsNullOrWhiteSpace($rollbackMetadata.rollbackDatabase)) {
        throw "Rollback metadata file does not contain rollbackDatabase. Refusing to repair production content."
    }
}

foreach ($commandName in @("npx")) {
    if (-not (Test-CommandAvailable -CommandName $commandName)) {
        throw "$commandName is required."
    }
}

if ([string]::IsNullOrWhiteSpace($StagingUrl) -or [string]::IsNullOrWhiteSpace($ProductionUrl)) {
    throw "Set staging and production URLs via parameters or EMDASH_* environment variables."
}

if ([string]::IsNullOrWhiteSpace($StagingToken)) {
    $StagingToken = Get-StoredEmdashAccessToken -Url $StagingUrl
}

if ([string]::IsNullOrWhiteSpace($ProductionToken)) {
    $ProductionToken = Get-StoredEmdashAccessToken -Url $ProductionUrl
}

if ([string]::IsNullOrWhiteSpace($StagingToken) -or [string]::IsNullOrWhiteSpace($ProductionToken)) {
    throw "Set staging and production tokens via parameters, environment variables, or emdash login."
}

$repoRoot = Split-Path $PSScriptRoot -Parent
$tempDirectory = Join-Path $repoRoot ".tmp\content-repair"
if (-not (Test-Path $tempDirectory)) {
    New-Item -ItemType Directory -Path $tempDirectory -Force | Out-Null
}

if (-not $DryRun) {
    Write-Host "Rollback checkpoint: $($rollbackMetadata.rollbackDatabase)" -ForegroundColor Magenta
    Write-Host "Metadata file: $RollbackMetadataFile" -ForegroundColor Magenta
    Write-Host ""
}

foreach ($id in $Ids) {
    Write-Host "Repair candidate: $Collection/$id" -ForegroundColor Cyan

    $stagingItem = Invoke-EmdashContentJson -CommandArgs @("get", $Collection, $id, "--published") -Url $StagingUrl -Token $StagingToken
    $productionItem = Invoke-EmdashContentJson -CommandArgs @("get", $Collection, $id, "--published") -Url $ProductionUrl -Token $ProductionToken

    if ([string]::IsNullOrWhiteSpace($productionItem._rev)) {
        throw "Production item $Collection/$id did not return _rev. Refusing to overwrite unseen changes."
    }

    $updatedData = $productionItem.data | ConvertTo-Json -Depth 50 | ConvertFrom-Json
    $fieldChanges = [System.Collections.Generic.List[string]]::new()

    foreach ($fieldName in $FieldNames) {
        $stagingField = $stagingItem.data.PSObject.Properties[$fieldName]
        if ($null -eq $stagingField) {
            throw "Field '$fieldName' does not exist on staging item $Collection/$id."
        }

        $sourceValue = $stagingField.Value
        if (Test-Mojibake -Value $sourceValue) {
            throw "Staging source field '$fieldName' for $Collection/$id contains mojibake. Refusing to propagate corrupt text."
        }

        $productionField = $productionItem.data.PSObject.Properties[$fieldName]
        $productionValue = if ($null -ne $productionField) { $productionField.Value } else { $null }

        $sourceJson = $sourceValue | ConvertTo-Json -Depth 50 -Compress
        $productionJson = $productionValue | ConvertTo-Json -Depth 50 -Compress
        if ($sourceJson -eq $productionJson) {
            continue
        }

        Set-ObjectPropertyValue -Target $updatedData -Name $fieldName -Value $sourceValue
        $fieldChanges.Add($fieldName)
    }

    if ($fieldChanges.Count -eq 0) {
        Write-Host "  No changes needed." -ForegroundColor Green
        continue
    }

    Write-Host "  Fields to repair: $($fieldChanges -join ', ')" -ForegroundColor Yellow

    if ($DryRun) {
        continue
    }

    $payloadPath = Join-Path $tempDirectory "$Collection-$($id -replace '[^A-Za-z0-9._-]', '_').json"
    $updatedData | ConvertTo-Json -Depth 50 | Set-Content -Path $payloadPath -Encoding UTF8

    $updateArgs = @("update", $Collection, $id, "--file", $payloadPath, "--rev", $productionItem._rev)
    $null = Invoke-EmdashContentJson -CommandArgs $updateArgs -Url $ProductionUrl -Token $ProductionToken

    $reloadedProductionItem = Invoke-EmdashContentJson -CommandArgs @("get", $Collection, $id, "--published") -Url $ProductionUrl -Token $ProductionToken
    foreach ($fieldName in $fieldChanges) {
        $sourceJson = $stagingItem.data.PSObject.Properties[$fieldName].Value | ConvertTo-Json -Depth 50 -Compress
        $reloadedJson = $reloadedProductionItem.data.PSObject.Properties[$fieldName].Value | ConvertTo-Json -Depth 50 -Compress
        if ($sourceJson -ne $reloadedJson) {
            throw "Post-update verification failed for $Collection/$id field '$fieldName'."
        }
        if (Test-Mojibake -Value $reloadedProductionItem.data.PSObject.Properties[$fieldName].Value) {
            throw "Post-update verification found mojibake in production $Collection/$id field '$fieldName'."
        }
    }

    Write-Host "  Repaired successfully." -ForegroundColor Green
}

if ($DryRun) {
    Write-Host "DryRun complete. No production changes applied." -ForegroundColor Yellow
}