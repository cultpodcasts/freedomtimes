# Behavioural tests for the Worker script upload guard and the post-apply Worker settings check.
# No network, no real terraform/node calls against Cloudflare, fake values only, no CI.
# Run: pwsh -NoProfile -File ./scripts/test-terraform-worker-script-guards.ps1
#
# Covers (PR #115 review):
# - scripts/lib/WorkerSettingsVerification.ps1 returns a clean [int] even when the verifier prints
#   to stdout/stderr (the bug that made `exit $exitCode` exit 0), with a fake `node` function and a
#   real native node process, and with $PSNativeCommandUseErrorActionPreference = $true.
# - a child `pwsh -File` that does `exit (Invoke-PostApplyWorkerSettingsCheck ...)` really exits 4 / 5.
# - scripts/terraform-plan-guard-worker-script-upload.ps1 on plan-JSON fixtures.
# - scripts/terraform-run.ps1 -Operation apply end to end with fake `terraform` and `node` executables
#   (Linux/macOS/WSL only: on Windows Initialize-WindowsCliPath prepends the real terraform to PATH,
#   so that section is skipped rather than risk calling it).
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path $PSScriptRoot -Parent
. "$PSScriptRoot/lib/WorkerSettingsVerification.ps1"
. "$PSScriptRoot/lib/TerraformWorkerScriptUploadGuard.ps1"

$script:Failed = 0
$script:Passed = 0
function Assert-True {
    param([bool]$Condition, [string]$Message)
    if ($Condition) { $script:Passed++; Write-Host "ok  $Message" }
    else { $script:Failed++; Write-Host "FAIL  $Message" -ForegroundColor Red }
}

