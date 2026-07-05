# Deploy troubleshooting — staging and production

Known issues encountered during local rebuild/deploy (`staging-rebuild-local.ps1`, `production-rebuild-local.ps1`, worker rename migrations). Use this when a deploy script fails before or after Terraform apply.

**Related docs:**

- [docs/CLI_PATHS_WINDOWS.md](../../docs/CLI_PATHS_WINDOWS.md) — **primary reference** for Windows Terraform PATH and WSL Turso CLI
- [ENVIRONMENT_SETUP.md](../../ENVIRONMENT_SETUP.md) — secret sync and FCM credential prep
- [PUSH_NOTIFICATIONS_OPERATOR.md](./PUSH_NOTIFICATIONS_OPERATOR.md) — full `.env.dev` push key reference
- [STAGING_RECOVERY.md](../../STAGING_RECOVERY.md) — one-command staging rebuild and worker rename checklist
- [scripts/set-github-secrets.md](../../scripts/set-github-secrets.md) — Cloudflare token permissions for CI

---

## Table of contents

- [EmDash MCP failure (AI agents)](#emdash-mcp-failure-ai-agents)
- [FCM keys (staging and production rebuild preflight)](#fcm-keys-staging-and-production-rebuild-preflight)
- [Auth0 env sync skipped](#auth0-env-sync-skipped)
- [Turso EmDash secrets after worker rename](#turso-emdash-secrets-after-worker-rename)
- [Production deploy without Terraform apply](#production-deploy-without-terraform-apply)
- [Wrangler deploy working directory](#wrangler-deploy-working-directory)
- [Terraform worker script lifecycle](#terraform-worker-script-lifecycle)
- [Cloudflare API token vs Wrangler OAuth](#cloudflare-api-token-vs-wrangler-oauth)
- [Web version bump on deploy](#web-version-bump-on-deploy)
- [Quick symptom index](#quick-symptom-index)

---

## EmDash MCP failure (AI agents)

### Symptom

Cursor agent cannot call EmDash MCP (`content_get`, `content_update`, …): servers missing from **Tools & MCP**, red/error status in MCP Logs, `INVALID_TOKEN` / 401, or `call_mcp_tool` not registered (only built-in servers like `cursor-ide-browser`).

### Fix MCP — do not use shell as agent workaround

| Who | Action |
|-----|--------|
| **AI agent** | **STOP.** Tell operator: *"EmDash MCP is not available in this session. Enable freedomtimes-staging / freedomtimes-production under Tools & MCP, restart Cursor if needed, refresh tokens (`emdash login` / PAT), check Output → MCP Logs. Tell me when ready."* **Never** fall back to `emdash-mcp-tools-call.mjs`, `npx emdash content`, REST curl, or CLI. |
| **Operator** | **Ctrl+Shift+J → Tools & MCP** — enable EmDash servers; restart Cursor; **Output → MCP Logs**; `cd web && npx emdash login` for staging/production; or set PAT via `scripts/set-emdash-mcp-tokens.ps1`. **Full Windows/Cursor setup:** **`docs/CURSOR_EMDASH_MCP.md`** and personal skill **`~/.cursor/skills/freedomtimes-emdash-mcp/SKILL.md`**. Optionally run `node web/scripts/emdash-mcp-tools-call.mjs …` manually from a terminal — operator choice only. |

Canonical policy: **`AGENTS.md`** § *Primary guardrails* §1; **`web/docs/PLAN_EMDASH_CONTENT_FORMAT_AND_MCP_HANDOFF.md`** § *CLI vs MCP*.

---

## FCM keys (staging and production rebuild preflight)

### What happened (Jul 2026 production deploy)

`production-rebuild-local.ps1` failed immediately at preflight:

```text
Missing required production push secret values in .env.dev:
PUSH_PRODUCTION_ANDROID_FCM_PROJECT_ID,
PUSH_PRODUCTION_ANDROID_FCM_CLIENT_EMAIL,
PUSH_PRODUCTION_ANDROID_FCM_PRIVATE_KEY
```

`.env.dev` had **`PUSH_STAGING_ANDROID_FCM_*`** populated (same Firebase project) but not the **production-prefixed** trio. VAPID keys were present; only FCM blocked the run.

Production preflight now accepts `PUSH_STAGING_ANDROID_FCM_*` when production-prefixed FCM keys are absent (aligned with `set-github-secrets.ps1`).

### Required env vars by stage

| Stage | Script / step | Required `.env.dev` keys | FCM required? |
|-------|---------------|--------------------------|---------------|
| **Staging rebuild** | `Assert-StagingPushSecretsReady` (via `scripts/assert-push-secrets-ready.ps1`) | Staging VAPID keys **plus** same FCM resolution as production (`PUSH_PRODUCTION_ANDROID_FCM_*` or `PUSH_STAGING_ANDROID_FCM_*`) | **Yes** (preflight only; staging worker sync still does not push FCM) |
| **Production rebuild preflight** | `Assert-ProductionPushSecretsReady` (via `scripts/assert-push-secrets-ready.ps1`) | Production VAPID keys **plus** `PUSH_PRODUCTION_ANDROID_FCM_*` **or** `PUSH_STAGING_ANDROID_FCM_*` (same fallback as secret sync) | **Yes** |
| **Production secret sync** | `set-github-secrets.ps1 -Target Production -SyncCloudflareWorkerSecrets` | Prefer `PUSH_PRODUCTION_ANDROID_FCM_*`; **accepts** `PUSH_STAGING_ANDROID_FCM_*` as fallback | Yes — mapped to scheduler worker `PUSH_ANDROID_FCM_*` |
| **Runtime Android push** | `freedomtimes-scheduler-production` queue consumer | Worker secrets `PUSH_ANDROID_FCM_PROJECT_ID`, `PUSH_ANDROID_FCM_CLIENT_EMAIL`, `PUSH_ANDROID_FCM_PRIVATE_KEY` | Yes — missing → `Android push delivery is not configured` on publish/send-test |

**Preflight alignment:** Staging and production rebuild scripts dot-source `scripts/assert-push-secrets-ready.ps1`. Both run the same FCM key resolution (production-prefixed first, then staging fallback). Staging rebuild surfaces missing FCM credentials before production deploy. `Assert-ProductionPushSecretsReady` accepts `PUSH_STAGING_ANDROID_FCM_*` when production-prefixed FCM keys are absent (same order as `set-github-secrets.ps1`). Preflight emits a warning recommending `populate-android-fcm-env.ps1` or `PUSH_PRODUCTION_ANDROID_FCM_*` for clarity; VAPID key prefixes remain environment-specific (staging vs production).

Production preflight also requires production VAPID delivery keys:

- `PUSH_PRODUCTION_SUBSCRIBE_PUBLIC_KEY`
- `PUSH_PRODUCTION_VAPID_PRIVATE_KEY`
- `PUSH_PRODUCTION_VAPID_SUBJECT`

### Placeholder detection

All three layers reject unresolved template values matching `<...>` (regex `^<[^>]+>$`):

| Layer | When it throws |
|-------|----------------|
| `production-rebuild-local.ps1` / `staging-rebuild-local.ps1` preflight | Missing key or placeholder value |
| `set-github-secrets.ps1` (`Set-WorkerSecret`, `Set-GhSecret`, `Set-GhVariable`) | Placeholder value at sync time |
| Deploy itself | Does not re-check — bad values would land on the worker if preflight/sync guards were bypassed |

Example placeholders from `.env.dev.example`: `<firebase-project-id>`, `<firebase-service-account-email>`.

### Where to get FCM credentials

1. **Firebase Console** → Project settings → Service accounts → generate/download JSON key for the Firebase Admin SDK service account used by the Android app.
2. **Or** run from repo root (writes **`PUSH_PRODUCTION_ANDROID_FCM_*`** only):

   ```powershell
   .\scripts\populate-android-fcm-env.ps1 `
     -ProjectId <firebase-project-id> `
     -ServiceAccountEmail <firebase-adminsdk-...@....iam.gserviceaccount.com>

   # Or from an existing JSON key file:
   .\scripts\populate-android-fcm-env.ps1 -JsonKeyPath C:\path\to\service-account.json
   ```

3. If you already have `PUSH_STAGING_ANDROID_FCM_*` for the same Firebase project, **copy** the three values to the `PUSH_PRODUCTION_ANDROID_FCM_*` names (or re-run `populate-android-fcm-env.ps1`).

Private key format in `.env.dev`: PEM with newlines escaped as `\n` (see `.env.dev.example`).

Full key mapping (`.env.dev` → worker secret names): [PUSH_NOTIFICATIONS_OPERATOR.md § Android FCM](./PUSH_NOTIFICATIONS_OPERATOR.md#android-fcm).

### Fix and retry

```powershell
# 1. Populate production-prefixed FCM keys (see above)

# 2. Re-run production rebuild
pwsh scripts/production-rebuild-local.ps1
```

If preflight passes but Android push still fails after deploy:

```powershell
cd web
npm run subscriptions:send-test -- --target production --subscription-id <uuid> --slug <slug>
# Expect FCM errors if scheduler worker secrets missing — re-sync:
pwsh scripts/set-github-secrets.ps1 -Target Production -SyncCloudflareWorkerSecrets -AllowProduction
```

---

## Turso EmDash secrets after worker rename

### What happened

When renaming web Workers (`freedomtimes-holding-staging` → `freedomtimes-staging`, `freedomtimes-holding` → `freedomtimes`), Wrangler `deploy` with a new script **name** creates a **new** Worker. Secrets on the old script are **not** copied automatically.

Two secret sources apply to the **web** Worker:

| Secret names | Set by | Purpose |
|--------------|--------|---------|
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | **Terraform** (`cloudflare_workers_secret`; Turnstile widget in each environment) | Story tips Turnstile |
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | **Wrangler / deploy CI / `switch-production-turso-secrets.ps1`** — **not Terraform** | EmDash CMS Turso connection |
| `AUTH0_*`, `EMDASH_*`, `TURSO_SUBSCRIPTIONS_*`, `TURSO_TIPS_*`, `PUSH_*`, … | **`set-github-secrets.ps1`** / CI | Auth, tips DB, subscriptions, web push |

**Production outage (July 2026):** Terraform apply overwrote `TURSO_*` on the live Worker with credentials from a drifted plan (wrong libsql host → HTTP 404 on every CMS query → blank homepage). Restore with `scripts/switch-production-turso-secrets.ps1`. See `infra/terraform/README.md` § Worker Turso secrets.

After rename, verify EmDash Turso secrets exist on the **new** script name:

```powershell
cd web
npx wrangler secret list --config wrangler.jsonc --env staging   # or production
```

Expect `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`. If missing:

1. Production: `pwsh scripts/switch-production-turso-secrets.ps1 -AllowProduction` with verified `.env.dev` URLs/tokens, **or**
2. Staging/production sync: `pwsh scripts/set-github-secrets.ps1 -Target Staging|Production -SyncCloudflareWorkerSecrets`, **or**
3. Upload manually from Terraform **outputs** (build only — do not re-add TURSO to Terraform `worker_secrets`):

   ```powershell
   cd infra/terraform/environments/staging   # or production
   $url = terraform output -raw turso_database_url
   $token = terraform output -raw turso_database_auth_token
   cd ../../../web
   npx wrangler secret put TURSO_DATABASE_URL --config wrangler.jsonc --env staging
   npx wrangler secret put TURSO_AUTH_TOKEN --config wrangler.jsonc --env staging
   ```

   For production CMS cutover, `scripts/switch-production-turso-secrets.ps1` wraps the same upload with guardrails.

3. Run `set-github-secrets.ps1 -SyncCloudflareWorkerSecrets` for Auth0 and other wrangler-managed secrets (see [STAGING_RECOVERY.md § Renaming web Workers](../../STAGING_RECOVERY.md#renaming-web-workers-remove--holding)).

**Symptom if missing:** site builds/deploys but EmDash returns DB errors; empty or broken CMS reads.

---

## Production deploy without Terraform apply

### What happened

`deploy-production-worker-local.ps1` used to require non-null Terraform outputs for `turso_database_url` and `turso_database_auth_token`. After adding scheduler, subscriptions, and tips Turso databases, production workspace outputs for **URLs** (and most tokens) can be **null** until `terraform apply` runs — even when databases already exist and credentials live in `.env.dev`.

Staging avoids this with `deploy-staging-workers-only.ps1`, which loads `.env.dev` only.

### Fix (no terraform apply)

1. Ensure production Turso values exist in repo-root `.env.dev` (see [`.env.dev.example`](../../.env.dev.example) § Production Turso):
   - **EmDash build:** `TURSO_PRODUCTION_EMDASH_DB_URL`, `TURSO_PRODUCTION_EMDASH_DB_TOKEN` (preferred when `TURSO_DATABASE_URL` points at staging for local dev)
   - **Scheduler / subscriptions / tips:** `TURSO_PRODUCTION_*` or unprefixed `TURSO_SCHEDULER_*`, `TURSO_SUBSCRIPTIONS_*`, `TURSO_TIPS_*`
2. Refresh from Terraform when outputs exist, or derive URLs when only names/default DB names are known:

   ```powershell
   pwsh ./scripts/sync-production-turso-env-dev.ps1
   ```

3. Verify credential resolution without building or deploying:

   ```powershell
   pwsh ./scripts/deploy-production-worker-local.ps1 -AllowProduction -DryRun
   ```

`deploy-production-worker-local.ps1` now uses `scripts/resolve-turso-build-credentials.ps1`: Terraform output first, then `.env.dev`, then derived `libsql://` URL from a production host suffix plus `TF_VAR_TURSO_DATABASE_NAME_PRODUCTION` (default `freedomtimes-emdash-production`).

---

## Wrangler deploy working directory

### What happened

`production-rebuild-local.ps1` and `staging-rebuild-local.ps1` deploy from **repo root**:

```powershell
npx wrangler deploy --config .\web\wrangler.jsonc --env production
```

Build runs from `web/` (`npm run build` → `web/dist/server/entry.mjs`). Deploy resolves `main: "dist/server/entry.mjs"` relative to the config file location (`web/wrangler.jsonc`), so repo-root deploy is correct **when** `--config .\web\wrangler.jsonc` is used.

If deploy fails with a missing bundle / wrong `dist` path (e.g. running wrangler from repo root **without** `--config`, or using the build-only config):

```powershell
cd web
npm run build
npx wrangler deploy --config wrangler.jsonc --env production
```

Rules from [web/README.md](../README.md):

- Use **`wrangler.jsonc`** for deploy (has `main` and full `env` blocks).
- Never add `main` to `wrangler.build.jsonc` (build-only).
- Always pass `--config` and `--env staging|production`.

---

## Terraform worker script lifecycle

### What happened

Before `lifecycle { ignore_changes = [...] }` was added to `cloudflare_workers_script.holding_page`, staging Terraform apply tried to **push inline holding-page script content** and failed:

```text
Error: error updating worker script: Uncaught Error: No such module "node:module".
  imported from "worker.mjs"
```

That conflicted with the real Astro bundle deployed by Wrangler (`nodejs_compat`, bundled `entry.mjs`).

### Current model

Terraform (`infra/terraform/modules/cloudflare_holding_page/main.tf`) **owns**:

- Worker **name**, custom domain / route bindings
- EmDash Turso secrets (`TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`)

Wrangler **owns**:

- Deployed bundle (`content`, `module`, `compatibility_date`, bindings metadata, …) — ignored by Terraform via `lifecycle.ignore_changes`

**Operator rule:** deploy the app with Wrangler after Terraform apply. Do not expect Terraform to upload the Astro worker bundle. If Terraform plan wants to change `content` or `module` on the live script, ensure `ignore_changes` is present before apply.

---

## Cloudflare API token vs Wrangler OAuth

### What happened

Interactive Wrangler OAuth can fail or prompt in non-interactive/agent sessions. Terraform and CI require a scoped API token.

### Local / agent sessions

```powershell
# From .env.dev — used by terraform-run.ps1 as TF_VAR_CLOUDFLARE_API_TOKEN
$env:CLOUDFLARE_API_TOKEN = "<token-from-env-dev>"

# Wrangler also accepts this env var instead of OAuth login
$env:CLOUDFLARE_ACCOUNT_ID = "<TF_VAR_CLOUDFLARE_ACCOUNT_ID from .env.dev>"
```

`staging-rebuild-local.ps1` sets `CLOUDFLARE_ACCOUNT_ID` from `.env.dev` when unset so `set-github-secrets.ps1` / wrangler secret put can run non-interactively.

Verify auth:

```powershell
npx wrangler whoami
```

### CI / GitHub Actions

`TF_VAR_CLOUDFLARE_API_TOKEN` must cover **both** Terraform and Wrangler. Terraform minimum: see [infra/terraform/CLOUDFLARE_API_TOKEN.md](../../infra/terraform/CLOUDFLARE_API_TOKEN.md). Wrangler deploy additionally needs:

- `Workers Scripts:Edit`
- `Workers KV Storage:Edit` (staging binds `SESSION` KV — without this, deploy fails with API error `10023`)

Details: [scripts/set-github-secrets.md § Cloudflare Token Permissions](../../scripts/set-github-secrets.md#cloudflare-token-permissions-ci).

---

## Post-deploy Worker secret verify (rebuild scripts)

`staging-rebuild-local.ps1` and `production-rebuild-local.ps1` list secrets on the deployed web Worker after `wrangler deploy` and fail if any of these are missing: `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`, `EMDASH_AUTH_SECRET`, `EMDASH_PREVIEW_SECRET`.

If verify fails after a successful deploy, re-run `pwsh ./scripts/set-github-secrets.ps1 -Target Staging|Production -SyncCloudflareWorkerSecrets` (production requires `-AllowProduction`), then deploy again or put secrets manually with `npx wrangler secret put` from `web/`.

---

## Web version bump on deploy

### What this is

`web/package.json` has a `version` field that was never bumped in this repo (stuck at `0.0.1` since the file was created). It is **not** currently read anywhere in the app, build, or service worker — the deployed-build identity that actually gets exposed (`/api/version.json`, `ReaderDataProvenance.astro`, `tip-source.astro`) is the **git commit SHA** baked in via `FT_BUILD_COMMIT_SHA` (`scripts/build-provenance-env.ps1` → `web/src/lib/build-provenance.ts`), not semver.

Local deploy scripts bump the `web/package.json` (and `web/package-lock.json`) **patch** version immediately before their `npm run build` step, via `scripts/bump-web-version.ps1` (`Invoke-WebVersionBump`):

- `deploy-staging-workers-only.ps1`
- `deploy-staging-worker-local.ps1`
- `staging-rebuild-local.ps1`

**Staging bumps by default on every run** (patch: e.g. `0.0.1` → `0.0.2`). Pass `-SkipVersionBump` to opt out for a given staging run.

**Production defaults the other way — no bump.** `deploy-production-worker-local.ps1` and `production-rebuild-local.ps1` ship the **same version staging already bumped** for this release unless you explicitly ask for a new one:

| Script | Default | To bump anyway | To force no bump (same as default) |
|---|---|---|---|
| `deploy-staging-worker-local.ps1`, `deploy-staging-workers-only.ps1`, `staging-rebuild-local.ps1` | bump patch | *(default)* | `-SkipVersionBump` |
| `deploy-production-worker-local.ps1`, `production-rebuild-local.ps1` | **no bump** (uses current `web/package.json` version) | `-BumpVersion` | `-SkipVersionBump` (no-op given the new default; kept for backward compatibility) |

`-BumpVersion` and `-SkipVersionBump` are mutually exclusive on the production scripts (combining them throws).

**Typical release flow:** deploy staging (bumps `0.0.1` → `0.0.2`), validate, then deploy production — production ships `0.0.2` too (no further bump), instead of the old behavior where production would bump again to `0.0.3` for the *same* release. If you need production to carry a version staging never had (e.g. a production-only hotfix), pass `-BumpVersion` on the production script.

### Why patch, why before build, why the production default flipped

- **Patch bump**: no existing semver convention in this repo to diverge from; patch is the least disruptive default for "a new build went out."
- **Before build**: mirrors the existing commit-SHA provenance pattern — the artifact that gets deployed should reflect the version bump, not a build that predates it.
- **Staging bumps, production doesn't (by default)**: a release is staged once (one patch bump) and promoted to production unchanged — bumping again on the production deploy of the *same* release made staging and production carry different versions for identical code, which was confusing. Production keeping the version staging already set matches "one version per release."

### Uncommitted by design

The bump is **not** committed or pushed automatically. It lands in the working tree the same way any other local build output does. Commit it yourself if you want it to persist:

```powershell
git add web/package.json web/package-lock.json
git commit -m "chore: bump web version"
```

If you run a local deploy script repeatedly without committing in between, the version keeps incrementing from whatever is currently in the working tree (e.g. `0.0.1` → `0.0.2` → `0.0.3` across consecutive staging test deploys). That is expected — `git checkout -- web/package.json web/package-lock.json` resets it if you want a clean baseline.

### GitHub Actions path (`terraform-production.yml` / `terraform-staging.yml`) is not wired up

The **official** production path (`scripts/production-release.ps1 -AllowProduction`, per [PRODUCTION_RELEASE_RUNBOOK.md](../../PRODUCTION_RELEASE_RUNBOOK.md)) dispatches `terraform-production.yml`, which builds `web/` from whatever is committed on `main` — it does not bump or commit anything. Doing so automatically would require the workflow to commit-and-push a version bump back to `main` (a `contents: write` permission change plus a bot-authored commit on every apply), which was judged out of scope for this change given the version field has no current runtime consumer. `production-release.ps1` prints a reminder to bump-and-commit `web/package.json` manually before dispatch if you want the deployed build to carry a new version. Revisit this if/when the version field is wired into `build-provenance.ts` for display.

---

## Auth0 env sync skipped

### Symptom

After `terraform apply` via `scripts/terraform-run.ps1` (staging or production), output included:

```text
WARNING: Auth0 env sync skipped: The property 'module' cannot be found on this object.
```

(or a similar exception message). `.env.dev` may still lack updated `AUTH0_LOGIN_APP_CLIENT_ID_*` / `AUTH0_LOGIN_APP_CLIENT_SECRET_*` values.

### Cause (fixed Jul 2026)

`Sync-Auth0LoginAppEnvFromState` parsed `terraform state pull` JSON and accessed `.module` on every state resource. Under `Set-StrictMode -Version Latest`, resources without a `module` property threw; a catch block logged **Auth0 env sync skipped** instead of writing `.env.dev`.

### What to do

| Path | Behavior |
|------|----------|
| **`production-rebuild-local.ps1`** | Still reads `terraform output -raw auth0_app_client_id` / `auth0_app_client_secret` and updates `.env.dev` after apply, then runs `Assert-Auth0SyncToEnv`. Rebuild could succeed even when terraform-run sync was skipped. |
| **`staging-rebuild-local.ps1`** | Relied on terraform-run sync only; a skipped sync could leave stale Auth0 keys until fixed. |
| **After fix** | terraform-run uses the same `terraform output -raw` outputs as the rebuild scripts. Successful apply should log `Synced AUTH0_LOGIN_APP_CLIENT_ID_* ... from terraform outputs` with no skip warning. |

If sync still warns about missing outputs, run `terraform output` in `infra/terraform/environments/<staging|production>` and confirm `auth0_app_client_id` / `auth0_app_client_secret` exist after apply.


## Quick symptom index

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `Auth0 env sync skipped` / missing `AUTH0_LOGIN_APP_CLIENT_*` after terraform-run apply | State-pull JSON parse failed under StrictMode | Fixed in terraform-run (terraform output); production-rebuild has redundant output sync; see [Auth0 env sync skipped](#auth0-env-sync-skipped) |
| `Failed to read terraform output 'turso_database_url'` during `deploy-production-worker-local.ps1` | Production Turso URL outputs null in Terraform state (new DB resources not applied) while `.env.dev` lacks production EmDash keys | Populate `TURSO_PRODUCTION_EMDASH_DB_URL` / `TURSO_PRODUCTION_EMDASH_DB_TOKEN` (or production `TURSO_SUBSCRIPTIONS_*` URLs for host-suffix derivation) in `.env.dev`; run `pwsh ./scripts/sync-production-turso-env-dev.ps1`; verify with `pwsh ./scripts/deploy-production-worker-local.ps1 -AllowProduction -DryRun` |
| `Missing required production push secret values` (FCM labels mention production **or** staging) | No FCM keys at all in `.env.dev` | Run `populate-android-fcm-env.ps1` or set `PUSH_STAGING_ANDROID_FCM_*` / `PUSH_PRODUCTION_ANDROID_FCM_*` |
| `Unresolved placeholder production push secret values` | `.env.dev` still has `<firebase-project-id>` etc. | Replace with real values; see [ENVIRONMENT_SETUP.md](../../ENVIRONMENT_SETUP.md) |
| `Refusing to sync placeholder value for Worker secret` | Secret sync hit a template value | Same as above |
| `Missing PUSH_PRODUCTION_ANDROID_FCM_* or PUSH_STAGING_ANDROID_FCM_*` (secret sync) | No FCM keys at all | `populate-android-fcm-env.ps1` |
| Site up, EmDash DB errors after worker rename | `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` not on new script | Terraform apply or manual wrangler secret put; see above |
| Wrangler deploy: bundle / dist not found | Wrong cwd or missing `--config .\web\wrangler.jsonc` | Build in `web/`, deploy with correct config |
| Terraform: `No such module "node:module"` on worker script | Terraform trying to push holding template over Wrangler bundle | Ensure `lifecycle.ignore_changes` on `cloudflare_workers_script`; deploy via Wrangler |
| Wrangler auth / non-interactive failure | OAuth not available | Set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` |
| Terraform `Authentication error (10000)` on Turnstile or Workers | Cloudflare API token missing permission | Add permission per [infra/terraform/CLOUDFLARE_API_TOKEN.md](../../infra/terraform/CLOUDFLARE_API_TOKEN.md); update `.env.dev` and TFC `TF_VAR_cloudflare_api_token`; re-apply |
| `Android push delivery is not configured` at runtime | Scheduler worker missing `PUSH_ANDROID_FCM_*` | `set-github-secrets.ps1 -Target Production -SyncCloudflareWorkerSecrets -AllowProduction` |
| `/submit-a-tip` shows “Human verification is not configured” | Production Worker missing `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` | Run `terraform apply` in `infra/terraform/environments/production` (Turnstile widget + Worker secrets); ensure Cloudflare API token has **Turnstile → Edit** ([token guide](../../infra/terraform/CLOUDFLARE_API_TOKEN.md); no redeploy) |
| EmDash MCP unavailable / auth error in Cursor agent session | Servers disabled, stale token, MCP not registered | **Agents: STOP** — fix MCP (Tools & MCP, restart Cursor, MCP Logs, `emdash login`). **Do not** shell-fallback to `emdash-mcp-tools-call.mjs` or `npx emdash content`. Operators may run shell helper manually. See [EmDash MCP failure (AI agents)](#emdash-mcp-failure-ai-agents) |
