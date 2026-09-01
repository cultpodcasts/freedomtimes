# Agent and operator notes

## Primary guardrails (AI agents)

These apply to **every** Cursor agent session. When a guardrail blocks progress, **STOP and wait** for the operator — do not work around unless they **explicitly** override in that same chat.

1. **EmDash MCP — IF MCP FAILS WE DO NOT FALL BACK TO SHELL.** When Cursor EmDash MCP (`freedomtimes-staging` / `freedomtimes-production`, or equivalent servers under **Tools & MCP**) is **unavailable**, **errored**, **auth invalid**, or **`call_mcp_tool` is not registered**: **STOP immediately.** Tell the operator: *"EmDash MCP is not available in this session. Enable the EmDash MCP servers under Tools & MCP, restart Cursor if needed, refresh tokens (`emdash login` / PAT), and check Output → MCP Logs. Tell me when ready."* Then **wait**. **Never** fall back to `node web/scripts/emdash-mcp-tools-call.mjs`, `npx emdash content …`, `npx emdash schema …`, REST curl, or other shell/CLI workarounds. **Operators** may run shell helpers manually; **AI agents may not.**

2. **Database backup before any mutate.** Before Turso/libSQL writes, SQL migrations, seeds, or EmDash content writes (`content_update`, `content_publish`, etc.), create a **recoverable backup** of the target database first. See **`web/CONTENT_PROMOTION_RUNBOOK.md`** and **`docs/CLI_PATHS_WINDOWS.md`**.

3. **EmDash MCP-only for schema and content JSON.** Do **not** use `npx emdash schema …` / `npx emdash content …` to inspect or edit stored **`posts` / `pages` `content`** (Portable Text). Use Cursor MCP (`content_get`, `content_update`, …). CLI exceptions: `emdash login`, `emdash media upload` (binary / official OG cards — see §8), `emdash doctor` — auth/upload/diagnostics only. **When writing body content via MCP:** send a **Portable Text array**, never a raw markdown string (see § *EmDash: MCP only* below; sibling **freedomtimes-agents** [AGENTS.md](../freedomtimes-agents/AGENTS.md) §3).

4. **Staging locked — nothing is public.** Never expose anonymous reader or editorial routes on staging. Full policy: **`web/docs/STAGING_ACCESS.md`**.

5. **No production publish without explicit ask — but production edits must go live.** Never run production `content_publish`, `promote-post-staging-to-production.mjs`, or equivalent unless the operator **explicitly asks in that chat**. Asking to **change / fix / update** a production post **is** that ask: after backup + `content_update`, also run **`content_publish`** on the same slug so the live post updates — do **not** stop at a draft revision unless they say draft-only. Warn that publish may notify subscribers; still publish when they asked for a production change. After promote/publish is live, **request Google indexing** for the public URL (GSC MCP `submit_url` / `submit_batch`) — see **`web/CONTENT_PROMOTION_RUNBOOK.md`** §7.

6. **CLI authentication — IF NOT AUTHENTICATED YOU MUST STOP.** When any required CLI reports an auth failure (not logged in, invalid token, permission denied): **STOP immediately.** Name the CLI, give the exact auth command for that tool, tell the operator to authenticate and confirm when ready, then **wait**. **Never** silently fall back to alternate APIs, unauthenticated endpoints, or skip the step unless the operator **explicitly** approves an alternate path in that same session. Applies to **wrangler**, **gh**, **turso**, **emdash login**, **terraform** / provider tokens, **cloudflare**, etc.