$tmpRoot = if ($env:TMPDIR) { $env:TMPDIR } elseif ($env:TEMP) { $env:TEMP } else { "/tmp" }
$work = Join-Path $tmpRoot ("ft-worker-guard-tests-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $work | Out-Null
$pwshExe = (Get-Process -Id $PID).Path
$previousFollows = $env:FT_WRANGLER_DEPLOY_FOLLOWS
$env:FT_WRANGLER_DEPLOY_FOLLOWS = $null

# Fake repo whose web/scripts/verify-worker-placement.mjs is a real node script that prints to stdout
# and stderr and exits with FAKE_VERIFIER_EXIT.
$fakeRepo = Join-Path $work "repo"
New-Item -ItemType Directory -Force -Path (Join-Path $fakeRepo "web/scripts") | Out-Null
Set-Content -LiteralPath (Join-Path $fakeRepo "web/scripts/verify-worker-placement.mjs") -Value @'
console.log('[verify-worker-placement] worker=fake env=' + process.argv[3]);
console.error('[verify-worker-placement] FAIL fake failure line');
process.exitCode = Number(process.env.FAKE_VERIFIER_EXIT ?? '0');
'@

try {
    Write-Host "=== Invoke-WorkerSettingsVerifier: fake node function that writes to stdout ==="
    function node { Write-Output "[verify-worker-placement] line A"; Write-Output "line B"; $global:LASTEXITCODE = $script:FakeNodeExit }
    try {
        foreach ($case in @(@{ Exit = 0 }, @{ Exit = 1 }, @{ Exit = 2 })) {
            $script:FakeNodeExit = $case.Exit
            $r = Invoke-WorkerSettingsVerifier -RepoRoot $repoRoot -Environment production
            Assert-True (($r -is [int]) -and $r -eq $case.Exit) "verifier exit $($case.Exit) -> [int] $($case.Exit) (got $($r.GetType().Name) '$r')"
        }

        Write-Host "=== Invoke-PostApplyWorkerSettingsCheck: exit-code mapping ==="
        foreach ($case in @(@{ Node = 0; Want = 0 }, @{ Node = 1; Want = 4 }, @{ Node = 2; Want = 5 }, @{ Node = 9; Want = 5 })) {
            $script:FakeNodeExit = $case.Node
            $r = Invoke-PostApplyWorkerSettingsCheck -RepoRoot $repoRoot -Environment staging 6>$null
            Assert-True (($r -is [int]) -and $r -eq $case.Want) "post-apply: verifier $($case.Node) -> [int] $($case.Want) (got $($r.GetType().Name) '$r')"
        }

        $script:FakeNodeExit = 1
        $r = Invoke-PostApplyWorkerSettingsCheck -RepoRoot $repoRoot -Environment production -Skip 3>$null
        Assert-True (($r -is [int]) -and $r -eq 0) "-SkipWorkerSettingsVerification -> 0 (warning only)"
        $r = Invoke-PostApplyWorkerSettingsCheck -RepoRoot $repoRoot -Environment auth0-shared
        Assert-True (($r -is [int]) -and $r -eq 0) "auth0-shared has no Worker -> 0"
        $env:FT_WRANGLER_DEPLOY_FOLLOWS = "1"
        try {
            $r = Invoke-PostApplyWorkerSettingsCheck -RepoRoot $repoRoot -Environment production 6>$null
            Assert-True (($r -is [int]) -and $r -eq 0) "FT_WRANGLER_DEPLOY_FOLLOWS=1 defers the check to the deploy pipeline -> 0"
        }
        finally { $env:FT_WRANGLER_DEPLOY_FOLLOWS = $null }
    }
    finally {
        Remove-Item function:node -ErrorAction SilentlyContinue
    }

    Write-Host "=== Invoke-WorkerSettingsVerifier: real native node, PSNativeCommandUseErrorActionPreference = `$true ==="
    $PSNativeCommandUseErrorActionPreference = $true
    try {
        foreach ($code in 0, 1, 2) {
            $env:FAKE_VERIFIER_EXIT = "$code"
            $threw = $false
            try { $r = Invoke-WorkerSettingsVerifier -RepoRoot $fakeRepo -Environment staging 6>$null } catch { $threw = $true }
            Assert-True ((-not $threw) -and ($r -is [int]) -and $r -eq $code) "native verifier exit $code -> [int] $code, no throw"
        }
    }
    finally {
        $PSNativeCommandUseErrorActionPreference = $false
        Remove-Item Env:FAKE_VERIFIER_EXIT -ErrorAction SilentlyContinue
    }

    Write-Host "=== Child pwsh -File: exit (Invoke-PostApplyWorkerSettingsCheck ...) ==="
    $wrapper = Join-Path $work "post-apply-wrapper.ps1"
    Set-Content -LiteralPath $wrapper -Value @"
Set-StrictMode -Version Latest
`$ErrorActionPreference = 'Stop'
. '$($PSScriptRoot -replace "'", "''")/lib/WorkerSettingsVerification.ps1'
`$exitCode = Invoke-PostApplyWorkerSettingsCheck -RepoRoot '$($fakeRepo -replace "'", "''")' -Environment production
exit `$exitCode
"@
    foreach ($case in @(@{ Verifier = 0; Want = 0 }, @{ Verifier = 1; Want = 4 }, @{ Verifier = 2; Want = 5 })) {
        $env:FAKE_VERIFIER_EXIT = "$($case.Verifier)"
        & $pwshExe -NoProfile -File $wrapper *> $null
        Assert-True ($LASTEXITCODE -eq $case.Want) "child process exits $($case.Want) when the verifier exits $($case.Verifier) (got $LASTEXITCODE)"
    }
    Remove-Item Env:FAKE_VERIFIER_EXIT -ErrorAction SilentlyContinue

    Write-Host "=== Get-WorkerScriptUploadChanges (plan JSON) ==="
    $addr = "module.cloudflare_holding_page.cloudflare_workers_script.holding_page"
    function New-PlanJson {
        param([object[]]$Changes)
        return (@{ format_version = "1.2"; resource_changes = @($Changes) } | ConvertTo-Json -Depth 10)
    }
    function New-Rc {
        param([string]$Address, [string]$Type, [string]$Name, [string[]]$Actions, [string]$Mode = "managed")
        return @{ address = $Address; mode = $Mode; type = $Type; name = $Name; change = @{ actions = $Actions } }
    }
    $worker = { param([string[]]$a) New-Rc -Address $addr -Type "cloudflare_workers_script" -Name "holding_page" -Actions $a }
    $dns = New-Rc -Address "cloudflare_dns_record.api_custom_hostname" -Type "cloudflare_dns_record" -Name "api_custom_hostname" -Actions @("update")

    $fixtures = [ordered]@{
        "noop"          = @{ Json = (New-PlanJson @((& $worker @("no-op")), $dns)); Blocked = $false }
        "update"        = @{ Json = (New-PlanJson @((& $worker @("update")))); Blocked = $true }
        "replace"       = @{ Json = (New-PlanJson @((& $worker @("delete", "create")))); Blocked = $true }
        "create"        = @{ Json = (New-PlanJson @((& $worker @("create")))); Blocked = $true }
        "other-only"    = @{ Json = (New-PlanJson @($dns)); Blocked = $false }
        "data-source"   = @{ Json = (New-PlanJson @((New-Rc -Address "data.cloudflare_workers_script.holding_page" -Type "cloudflare_workers_script" -Name "holding_page" -Actions @("read") -Mode "data"))); Blocked = $false }
        "no-changes"    = @{ Json = '{"format_version":"1.2"}'; Blocked = $false }
    }
    foreach ($name in $fixtures.Keys) {
        $changes = Get-WorkerScriptUploadChanges -PlanJson $fixtures[$name].Json
        Assert-True (($changes.Count -gt 0) -eq $fixtures[$name].Blocked) "plan '$name' -> blocked=$($fixtures[$name].Blocked)"
    }
    $changes = Get-WorkerScriptUploadChanges -PlanJson $fixtures["replace"].Json
    Assert-True ($changes[0] -eq "$addr (delete, create)") "change text names the address and actions"
    $emptyThrew = $false
    try { Get-WorkerScriptUploadChanges -PlanJson "" | Out-Null } catch { $emptyThrew = $true }
    Assert-True $emptyThrew "empty plan JSON throws (cannot prove the Worker is untouched)"

    Write-Host "=== terraform-plan-guard-worker-script-upload.ps1 (child process, fixtures) ==="
    $guard = Join-Path $PSScriptRoot "terraform-plan-guard-worker-script-upload.ps1"
    function Invoke-Guard {
        param([string]$Json, [string[]]$Extra = @(), [string]$Follows = $null)
        $f = Join-Path $work ("plan-" + [guid]::NewGuid().ToString("N") + ".json")
        Set-Content -LiteralPath $f -Value $Json
        $env:FT_WRANGLER_DEPLOY_FOLLOWS = $Follows
        try {
            $out = & $pwshExe -NoProfile -File $guard -Environment production -PlanJsonFile $f @Extra 2>&1 | Out-String
            return @{ Exit = $LASTEXITCODE; Out = $out }
        }
        finally { $env:FT_WRANGLER_DEPLOY_FOLLOWS = $null }
    }
    $r = Invoke-Guard -Json $fixtures["noop"].Json
    Assert-True ($r.Exit -eq 0) "guard passes a no-op Worker plan"
    $r = Invoke-Guard -Json $fixtures["update"].Json
    Assert-True ($r.Exit -eq 1) "guard blocks an in-place Worker update outside the pipeline"
    Assert-True ($r.Out -match "BLOCKED" -and $r.Out -match "-Target" -and $r.Out -match "-AllowWorkerScriptUpload") "block message gives -Target guidance and the break-glass switch"
    $r = Invoke-Guard -Json $fixtures["replace"].Json
    Assert-True ($r.Exit -eq 1) "guard blocks a Worker replace"
    $r = Invoke-Guard -Json $fixtures["update"].Json -Follows "1"
    Assert-True ($r.Exit -eq 0) "guard allows the update when the deploy pipeline runs wrangler next (FT_WRANGLER_DEPLOY_FOLLOWS=1)"
    $r = Invoke-Guard -Json $fixtures["update"].Json -Extra @("-AllowWorkerScriptUpload")
    Assert-True ($r.Exit -eq 0 -and $r.Out -match "BREAK-GLASS") "break-glass -AllowWorkerScriptUpload allows it, loudly"
    $r = Invoke-Guard -Json "not json"
    Assert-True ($r.Exit -eq 1) "unparseable plan JSON is refused"
    Assert-True ($r.Out -notmatch "BLOCKED:") "an unchecked plan has no BLOCKED: verdict (CI reports it as a warning, not as expected drift)"
    $r = Invoke-Guard -Json $fixtures["update"].Json
    Assert-True ($r.Out -match "BLOCKED:") "a blocked Worker plan prints the BLOCKED: verdict the CI guard step keys on"

    Write-Host "=== terraform-run.ps1 -Operation apply end to end (fake terraform + node) ==="
    if ($IsWindows) {
        Write-Host "skip  (Windows: Initialize-WindowsCliPath would put the real terraform first on PATH)" -ForegroundColor Yellow
    }
    else {
        $fakeBin = Join-Path $work "bin"
        New-Item -ItemType Directory -Force -Path $fakeBin | Out-Null
        Set-Content -LiteralPath (Join-Path $fakeBin "terraform") -Value @'
#!/usr/bin/env bash
echo "terraform $*" >> "$FAKE_LOG"
case "$1" in
  plan) for a in "$@"; do case "$a" in -out=*) : > "${a#-out=}";; esac; done; echo "Plan: 0 to add, 1 to change, 0 to destroy."; exit 0;;
  show) cat "$FAKE_PLAN_JSON"; exit 0;;
  apply) echo "Apply complete! Resources: 0 added, 1 changed, 0 destroyed."; exit 0;;
  *) exit 1;;
esac
'@
        Set-Content -LiteralPath (Join-Path $fakeBin "node") -Value @'
#!/usr/bin/env bash
echo "node $*" >> "$FAKE_LOG"
echo "[verify-worker-placement] fake stdout line"
echo "[verify-worker-placement] FAIL fake stderr line" >&2
exit "${FAKE_NODE_EXIT:-0}"
'@
        & chmod +x (Join-Path $fakeBin "terraform") (Join-Path $fakeBin "node")
        $fakeEnv = [ordered]@{
            TF_TOKEN_app_terraform_io = "fake"; TF_VAR_auth0_domain = "fake"; TF_VAR_auth0_management_client_id = "fake"
            TF_VAR_auth0_management_client_secret = "fake"; TF_VAR_cloudflare_api_token = "fake"; TF_VAR_cloudflare_account_id = "fake"
            TF_VAR_cloudflare_zone_id = "fake"; TF_VAR_cloudflare_analytics_api_token = "fake"; TF_VAR_route_pattern = "fake"
            TF_VAR_auth0_api_identifier = "fake"
        }
        $saved = @{}
        foreach ($k in @($fakeEnv.Keys) + @("PATH", "FAKE_LOG", "FAKE_PLAN_JSON", "FAKE_NODE_EXIT")) { $saved[$k] = [Environment]::GetEnvironmentVariable($k, "Process") }
        try {
            foreach ($k in $fakeEnv.Keys) { [Environment]::SetEnvironmentVariable($k, $fakeEnv[$k], "Process") }
            $env:PATH = "$fakeBin$([IO.Path]::PathSeparator)$($env:PATH)"
            Assert-True ((Get-Command terraform -CommandType Application | Select-Object -First 1).Source -eq (Join-Path $fakeBin "terraform")) "fake terraform is first on PATH"
            $runScript = Join-Path $PSScriptRoot "terraform-run.ps1"
            function Invoke-TerraformRunApply {
                param([string]$PlanJson, [int]$NodeExit, [string[]]$Extra = @())
                $env:FAKE_LOG = Join-Path $work ("log-" + [guid]::NewGuid().ToString("N") + ".txt")
                $env:FAKE_PLAN_JSON = Join-Path $work ("plan-" + [guid]::NewGuid().ToString("N") + ".json")
                $env:FAKE_NODE_EXIT = "$NodeExit"
                Set-Content -LiteralPath $env:FAKE_PLAN_JSON -Value $PlanJson
                & $pwshExe -NoProfile -File $runScript -Environment staging -Operation apply -AutoApprove -SkipTursoPreflight @Extra *> $null
                $code = $LASTEXITCODE
                $log = if (Test-Path -LiteralPath $env:FAKE_LOG) { Get-Content -Raw -LiteralPath $env:FAKE_LOG } else { "" }
                return @{ Exit = $code; Log = $log }
            }
            $r = Invoke-TerraformRunApply -PlanJson $fixtures["noop"].Json -NodeExit 0
            Assert-True ($r.Exit -eq 0 -and $r.Log -match "terraform apply .*tfplan-autoapprove-" -and $r.Log -match "node .*verify-worker-placement") "-AutoApprove plans, guards, applies the saved plan, verifies -> exit 0"
            $r = Invoke-TerraformRunApply -PlanJson $fixtures["noop"].Json -NodeExit 1
            Assert-True ($r.Exit -eq 4) "verifier mismatch after a real apply -> terraform-run exits 4 (got $($r.Exit))"
            $r = Invoke-TerraformRunApply -PlanJson $fixtures["noop"].Json -NodeExit 2
            Assert-True ($r.Exit -eq 5) "verifier could-not-verify after a real apply -> terraform-run exits 5 (got $($r.Exit))"
            $r = Invoke-TerraformRunApply -PlanJson $fixtures["noop"].Json -NodeExit 2 -Extra @("-SkipWorkerSettingsVerification")
            Assert-True ($r.Exit -eq 0 -and $r.Log -notmatch "node ") "-SkipWorkerSettingsVerification skips the verifier -> 0"
            $r = Invoke-TerraformRunApply -PlanJson $fixtures["update"].Json -NodeExit 0
            Assert-True ($r.Exit -eq 1 -and $r.Log -notmatch "terraform apply") "-AutoApprove plan that updates the Worker is blocked before apply -> exit 1, no apply"
            $r = Invoke-TerraformRunApply -PlanJson $fixtures["update"].Json -NodeExit 0 -Extra @("-AllowWorkerScriptUpload")
            Assert-True ($r.Exit -eq 0 -and $r.Log -match "terraform apply") "-AllowWorkerScriptUpload (break-glass) applies and still verifies"
            $env:FT_WRANGLER_DEPLOY_FOLLOWS = "1"
            try {
                $r = Invoke-TerraformRunApply -PlanJson $fixtures["update"].Json -NodeExit 1
                Assert-True ($r.Exit -eq 0 -and $r.Log -match "terraform apply" -and $r.Log -notmatch "node ") "deploy pipeline (FT_WRANGLER_DEPLOY_FOLLOWS=1): apply allowed, check deferred to after wrangler deploy"
            }
            finally { $env:FT_WRANGLER_DEPLOY_FOLLOWS = $null }
            $leftover = @(Get-ChildItem -LiteralPath (Join-Path $repoRoot "infra/terraform/environments/staging") -Filter "tfplan-autoapprove-*" -ErrorAction SilentlyContinue)
            Assert-True ($leftover.Count -eq 0) "temporary auto-approve plan files are removed"
        }
        finally {
            foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k], "Process") }
        }
    }

    Write-Host "=== GitHub Actions: Worker script upload guard wiring (text-level, both Terraform workflows) ==="
    foreach ($wf in @(@{ File = "terraform-staging.yml"; Env = "staging" }, @{ File = "terraform-production.yml"; Env = "production" })) {
        $label = $wf.File
        $text = Get-Content -Raw -LiteralPath (Join-Path $repoRoot ".github/workflows/$($wf.File)")
        # Steps of jobs.terraform are list items indented six spaces; split the file into one block per step.
        $blocks = @([regex]::Split($text, '(?m)^(?=      - )') | Where-Object { $_ -match '^      - ' })
        $names = @($blocks | ForEach-Object { if ($_ -match '(?m)^      - name: (.+?)\s*$') { $Matches[1] } else { "" } })
        $iMode = [array]::IndexOf($names, "Resolve run mode")
        $iPlan = [array]::IndexOf($names, "Terraform Plan")
        $iGuard = [array]::IndexOf($names, "Guard Worker Script Upload Plan")
        $iApply = [array]::IndexOf($names, "Terraform Apply")
        $iDecide = [array]::IndexOf($names, "Decide worker / Turso mutate")
        Assert-True ($iMode -ge 0 -and $iPlan -gt $iMode) "${label}: 'Resolve run mode' runs before 'Terraform Plan'"
        Assert-True ($iGuard -ge 0 -and $iApply -eq $iGuard + 1) "${label}: guard step is immediately before 'Terraform Apply'"
        if ($iGuard -ge 0 -and $iApply -ge 0 -and $iMode -ge 0 -and $iDecide -ge 0) {
            $guard = $blocks[$iGuard]
            Assert-True ($guard -notmatch '(?m)^        if:') "${label}: guard has no 'if' (runs on every plan, report-only unless applying)"
            Assert-True ($guard -match "-Environment $($wf.Env) -PlanFile tfplan") "${label}: guard checks the $($wf.Env) plan file"
            Assert-True ($guard -match 'RUN_APPLY: \$\{\{ steps\.mode\.outputs\.apply \}\}') "${label}: guard reads apply from steps.mode"
            Assert-True ($guard -match 'guard_out=\$\(pwsh ' -and $guard -match "printf '%s\\n' `"\`$guard_out`"") "${label}: guard output is captured and echoed to the log"
            Assert-True ($guard -match "grep -q 'BLOCKED:'") "${label}: expected-drift wording is keyed on the BLOCKED: verdict"
            Assert-True ($guard -match '::warning title=Worker script upload guard could not check the plan::') "${label}: an unchecked plan on a plan-only run raises ::warning, not the expected-drift notice"
            $followsAll = [regex]::Matches($text, 'FT_WRANGLER_DEPLOY_FOLLOWS:').Count
            $followsEmpty = [regex]::Matches($text, 'FT_WRANGLER_DEPLOY_FOLLOWS: ""').Count
            Assert-True ($followsAll -eq 1 -and $followsEmpty -eq 1) "${label}: FT_WRANGLER_DEPLOY_FOLLOWS is only ever set, to empty, on the guard (CI apply never re-uploads the Worker)"
            Assert-True ($blocks[$iApply] -match "(?m)^        if: steps\.mode\.outputs\.apply == 'true'\s*$") "${label}: 'Terraform Apply' runs only when steps.mode.outputs.apply is true"
            Assert-True ($blocks[$iDecide] -match 'steps\.mode\.outputs\.deploy') "${label}: 'Decide worker / Turso mutate' reads steps.mode.outputs.deploy"
            $inputsAll = [regex]::Matches($text, 'github\.event\.inputs\.').Count
            $inputsMode = [regex]::Matches($blocks[$iMode], 'github\.event\.inputs\.').Count
            Assert-True ($inputsAll -eq 2 -and $inputsMode -eq 2) "${label}: dispatch inputs are read only in 'Resolve run mode' (got $inputsMode of $inputsAll)"
        }
    }
}
finally {
    $env:FT_WRANGLER_DEPLOY_FOLLOWS = $previousFollows
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "passed=$script:Passed failed=$script:Failed"
if ($script:Failed -gt 0) { exit 1 }
exit 0
