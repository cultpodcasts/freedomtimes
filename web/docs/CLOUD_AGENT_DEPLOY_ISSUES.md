# Cloud Agent deploy issues (this environment)

Log of pitfalls seen on **Cursor Cloud Linux VMs** while running `deploy-staging-local.ps1` / `deploy-production-local.ps1`. Agents: do **not** work around by writing production Turso into `.env.dev`. Prefer the scripted path; if it still fails, **STOP** (Primary guardrails §6–§7).

Canonical commands: **[DEPLOY.md](DEPLOY.md)**. Agent contingencies: **`AGENTS.md`** § Local deploy → Cloud Agents.

**Sources:** staging full deploys 2026-09-01 (`/tmp/staging-full-deploy.log`, `/tmp/staging-full-deploy-2.log`), PowerShell/Cloudflare/docs review of `4979d16`/`de0f97a`, production **preflight** 2026-09-01 (full production apply was not started after this catalog).

Status: **scripted** = `deploy-*-local.ps1` handles it; **doc** = agents must know; **noise** = ignore unless asked.

| ID | Where seen | Symptom | Cause | Scripted path | If it still fails |
|----|------------|---------|-------|---------------|-------------------|
| CA-01 | Staging + prod preflight | Process `TURSO_DATABASE_URL` is production EmDash; `.env.dev` is staging | Cursor Cloud injects production EmDash as process `TURSO_*` | `Select-StagingEmdashTursoUrl` skips process URL (hint match **or** `*-emdash-production-*`) and sets `IgnoredProcessProductionShadow` even when Terraform URL wins so process JWT is not used | Do **not** copy the process pair into `.env.dev`. Mint a staging JWT in `.env.dev` if resolve throws |
| CA-02 | Review (would hit prod-shaped migrate) | Terraform staging URL + empty `turso_database_auth_token` + process production JWT | Early return dropped the shadow flag | `IgnoredProcessProductionShadow` is set before the Terraform short-circuit (`de0f97a`) | STOP; do not pair process JWT with staging URL |
| CA-03 | Staging | Terraform Cloud auth missing on Linux | Cursor secret `TF_TOKEN_APP_TERRAFORM_IO` vs CLI `TF_TOKEN_app_terraform_io` | `terraform-preflight.ps1` copies the Cursor name (does **not** remap `TF_TOKEN` / `TFE_TOKEN`) | Copy that secret into `TF_TOKEN_app_terraform_io` in process env (never print it) |
| CA-04 | Staging (Wrangler class) | Wrangler `6111` / `9106` after Terraform | Process `CLOUDFLARE_API_TOKEN` is a short Cursor stub | Replace stubs `<40` chars with `TF_VAR_CLOUDFLARE_API_TOKEN`; **throw** if still implausible | Overwrite process `CLOUDFLARE_API_TOKEN` from `TF_VAR_*` (never print it) |
| CA-05 | Staging | `EBADENGINE` / `npm` on Node 22.14 | `/exec-daemon/node` stays first on `PATH` after `nvm use` | `Initialize-LinuxNvmNodePath` prepends nvm **v22.22.2**; **throws** if missing while `/exec-daemon` is on `PATH` | `nvm install 22.22.2` and re-run deploy — do not rely on `nvm use` |
| CA-06 | Staging | `Required plugins are not installed` / lockfile checksum mismatch | Fresh VM has no `.terraform`, or Linux `init` adds extra platform hashes | Auto-init when `.terraform` missing; retry apply **once**; also retry if `.terraform/providers` is missing; **leave lockfile dirty through apply**; revert hash-only after success if it started clean | Manual `terraform-run.ps1 -Operation init`. Do **not** `git checkout` the lockfile before apply. Never commit Linux extra hashes unless asked |
| CA-07 | Staging | No `.terraform` for the environment | Snapshot VM / first apply | Full `deploy-*-local.ps1` inits first | `pwsh ./scripts/terraform-run.ps1 -Environment staging -Operation init -LoadEnvFiles` (or `production`) then full deploy |
| CA-08 | Staging / production migrate | `EMDASH_TARGET_FINGERPRINT` unset | GitHub Action pins are not Cursor secrets here | **Staging** (non-prod URL): `emdash-core-migrate.mjs` uses same-run `--status --json` with pin unset. **Production-looking URLs** require a pin — local `deploy-production-local.ps1` pins process `EMDASH_TARGET_FINGERPRINT` from `print-fingerprint` (not `.env.dev`, not a Cursor secret) | If apply still refuses, run `node web/scripts/emdash-core-migrate.mjs print-fingerprint` after build against the **intended** host and export `EMDASH_TARGET_FINGERPRINT` |
| CA-09 | GitHub PR | `Apply to Staging` / Android / iOS fail in ~3s with empty steps | Workflow dispatch / Capacitor jobs are not this VM deploy | Ignore | Do not treat as local `deploy-*-local.ps1` failing |
| CA-10 | Staging probe | `/` takes 1–3s with `Server-Timing` | Cold isolate | Success | Hang is **0-byte pending** with no timing headers |
| CA-11 | Staging build | `punycode` deprecation / `patch-cloudflare-bundle` patched 0 | Node / wrangler noise | Ignore | Noise |
| CA-12 | Staging Terraform | Apply `0 added, 1 changed, 0 destroyed` on holding-page Worker | `last_deployed_from = wrangler` | Expected | Not a required delta next time |
| CA-13 | Staging Auth0 | `staging-reader` exists but user cannot read | Deploy does not assign Auth0 users | Terraform may create the role (`create_staging_reader_role = true`) | Operator assigns the role in Auth0. Do not invite those users as EmDash CMS users |
| CA-14 | Prod preflight | Process `TURSO_DATABASE_URL` **equals** `TURSO_PRODUCTION_EMDASH_DB_URL` (both production); `.env.dev` `TURSO_DATABASE_URL` is staging | Same injection as CA-01; **correct for production resolve** | Production `Set-TursoBuildEnv` uses `TURSO_PRODUCTION_EMDASH_DB_TOKEN` / paired process JWT. **Never** write that pair into `.env.dev` as `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` | If `TURSO_PRODUCTION_EMDASH_DB_TOKEN` is unset, copy process `TURSO_AUTH_TOKEN` into **that name only** (process env), not into `.env.dev` |
| CA-15 | Prod preflight | `EMDASH_TARGET_FINGERPRINT` / `EMDASH_TARGET_FINGERPRINT_PRODUCTION` unset as Cursor secrets | CI pins are GitHub secrets; this VM has not had them | After `npm run build`, deploy pins process `EMDASH_TARGET_FINGERPRINT` from `print-fingerprint` (same-run `--status --json`) | Do not invent those names as Cursor secrets. CI still maps `EMDASH_TARGET_FINGERPRINT_PRODUCTION` → `EMDASH_TARGET_FINGERPRINT` |
| CA-16 | Prod preflight | `.release/rollback-branches/*.json` `LastWriteTimeUtc` is 1970-01-01; `createdAtUtc` is months old | Snapshot checkout mtimes; metadata is **not** a fresh checkpoint | `-SkipTursoBackup` uses JSON `createdAtUtc` when present, and **ignores** Unix-epoch file mtimes. Checked-in April 2026 files are not `<24h` | Omit `-SkipTursoBackup` so `turso-create-rollback-branch.ps1` runs. Do not treat 1970 mtimes as fresh |
| CA-17 | Prod preflight | No `infra/terraform/environments/production/.terraform` | First production apply on this VM | Same as CA-06/CA-07 for **production** | Same init/retry; do not revert lockfile before apply |
| CA-18 | Staging logs | Agents **unset** process `TURSO_*` by hand before staging deploy | Old workaround | Scripts skip the process pair; do **not** unset by hand | Only if resolve still selected production |
| CA-19 | Docs vs scripts (fixed) | Agents abort because process hosts match | Old “compare hosts and refuse” wording | Run the deploy script; STOP only if resolve **throws** | — |
| CA-20 | Linux vs Windows | `wsl bash -lic "turso …"` / `where.exe terraform` on this VM | Windows playbooks | Native `turso` (`$HOME/.turso/turso`) and `terraform` on PATH. Deploy `turso config set token` from `TURSO_PLATFORM_API_TOKEN` | Interactive `turso auth login` only if platform token missing and whoami fails. Never use `TURSO_AUTH_TOKEN` for CLI login |
| CA-21 | Terraform token | Minted `turso_database_auth_token` 404 | Provider output | Staging: Terraform URL + `.env.dev` token when output empty. Production: prefer `TURSO_PRODUCTION_EMDASH_DB_TOKEN` | Mint JWT with `turso db tokens create` after platform CLI login |
| CA-22 | Child `pwsh` | TF remap / nvm PATH | Child inherits `PATH`; TF remap runs **inside** `terraform-run.ps1` → preflight, not in the parent | Do not skip `-LoadEnvFiles` / preflight | Direct `terraform` without `terraform-run.ps1` misses the remap |
| CA-23 | Production 2026-09-01 | Apply succeeded (`0 added, 1 changed` holding page), then `terraform output` / Auth0 sync crashed: `You cannot call a method on a null-valued expression` + plugin checksum errors | `Restore-DeployTerraformLockfileIfCleanStart` ran **immediately after apply**, then `terraform output -raw` could not load providers. `.Trim()` on `$null` | Restore lockfile only **after** the last `terraform output` (Auth0 sync, worker name, secret helpers). `Get-DeployTerraformOutputRaw` no longer `.Trim()`s a null. Leave lockfile dirty through apply **and** output | If this still fires, do not re-apply blindly. Finish with `-WorkerOnly -AllowProduction` after fixing scripts. Do not commit Linux lockfile hashes |
| CA-24 | Same abort | Operator said hold before wrangler | Full production apply had started | Stopped before Worker build/migrate/wrangler. Turso rollback `prod-rollback-20260901-182545` exists. Live `/submit-a-tip` still shows pre-#90 SHA until wrangler | Next production deploy from the follow-up branch; omit `-SkipTursoBackup` unless that checkpoint is still <24h |

## Production local deploy (operator must ask)

Full stack: `pwsh ./scripts/deploy-production-local.ps1` (no `-WorkerOnly`, no `-SkipTursoBackup` unless CA-16 skip check passes). That **does** Terraform init/apply, Turso rollback branch, secret sync, pin fingerprint, migrate, wrangler `--env production`.

If Terraform **succeeds** and a later step fails: do **not** re-apply blindly. Finish with:

`pwsh ./scripts/deploy-production-local.ps1 -WorkerOnly -AllowProduction -SyncCloudflareWorkerSecrets`

(omit `-SkipTursoBackup` unless a checkpoint newer than 24h matches). If Terraform itself failed: **STOP** before wrangler.

Probe production apex `/` (200 newsroom, not Secure Access) and `/homepage` (301 → `/` on the same host). Do not require `www`. Staging probes stay the locked wall.

Deploy scripts do **not** `content_publish`.
