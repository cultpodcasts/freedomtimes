# CLI paths on Windows (operators and agents)

Cursor agents and non-interactive `pwsh` sessions often start with a **minimal PATH** — unlike an interactive terminal where WinGet, Scoop, or installer shims were added at login. Scripts in `scripts/` prepend known Windows locations automatically; this doc explains why and how to verify installs.

## Windows-native CLIs

These run directly from PowerShell on Windows. Repo scripts call `Initialize-WindowsCliPath` (from `scripts/ensure-windows-cli-path.ps1`) before invoking them.

| CLI | Typical install | Common path (when missing from PATH) |
|-----|-----------------|--------------------------------------|
| **Terraform** | `winget install Hashicorp.Terraform` | `%LOCALAPPDATA%\Microsoft\WinGet\Links\terraform.exe` |
| **Terraform** | Manual / MSI | `C:\Program Files\Terraform\` |
| **Terraform** | Scoop | `%USERPROFILE%\scoop\shims\` |
| **Node / npx** | Official installer or nvm-windows | Usually on PATH; use `where.exe node` |
| **Wrangler** | `npm i -g wrangler` or `npx wrangler` | Via Node; repo scripts prefer `npx wrangler` from `web/` |
| **GitHub CLI (`gh`)** | `winget install GitHub.cli` | WinGet Links or `%ProgramFiles%\GitHub CLI\` |

### Verify Terraform (Windows)

```powershell
where.exe terraform
terraform -version
```

Expected WinGet shim example:

```text
C:\Users\<you>\AppData\Local\Microsoft\WinGet\Links\terraform.exe
```

If `where.exe` finds nothing but the file exists under WinGet Links, run any terraform script (`scripts/terraform-run.ps1`) — it prepends WinGet Links before calling `terraform`. For manual use in a bare shell:

```powershell
$env:Path = "$env:LOCALAPPDATA\Microsoft\WinGet\Links;$env:Path"
terraform -version
```

### Repo automation

- **`scripts/terraform-run.ps1`** — loads `ensure-windows-cli-path.ps1` at startup.
- **`scripts/sync-staging-turso-env-dev.ps1`**, **`scripts/sync-production-turso-env-dev.ps1`** — use `Resolve-TerraformExecutable`.
- **`scripts/deploy-staging-local.ps1`**, **`scripts/deploy-production-local.ps1`** — local deploy entry points; see [web/docs/DEPLOY.md](../web/docs/DEPLOY.md) (canonical deploy reference). Shared helpers: `Deploy-EnvironmentCommon.ps1` (dot-sourced only).

Preflight and apply:

```powershell
pwsh scripts/terraform-run.ps1 -Environment staging -Operation validate -LoadEnvFiles
pwsh scripts/terraform-run.ps1 -Environment staging -Operation plan -LoadEnvFiles
```

---

## Turso CLI (WSL only)

**Turso is not a Windows-native CLI in this workspace.** It is installed and authenticated inside **WSL** (Ubuntu). Do not expect `where.exe turso` or `Get-Command turso` to succeed from PowerShell.

| Item | Value |
|------|--------|
| **Binary** | `~/.turso/turso` (e.g. `/home/<user>/.turso/turso`) |
| **Install (WSL)** | `curl -sSfL https://get.tur.so/install.sh \| bash` |
| **Auth (once)** | `wsl bash -lic "turso auth login"` or interactive WSL terminal |

Bare `wsl bash -lc "turso …"` often fails with **command not found** because `~/.turso` is only on `PATH` in a WSL **login** shell. Use one of these patterns from **PowerShell** at the repo root:

```powershell
# Login shell — picks up ~/.profile PATH
wsl bash -lic "turso db list"

# Non-login shell — prepend ~/.turso (same as scripts/turso-create-rollback-branch-wsl.sh)
wsl bash -lc 'export PATH="$HOME/.turso:$PATH"; turso db list'

# Direct binary (same as scripts/turso-create-rollback-branch.ps1 -UseWslTurso)
wsl bash -lc '$HOME/.turso/turso db list'
```

### Verify Turso (WSL)

```powershell
wsl bash -lc 'command -v turso || test -x "$HOME/.turso/turso" && echo "$HOME/.turso/turso"'
wsl bash -lic "turso db list"
```

Inside WSL:

```bash
which turso
turso db list
```

### Repo scripts and runbooks

| Script / doc | Role |
|--------------|------|
| **`scripts/turso-create-rollback-branch.ps1`** | WSL by default (`$HOME/.turso/turso` via `wsl bash -lc`); pass `-UseNativeTurso` only if `turso` is on Windows PATH |
| **`scripts/deploy-production-local.ps1`** | Full deploy invokes rollback checkpoint before Terraform (unless `-SkipTursoBackup`, `-WorkerOnly`, or `-DryRun`) |
| **`scripts/turso-create-rollback-branch-wsl.sh`** | Run from WSL; prepends `~/.turso` to `PATH` |
| **`web/CONTENT_PROMOTION_RUNBOOK.md`** | Turso backups, export commands, rollback branches |
| **`AGENTS.md`** | Points agents to WSL Turso for database backups |

Terraform talks to Turso through the **Turso provider** and **Platform API tokens** (`TF_VAR_turso_api_token`, `TURSO_TOKEN_STAGING`, etc.) — that does **not** require the Turso CLI on Windows. The CLI is needed for **`turso db export`**, rollback branches, and ad hoc operator commands.

---

## Quick reference

| Need | Where it runs | Verify |
|------|---------------|--------|
| `terraform plan/apply` | Windows | `where.exe terraform` |
| `turso db export` / `turso db list` | WSL | `wsl bash -lic "turso db list"` |
| Turso tokens in `.env.dev` | Windows (HTTP + Terraform outputs) | `pwsh scripts/sync-staging-turso-env-dev.ps1` |

See also: [LOCAL_DEV_REQUIREMENTS.md](../LOCAL_DEV_REQUIREMENTS.md), [web/docs/DEPLOY.md](../web/docs/DEPLOY.md), [infra/terraform/README.md](../infra/terraform/README.md).