7. **Turso CLI — IF TURSO AUTH FAILS WE DO NOT BYPASS.** **Windows:** `wsl bash -lic "turso auth whoami"` (Turso lives in WSL); interactive `turso auth login` when no Platform API token is in env. **Linux** (cloud VMs, no `wsl`): native `turso` on PATH or `$HOME/.turso/turso`. Local deploy / CI set the CLI token from `TURSO_PLATFORM_API_TOKEN` (else `TURSO_API_TOKEN` / `TF_VAR_turso_api_token` / non-JWT `TURSO_TOKEN`) via `turso config set token`, then `turso auth whoami`. **Never** use `TURSO_AUTH_TOKEN` or other database JWTs for CLI auth. Still run `turso db export` / rollback after auth — do not skip backup. If those keys are missing and whoami fails: **STOP immediately.** Tell the operator: *"Turso CLI is not authenticated. Run `wsl bash -lic \"turso auth login\"` (Windows) or `turso auth login` (Linux), or set `TURSO_PLATFORM_API_TOKEN`, then tell me when ready."* Then **wait**. See **`docs/CLI_PATHS_WINDOWS.md`**.

8. **Large media — never MCP `media_upload` base64.** Official OG/social PNGs (typically 200–600KB) **truncate, time out, or become 1×1 placeholders** when sent as MCP `base64`. Ignore the `media_upload` tool’s `base64` hint for those files. Put bytes with **`emdash media upload`** (already a CLI exception for binary — this is the correct path for OG cards) or **`POST /_emdash/api/media`** multipart (or Admin/raw R2 put; then MCP **`media_create`** if there is no library row, else **`media_update`**). Then MCP **`content_update`** with **`seo.image`** set to the same-origin file path **`/_emdash/api/media/file/<storageKey>`** (same as `seoImageFieldValueFromNormalizedRow` in `web/scripts/generate-social-images.ts`). A **bare media id** validates but leaves the admin OG Image widget empty; do **not** store a raw `storageKey` without the prefix. Do **not** JPEG-crush or replace official `generate-social-images.ts` / `draft:push-staging` cards. Procedure: **[docs/CURSOR_EMDASH_MCP.md § Large media uploads](docs/CURSOR_EMDASH_MCP.md#large-media-uploads-avoid-mcp-base64-truncation)**. Schema and content JSON remain MCP-only (guardrail §3).

9. **GitHub PRs — CultPodcasts, not the Cursor App.** New cloud agents authenticate as the `cursor` GitHub App: they can **push** `cursor/*` branches but **cannot** create issues/PRs (`must be a collaborator`, `Resource not accessible by integration`). Repo admin is **`cultpodcasts`** (CultPodcastsBot); that is who opens PRs. **Do not stop** at a compare URL.

   **Prefer the Cursor environment secret `CULTPODCASTS_GH_TOKEN`** (exact name; CultPodcasts PAT with `repo`, `read:org`, `workflow`). **90-day expiry** — the token stored 2026-08-31 lapses ~2026-11-29; rotate the GitHub PAT and update this secret before then. The secret is injected on every cloud agent; **do not assume `gh` is already `cultpodcasts` at boot** (environment `start` is detached and git token-refresh can leave the Cursor App account active). Always: `printf '%s\n' "$CULTPODCASTS_GH_TOKEN" | gh auth login --hostname github.com --with-token --insecure-storage` then `gh auth switch --user cultpodcasts`. **Never** name or export this as `GH_TOKEN` / `GITHUB_TOKEN` (that replaces the App token used for `git push`). If the secret is missing or `gh auth` fails: device-login as **CultPodcasts** (https://github.com/login/device + one-time code), then switch and `gh pr create`. Full steps: **[docs/CLOUD_AGENT_GITHUB_PR.md](docs/CLOUD_AGENT_GITHUB_PR.md)**.

## CLI paths (Windows vs WSL)

**Primary reference:** **[docs/CLI_PATHS_WINDOWS.md](docs/CLI_PATHS_WINDOWS.md)** — Windows-native Terraform vs WSL Turso (Windows) / native Turso (Linux), PATH verification, and repo script patterns.

- Quick check: `where.exe terraform` (Windows). Turso: `wsl bash -lic "turso auth whoami"` then `turso db list` in WSL; on Linux `turso auth whoami` / `$HOME/.turso/turso`.
- Do not run parallel Terraform operations on the same environment (staging/production/auth0-shared); `scripts/terraform-run.ps1` enforces a per-environment file lock.
- Auth failures: **Primary guardrails §6–§7** — STOP; do not bypass.
- Turso backups and rollback branches: **[web/CONTENT_PROMOTION_RUNBOOK.md](web/CONTENT_PROMOTION_RUNBOOK.md)** (Turso backups section).

## EmDash: MCP only for schema and content (hard rule)

**Do not use the EmDash CLI** (`npx emdash schema …`, `npx emdash content …`) **to inspect collection schema or to read/edit/publish content** when you care about the **real stored JSON** (especially **`posts` / `pages` `content`** as Portable Text). The CLI’s JSON output **does not reliably expose** the underlying document shape and has misled debugging repeatedly.

**If MCP can write Portable Text, always do so.** For `content_create` / `content_update`, `data.content` must be a **Portable Text JSON array** — **never** a markdown string. EmDash’s built-in MD→PT leaves reader-visible artefacts (literal `*emphasis*`, image text in `alt` only). Agent drafts convert with sibling **freedomtimes-agents** `scripts/markdown-to-portable-text.mts` / `draft:push-staging` (see that repo’s [AGENTS.md](../freedomtimes-agents/AGENTS.md) §3).

**AI agents — Cursor MCP only:** Use **Cursor** EmDash MCP servers (`freedomtimes-staging`, `freedomtimes-production`) when they appear under **Tools & MCP**. Setup/repair on Windows: **`docs/CURSOR_EMDASH_MCP.md`**; operator skill **`~/.cursor/skills/freedomtimes-emdash-mcp/SKILL.md`**. Call **`content_get`**, **`content_update`**, **`content_publish`**, **`content_create`**, **`schema_list_collections`**, **`schema_get_collection`**, etc. via **`call_mcp_tool`** — not via shell. **If MCP fails, see Primary guardrails §1 — STOP; do not use shell.**

**Operators (humans) — shell MCP helper (optional):** From a terminal, `node web/scripts/emdash-mcp-tools-call.mjs [--url <origin>] <toolName> '<json-args>'` hits the same `POST /_emdash/api/mcp` + JSON-RPC `tools/call` as the IDE. Token: `~/.config/emdash/auth.json` or `EMDASH_STAGING_TOKEN` / `EMDASH_PRODUCTION_TOKEN` / `EMDASH_MCP_TOKEN`. Operators may choose this when Cursor MCP is awkward; **AI agents must not** — see **Primary guardrails §1**.

**Examples:** `content_get` → `{"collection":"posts","id":"<slug>"}`; **`schema_list_collections`** → `{}`; **`schema_get_collection`** → `{"slug":"posts"}` (there is no `schema_get` tool).

Repo scripts **`promote-post-staging-to-production.mjs`** and **`merge-staging-post-from-patch.mjs`** apply this rule: staging reads and production writes use **MCP** (or REST only where noted for `_rev` resolution), not `emdash content` / `emdash schema`.

**CLI exceptions (outside schema + content JSON):** e.g. **`emdash login`**, **`emdash media upload`** (binary / official OG cards — never MCP `media_upload` base64; see **Primary guardrails** §8), **`emdash doctor`** — only when the task is explicitly about auth, binary upload, or local diagnostics, not about inspecting or editing entry JSON.

**Cursor `call_mcp_tool` vs this repo:** Some agent sessions only register built-in MCP servers (e.g. `cursor-ide-browser`) and do **not** see Freedom Times EmDash servers. That is a **Primary guardrails §1 blocker** — enable servers under **Ctrl+Shift+J → Tools & MCP**, restart Cursor, check **Output → MCP Logs**, then **wait** for the operator.

Details: **`web/docs/PLAN_EMDASH_CONTENT_FORMAT_AND_MCP_HANDOFF.md`** (section **CLI vs MCP**) and **`web/docs/PR_CHECKLIST_EMDASH_CONTENT.md`** (§**2.0a**). For **English-ledes, French outlet glosses, hoisting stakes, and the canonical French `blockquote` + English translation `<details>` PT block order**, see **`web/docs/EDITORIAL_ENGLISH_GLOSSES.md`**.

## Databases: backup before any change

See **Primary guardrails §2**. Before **any** mutating operation on a database or CMS-backed store (Turso / libSQL, SQL migrations, seeds, EmDash content writes, MCP updates), create a **recoverable backup** of the **target** database first. Do not skip this for small edits.

Concrete steps and examples (Turso `db export`, rollback branches, scheduler/subscriptions — Turso CLI in **WSL on Windows**, **native on Linux**): see **`web/CONTENT_PROMOTION_RUNBOOK.md`** section *Turso backups before any mutating work*; invoke patterns in **`docs/CLI_PATHS_WINDOWS.md`**.

## Staging access: NOTHING IS PUBLIC (hard rule for AI agents)

See **Primary guardrails §4**. Staging (`SITE_ACCESS_MODE=locked`, `staging.freedomtimes.news`) must **never** expose anonymous reader or editorial routes. The only paths that bypass the outer Auth0 wall are EmDash internal auth (`/_emdash/*`, `/.well-known/*`) plus `/auth/*` and the `/` login wall.

- **Do not** add routes to `AUTH_BYPASS_RULES` in `web/src/middleware.ts` except EmDash/OAuth metadata.
- **Do not** add staging-only public exceptions.
- Production-public reader routes belong in `PUBLIC_READER_PATHS` (`web/src/lib/auth.ts`) and **must** call `authorizeReaderApiRequest` (API) or `requireReaderPageSession` (page) from `web/src/lib/editorial-session.ts`.
- To test reader flows on staging: sign in first (`admin`, `editor`, or `staging-reader`), then open the route. `staging-reader` is content pages only — not `/admin` and not EmDash CMS.

Full policy: **`web/docs/STAGING_ACCESS.md`**.

## Local deploy (AI agents)

**Canonical reference:** **[web/docs/DEPLOY.md](web/docs/DEPLOY.md)** — script decision table, flags, step order, prerequisites, and failure troubleshooting. Read the [For AI agents](web/docs/DEPLOY.md#for-ai-agents) section before running any deploy command.

**Entry points only** (from repo root):

| Script | Purpose |
|--------|---------|
| `scripts/deploy-staging-local.ps1` | Staging deploy (full, `-WorkerOnly`, or `-WorkersOnly`) |
| `scripts/deploy-production-local.ps1` | Local production deploy (full or `-WorkerOnly -AllowProduction`) |
| `scripts/production-release.ps1` | CI release — dispatches GitHub Actions; not a local wrangler deploy |

**Do not invoke:** `Deploy-EnvironmentCommon.ps1` (helpers only); deprecated `*-rebuild-local.ps1` (use `deploy-*-local.ps1`).

**Hard rules for agents:**

- Do **not** run production deploy (`deploy-production-local.ps1`, `production-release.ps1`) unless the operator **explicitly asks in this chat**.
- Full `deploy-production-local.ps1` and `-WorkerOnly` create a Turso rollback checkpoint **before** `emdash migrate` — requires authenticated Turso CLI (**Primary guardrails §7**; WSL on Windows, native on Linux). Staging `turso db export` uses `TF_VAR_TURSO_DATABASE_NAME_STAGING` when set; otherwise the Terraform staging `turso_database_name` default (do not require that env key as a Cursor secret). **Turso hosts:** process `TURSO_DATABASE_URL` on this Cloud env is often **production** EmDash and equals `TURSO_PRODUCTION_EMDASH_DB_URL`. Do not abort because process hosts match. `Select-StagingEmdashTursoUrl` skips a production process URL (hint match or `*-emdash-production-*`) and still sets `IgnoredProcessProductionShadow` when Terraform URL wins, so process JWT is not used. **Never** copy the process production pair into `.env.dev`. Resolve **throws** if the selected `.env.dev` or Terraform URL is production. Staging Turso is database name `freedomtimes-emdash-staging`. Do not pass `-SkipTursoBackup` unless a checkpoint newer than 24h already exists. <!-- pragma: allowlist secret -->
- Deploy scripts ship Workers and infra; they do **not** publish EmDash content (**Primary guardrails §5** for `content_publish`).
- On deploy failure, use the canonical doc's [Quick symptom index](web/docs/DEPLOY.md#quick-symptom-index) — do not improvise alternate script names.

Context-specific runbooks (link to canonical doc for script details): [PRODUCTION_RELEASE_RUNBOOK.md](PRODUCTION_RELEASE_RUNBOOK.md) (CI + promotion), [STAGING_RECOVERY.md](STAGING_RECOVERY.md) (recovery checklist).

### Cloud Agents (Linux VM — staging and production)

When the operator asks for a **full staging or production stack** (Terraform + workers), run the **full** script. Do **not** default to `-WorkerOnly` / `-WorkersOnly`. Canonical step order stays in **[web/docs/DEPLOY.md](web/docs/DEPLOY.md)** — do not duplicate it here. This subsection is Cloud VM pitfalls. Full issue log: **[web/docs/CLOUD_AGENT_DEPLOY_ISSUES.md](web/docs/CLOUD_AGENT_DEPLOY_ISSUES.md)** (CA-01…). Scripts now handle most of them; do not work around by writing production Turso into `.env.dev`.

**Hard rules**

- Staging only unless the operator asked for production in the same chat.
- No new PR for a deploy; stay on the branch under test.
- Deploy scripts do not publish EmDash content (**Primary guardrails §5**).
- If a required Cursor secret is missing, **STOP** and list **names** only. Do not fall back to Jon's Windows `.env.dev`. Do not copy `.env.dev` from MSI.

**Secrets / env (names only; never print values)**

- Use **Cursor environment/repo secrets**, not Jon's Windows `.env.dev`.
- Terraform Cloud: Cursor secret name is `TF_TOKEN_APP_TERRAFORM_IO`. `scripts/terraform-preflight.ps1` copies process `TF_TOKEN_APP_TERRAFORM_IO` to `TF_TOKEN_app_terraform_io` if that name is empty, else loads `~/.terraform.d/credentials.tfrc.json`. It does not remap `TF_TOKEN` or `TFE_TOKEN`. Do not copy it by hand unless preflight still reports a missing token. Never print the value.
- Do not copy Cloudflare tokens by hand. Deploy remaps a missing or short (`<40`) `CLOUDFLARE_API_TOKEN` from `TF_VAR_CLOUDFLARE_API_TOKEN` and fills `CLOUDFLARE_ACCOUNT_ID` from `TF_VAR_CLOUDFLARE_ACCOUNT_ID`. It **throws** if Wrangler still has no plausible token. Never print token values.
- **Turso hosts (staging):** process `TURSO_DATABASE_URL` on this Cloud env is often **production** EmDash. Do **not** abort because process hosts match, and do **not** unset process `TURSO_*` by hand. `Select-StagingEmdashTursoUrl` treats a process URL as a production shadow when it matches `TURSO_PRODUCTION_EMDASH_DB_URL` **or** looks like `*-emdash-production-*`. It still uses Terraform / `.env.dev` staging, and sets `IgnoredProcessProductionShadow` even when Terraform URL wins so process JWT is not paired with staging. **Never** copy the process production pair into `.env.dev`. Resolve **throws** if the selected Terraform or `.env.dev` URL is itself production. After apply, Terraform-minted `turso_database_auth_token` has **404'd** — then use `.env.dev` staging `TURSO_AUTH_TOKEN`. Mint a staging token with `turso db show` / `turso db tokens create` against `freedomtimes-emdash-staging` after `turso config set token` from `TURSO_PLATFORM_API_TOKEN` (never `TURSO_AUTH_TOKEN` for CLI login). <!-- pragma: allowlist secret -->
- Do **not** require `EMDASH_TARGET_FINGERPRINT_*` as Cursor secrets for this **local** script path (those pins are GitHub Actions; this Cloud env has not had them). Local staging `web/scripts/emdash-core-migrate.mjs` uses the same-run `emdash migrate --status` fingerprint when the env pin is unset. Do not invent those secret names. Production-looking Turso hosts still require a pin.

**Linux Cloud VM bootstrap (this image)**

- Default `node` can be 22.14; need **22.22.2** (`registerHooks`) via nvm. **`/exec-daemon/node` shadows nvm**. `Initialize-LinuxNvmNodePath` prepends `$NVM_DIR/versions/node/v22.22.2/bin` and **throws** on this Cloud VM if that binary is missing while `/exec-daemon` is on `PATH`. Do not prepend nvm yourself when using `deploy-*-local.ps1`. If deploy throws: `nvm install 22.22.2` and re-run (do not rely on `nvm use`).
- Install `pwsh`, native `turso` (`$HOME/.turso/turso`), and `terraform` if missing. Do **not** run `wsl` or `where.exe` on this Linux VM.
- `terraform init` on a VM with no `.terraform` is **required** before the first full apply for **that** environment. Full `deploy-*-local.ps1` (`Invoke-DeployTerraformApplyWithRecovery`) does that init, then apply. If apply fails with missing plugins or lockfile checksum mismatch, it inits and **retries apply once**. Manual `pwsh ./scripts/terraform-run.ps1 -Environment staging -Operation init -LoadEnvFiles` is only a contingency when you are not using the full deploy script, or that retry still failed.
- **Lockfile timing:** Linux `terraform init` dirties `.terraform.lock.hcl` with extra platform hashes. **Leave that file dirty through apply and through `terraform output`** (Auth0 sync, worker name). Reverting after apply but before output is CA-23 (production 2026-09-01). After those reads succeed, the deploy script reverts the hash-only diff when the lockfile was clean at start. Never commit those hashes unless the operator asked for a lockfile change.

**Staging-deploy contingencies (do not work around by editing `.env.dev` to production)**

| Symptom | Scripted path | If it still fails |
|---------|---------------|-------------------|
| Process `TURSO_DATABASE_URL` = production EmDash | Skip process URL (even if Terraform URL is set) and skip process token (`IgnoredProcessProductionShadow`) | Run deploy. **STOP** only if resolve **throws**. Do not write that pair into `.env.dev`. Mint a staging JWT in `.env.dev` |
| No `.terraform` / plugin checksum vs lockfile | Auto-init; retry apply once; leave lockfile dirty **through apply and `terraform output`**; revert hash-only after Auth0/worker-name reads | Manual `terraform-run.ps1 -Operation init` then full deploy. Do **not** `git checkout` the lockfile before apply **or** before `terraform output` |
| Missing Terraform Cloud token | Remap `TF_TOKEN_APP_TERRAFORM_IO` → `TF_TOKEN_app_terraform_io` | Copy that Cursor secret into the preflight name in process env (never print it) |
| Wrangler `6111` / `9106` | Replace short `CLOUDFLARE_API_TOKEN` stub with `TF_VAR_CLOUDFLARE_API_TOKEN` | Same overwrite in process env |
| `EBADENGINE` / Node 22.14 | Prepend nvm 22.22.2 | Install that nvm version; prepend its `bin` |
| `EMDASH_TARGET_FINGERPRINT` unset | Staging: same-run `--status` in `emdash-core-migrate.mjs` (no env pin). Production: `print-fingerprint` into process `EMDASH_TARGET_FINGERPRINT` only | If apply still refuses, wrong host. Do not invent Cursor secrets |
| Production process URL = production hint; `.env.dev` stays staging | Production resolve uses `TURSO_PRODUCTION_EMDASH_DB_TOKEN` / paired JWT. Never write that pair into `.env.dev` | Copy process JWT into `TURSO_PRODUCTION_EMDASH_DB_TOKEN` only |
| Rollback JSON mtime 1970 / old `createdAtUtc` | Skip check uses `createdAtUtc`; epoch mtime is not fresh | Omit `-SkipTursoBackup`; create a new rollback branch |
| GitHub `Apply to Staging` / Android / iOS fail in ~3s with empty steps | Ignore | Do not treat as this VM deploy failing |
| Staging `/` 1–3s with `Server-Timing` | Success | A hang is **0-byte pending**, not a slow 200 |
| `punycode` deprecation / `patch-cloudflare-bundle` patched 0 | Ignore | Noise |

**Full staging command**

- `pwsh ./scripts/deploy-staging-local.ps1 -SkipVersionBump` with **no** `-WorkerOnly` / `-WorkersOnly`. That **does** run Terraform (init + apply recovery above).
- Staging backup is `turso db export` of `freedomtimes-emdash-staging` → `.release/backups/emdash-staging-<stamp>.db`. Export does **not** require `TF_VAR_TURSO_DATABASE_NAME_STAGING` (Terraform default name). After a successful export, retry may use `-SkipTursoBackup` against that fresh file. <!-- pragma: allowlist secret -->
- A successful Terraform mutate can be small (example: `0 added, 2 changed, 0 destroyed`). That is not a required delta next time. Apply delta of `0 added, 1 changed, 0 destroyed` on the holding-page Worker is expected (`last_deployed_from = wrangler`).
- After apply: `emdash migrate` apply, wrangler staging, `emdash migrate --check`. Pending none is success.
- Probe `https://staging.freedomtimes.news/` HTTP 200 is the **locked holding page** (title Secure Access, Log in with Google). That is success, not a worker failure. Staging stays locked (**Primary guardrails §4**). Cold `/` with `Server-Timing` in 1–3s is not a hang. <!-- pragma: allowlist secret -->
- **`staging-reader`:** staging Terraform can create the Auth0 role (`create_staging_reader_role = true`). Deploy does **not** assign users. The operator must assign the role in Auth0. Do not invite those users as EmDash CMS users. Locked `/homepage` without cookies stays 302 `/`.

**Production extras (only when the operator asked in this chat)**

- Full stack: `pwsh ./scripts/deploy-production-local.ps1` with **no** `-WorkerOnly`. That creates a Turso rollback branch, applies Terraform, syncs Worker secrets, builds, migrates, and deploys. Do **not** pass `-SkipTursoBackup` unless a checkpoint newer than 24h already matches (scripts match `sourceDatabase` to `TF_VAR_TURSO_DATABASE_NAME_PRODUCTION` **or** the production EmDash URL host — `TF_VAR_TURSO_DATABASE_NAME_PRODUCTION` is often unset here).
- **`TURSO_PRODUCTION_EMDASH_DB_TOKEN`** is often unset as a Cursor secret. If process `TURSO_DATABASE_URL` is production EmDash, copy process `TURSO_AUTH_TOKEN` into `TURSO_PRODUCTION_EMDASH_DB_TOKEN` only. Do **not** write that pair into `.env.dev` as `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` (file `TURSO_DATABASE_URL` stays staging). Do **not** source staging Turso PATH overlays during a production deploy.
- Resolve helpers now prefer `TURSO_PRODUCTION_EMDASH_DB_TOKEN` over Terraform-minted `turso_database_auth_token` (that output has **404'd**). Still mint/set the production JWT; do not use process `TURSO_AUTH_TOKEN` as a *staging* token when the hosts match.
- Fingerprint: local **production** `Ensure-DeployEmdashTargetFingerprintFromStatus` sets process `EMDASH_TARGET_FINGERPRINT` from `print-fingerprint` when unset. Local **staging** leaves the pin unset so `emdash-core-migrate.mjs` uses same-run `--status`. Do not require `EMDASH_TARGET_FINGERPRINT_*` as Cursor secrets. Do not write the pin into `.env.dev`.
- If Terraform apply **succeeds** and a later step fails: do not re-apply blindly. Finish with `pwsh ./scripts/deploy-production-local.ps1 -WorkerOnly -AllowProduction -SyncCloudflareWorkerSecrets` (omit `-SkipTursoBackup` unless the skip check passes). If Terraform itself failed: **STOP** before wrangler.
- Apply delta of `0 added, 1 changed, 0 destroyed` on the holding-page Worker is expected (`last_deployed_from = wrangler`).
- Probe apex `/` (200 newsroom, not Secure Access) and `/homepage` (301 → `/` on the same host). Do not require `www` (may have no DNS). Staging probes stay the locked wall.
