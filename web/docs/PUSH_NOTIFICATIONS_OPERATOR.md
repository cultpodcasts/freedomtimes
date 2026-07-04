# Push notifications — operator reference (`.env.dev` + scripts)

**Start here for workflows:** **[PUSH_NOTIFICATIONS_TEST_PLAN.md](./PUSH_NOTIFICATIONS_TEST_PLAN.md)** — doc map, running notification code locally, delivery paths, staging/production checklists, troubleshooting.

This document is the **source of truth for repo-root `.env.dev` keys and operator scripts** — values are read from actual script sources, not guessed.

All operator scripts run from **`web/`** unless noted. They load repo-root **`.env.dev`** via `web/scripts/lib/load-env-dev.mjs` (then **`.env.production`** overrides on top). Canonical Turso key names live in `web/scripts/lib/turso-env-bindings.mjs`, which mirrors the PowerShell sync scripts exactly.

---

## Table of contents

- [Section A — `.env.dev` reference](#section-a--envdev-reference)
  - [Turso: subscriptions + scheduler](#turso-subscriptions--scheduler)
  - [Turso: EmDash (not used by push scripts)](#turso-emdash-not-used-by-push-scripts)
  - [Turso Platform API (production token mint only)](#turso-platform-api-production-token-mint-only)
  - [VAPID (web push)](#vapid-web-push)
  - [Android FCM](#android-fcm)
  - [iOS APNs](#ios-apns)
  - [What scripts read vs what Cloudflare workers use](#what-scripts-read-vs-what-cloudflare-workers-use)
  - [Sync commands](#sync-commands)
  - [Fallback behavior](#fallback-behavior)
  - [Common mistakes](#common-mistakes)
- [Section B — Testing scripts reference](#section-b--testing-scripts-reference)
  - [npm scripts summary](#npm-scripts-summary)
  - [subscriptions:env-keys](#subscriptionsenv-keys)
  - [subscriptions:inspect / subscriptions:list](#subscriptionsinspect--subscriptionslist)
  - [subscriptions:compare-vapid-keys](#subscriptionscompare-vapid-keys)
  - [subscriptions:send-test](#subscriptionssend-test)
  - [subscriptions:reset-sent-article](#subscriptionsreset-sent-article)
  - [subscriptions:db:* and backfill](#subscriptionsdb-and-backfill)
  - [Notification diagnostic reports](#notification-diagnostic-reports)
  - [Auxiliary scripts (no npm alias)](#auxiliary-scripts-no-npm-alias)
  - [shared/push module](#sharedpush-module)
  - [Typical workflows](#typical-workflows)
- [Section C — Local vs Cloudflare Workers](#section-c--local-vs-cloudflare-workers)
  - [Delivery paths by platform](#delivery-paths-by-platform)
  - [Web Crypto / nodejs_compat](#web-crypto--nodejs_compat)
- [Related docs](#related-docs)

---

## Section A — `.env.dev` reference

### Turso: subscriptions + scheduler

Operator push scripts connect to **subscriptions** (subscription rows, `sent_article_notifications`, `notification_diagnostics`) and **scheduler** (`scheduler_jobs` for inspect). Keys are **environment-specific** — staging and production are separate databases.

| Variable | Purpose | Staging / production | How to obtain / sync | Common mistakes |
|----------|---------|----------------------|----------------------|-----------------|
| `TURSO_STAGING_SUBSCRIPTIONS_DB_URL` | libsql URL for staging subscriptions DB | staging | `pwsh scripts/sync-staging-turso-env-dev.ps1` (Terraform `subscriptions_turso_database_url`) | Using production URL with staging token (Turso often returns **404**, not 401) |
| `TURSO_STAGING_SUBSCRIPTIONS_DB_TOKEN` | Auth JWT for staging subscriptions | staging | same sync script (`subscriptions_turso_database_auth_token`) | Confusing with `TURSO_AUTH_TOKEN` (EmDash token) |
| `TURSO_STAGING_SCHEDULER_DB_URL` | libsql URL for staging scheduler DB | staging | same sync script | — |
| `TURSO_STAGING_SCHEDULER_DB_TOKEN` | Auth JWT for staging scheduler | staging | same sync script | — |
| `TURSO_SUBSCRIPTIONS_DATABASE_URL` | Production subscriptions URL (**preferred** alias) | production | `pwsh scripts/sync-production-turso-env-dev.ps1` | Only setting `TURSO_PRODUCTION_*` without the `TURSO_SUBSCRIPTIONS_*` pair (scripts accept both; sync writes **both**) |
| `TURSO_PRODUCTION_SUBSCRIPTIONS_DB_URL` | Production subscriptions URL (alias) | production | same production sync | — |
| `TURSO_SUBSCRIPTIONS_AUTH_TOKEN` | Production subscriptions token (**preferred** alias) | production | production sync; or `node web/scripts/pull-production-turso-secrets.mjs` from Cloudflare bindings | Putting EmDash `TURSO_AUTH_TOKEN` here — must match **subscriptions** DB |
| `TURSO_PRODUCTION_SUBSCRIPTIONS_DB_TOKEN` | Production subscriptions token (alias) | production | same | — |
| `TURSO_SCHEDULER_DATABASE_URL` | Production scheduler URL (**preferred**) | production | production sync | — |
| `TURSO_PRODUCTION_SCHEDULER_DB_URL` | Production scheduler URL (alias) | production | same | — |
| `TURSO_SCHEDULER_AUTH_TOKEN` | Production scheduler token (**preferred**) | production | production sync | — |
| `TURSO_PRODUCTION_SCHEDULER_DB_TOKEN` | Production scheduler token (alias) | production | same | — |

**Resolution order:** scripts use `pickFirstEnvOptional` — **first non-empty key wins** (order in table / `turso-env-bindings.mjs`). Production URLs can also be derived from Terraform output or from `TURSO_DATABASE_URL` host suffix + database name when Terraform URL output is missing.

**Worker secret names (deployed):** `.env.dev` keys above map to worker secrets via `scripts/set-github-secrets.ps1`:

| `.env.dev` (staging example) | Cloudflare worker secret |
|-------------------------------|--------------------------|
| `TURSO_STAGING_SUBSCRIPTIONS_DB_URL` | `TURSO_SUBSCRIPTIONS_DATABASE_URL` |
| `TURSO_STAGING_SUBSCRIPTIONS_DB_TOKEN` | `TURSO_SUBSCRIPTIONS_AUTH_TOKEN` |
| `TURSO_STAGING_SCHEDULER_DB_URL` | `TURSO_SCHEDULER_DATABASE_URL` |
| `TURSO_STAGING_SCHEDULER_DB_TOKEN` | `TURSO_SCHEDULER_AUTH_TOKEN` |

Production uses the `TURSO_SUBSCRIPTIONS_*` / `TURSO_SCHEDULER_*` or `TURSO_PRODUCTION_*` pairs from `.env.dev` with the same worker secret **names** (no `STAGING_` / `PRODUCTION_` prefix on workers).

### Turso: EmDash (not used by push scripts)

| Variable | Purpose | Notes |
|----------|---------|-------|
| `TURSO_DATABASE_URL` | EmDash CMS libsql URL | Used by Astro build / EmDash — **not** subscriptions inspect/send-test |
| `TURSO_AUTH_TOKEN` | EmDash app token | **Fallback only** when resolving production scheduler/subscriptions token if URL looks like `freedomtimes-emdash-production-*` — usually **wrong** for push scripts; prefer explicit subscriptions keys |

### Turso Platform API (production token mint only)

Used by **`scripts/sync-production-turso-env-dev.ps1`** when Terraform `*_auth_token` outputs are absent from remote state. Not used for routine query auth.

| Variable | Purpose | Common mistakes |
|----------|---------|-----------------|
| `TURSO_PLATFORM_API_TOKEN` | Turso dashboard → Settings → API tokens | **Correct** name for Platform API |
| `TF_VAR_turso_api_token` | Same token (Terraform provider) | Accepted as alias |
| `TURSO_TOKEN` | Legacy alias | Often wrongly set to a **database JWT** (`eyJ...`) — sync script **skips** JWT-shaped values for API mint |
| `TF_VAR_TURSO_ORGANIZATION` | Org slug for API mint | Required when minting production DB tokens |

**Never** put `TURSO_AUTH_TOKEN` or `TURSO_SUBSCRIPTIONS_AUTH_TOKEN` in `TURSO_TOKEN` — see `.env.dev.example` comments.

### VAPID (web push)

| Variable | Staging / production | Used by send-test (`--target`) | Worker secret (via `set-github-secrets.ps1`) |
|----------|----------------------|----------------------------------|-----------------------------------------------|
| `PUSH_STAGING_SUBSCRIBE_PUBLIC_KEY` | staging | staging (1st choice) | Web: `PUSH_SUBSCRIBE_PUBLIC_KEY` |
| `PUSH_STAGING_VAPID_PRIVATE_KEY` | staging | staging (1st choice) | Scheduler: `PUSH_VAPID_PRIVATE_KEY` |
| `PUSH_STAGING_VAPID_SUBJECT` | staging | staging (1st choice) | Scheduler: `PUSH_VAPID_SUBJECT` |
| `PUSH_PRODUCTION_SUBSCRIBE_PUBLIC_KEY` | production | production (1st choice) | Web: `PUSH_SUBSCRIBE_PUBLIC_KEY` |
| `PUSH_PRODUCTION_VAPID_PRIVATE_KEY` | production | production (1st choice) | Scheduler: `PUSH_VAPID_PRIVATE_KEY` |
| `PUSH_PRODUCTION_VAPID_SUBJECT` | production | production (1st choice) | Scheduler: `PUSH_VAPID_SUBJECT` |
| `PUSH_VAPID_PUBLIC_KEY` | either (fallback) | 2nd choice if env-specific key unset | — |
| `PUSH_VAPID_PRIVATE_KEY` | either (fallback) | 2nd choice | — |
| `PUSH_VAPID_SUBJECT` | either (fallback) | 2nd choice | — |

**Pairing rule:** the public key users subscribe with (`PUSH_*_SUBSCRIBE_PUBLIC_KEY` → worker `PUSH_SUBSCRIBE_PUBLIC_KEY`) must match the private key that sends (`PUSH_*_VAPID_PRIVATE_KEY` → worker `PUSH_VAPID_PRIVATE_KEY`). Scheduler also stores public key as `PUSH_VAPID_PUBLIC_KEY` (same value as subscribe public key).

Verify with `npm run subscriptions:compare-vapid-keys`.

### Android FCM

| Variable | Staging / production | send-test | Scheduler worker |
|----------|----------------------|-----------|------------------|
| `PUSH_PRODUCTION_ANDROID_FCM_PROJECT_ID` | production (preferred) | `--target production`: 1st choice | `PUSH_ANDROID_FCM_PROJECT_ID` |
| `PUSH_PRODUCTION_ANDROID_FCM_CLIENT_EMAIL` | production | same | `PUSH_ANDROID_FCM_CLIENT_EMAIL` |
| `PUSH_PRODUCTION_ANDROID_FCM_PRIVATE_KEY` | production | same | `PUSH_ANDROID_FCM_PRIVATE_KEY` |
| `PUSH_STAGING_ANDROID_FCM_*` | staging-named keys | **Not** used by staging scheduler for delivery | `set-github-secrets.ps1` accepts staging FCM as **fallback** when syncing **production** worker secrets |
| `PUSH_ANDROID_FCM_*` | unprefixed fallback | 2nd choice in send-test key lists | Worker secret names (no env prefix) |

**Staging scheduler does not send Android FCM.** Native Android subscriptions live in the **production** subscriptions DB; use `--target production` for Android `send-test`.

**send-test FCM fallback (local only):** when `--target production`, if `PUSH_PRODUCTION_ANDROID_FCM_*` are unset, send-test accepts `PUSH_STAGING_ANDROID_FCM_*` (same Firebase project). When `--target staging`, the reverse fallback also applies — but Android rows on staging are uncommon.

### iOS APNs

| Variable | Environment | APNs host |
|----------|-------------|-----------|
| `PUSH_STAGING_IOS_APNS_TEAM_ID`, `_KEY_ID`, `_PRIVATE_KEY`, `_BUNDLE_ID` | staging send-test + staging scheduler | `api.sandbox.push.apple.com` (hardcoded in send-test / wrangler staging) |
| `PUSH_PRODUCTION_IOS_APNS_*` | production | `api.push.apple.com` |

Worker secrets: `PUSH_IOS_APNS_TEAM_ID`, `PUSH_IOS_APNS_KEY_ID`, `PUSH_IOS_APNS_PRIVATE_KEY`, `PUSH_IOS_APNS_BUNDLE_ID`, `PUSH_IOS_APNS_HOST`.

### What scripts read vs what Cloudflare workers use

```
.env.dev (operator)                    Cloudflare worker secrets
─────────────────────                  ───────────────────────────
PUSH_STAGING_SUBSCRIBE_PUBLIC_KEY  →   freedomtimes-staging: PUSH_SUBSCRIBE_PUBLIC_KEY
PUSH_STAGING_VAPID_PRIVATE_KEY     →   freedomtimes-scheduler-staging: PUSH_VAPID_PRIVATE_KEY
                                       (+ PUSH_VAPID_PUBLIC_KEY = same public key)

PUSH_PRODUCTION_ANDROID_FCM_*      →   freedomtimes-scheduler-production: PUSH_ANDROID_FCM_*
                                       (NOT PUSH_PRODUCTION_ANDROID_FCM_* on the worker)
```

**send-test** maps `.env.dev` names into the **scheduler worker shape** (`PUSH_VAPID_*`, `PUSH_ANDROID_FCM_*`, `PUSH_IOS_APNS_*`) before calling `shared/push/deliverPushNotification.mjs` — same code path as the scheduler queue consumer.

**Web worker** only needs subscribe-side VAPID public key + Turso subscriptions URL/token for the subscribe API — not the private VAPID key.

### Sync commands

From repo root:

```powershell
# Staging — all four TURSO_STAGING_* keys from Terraform staging outputs
pwsh scripts/sync-staging-turso-env-dev.ps1

# Production — URLs for both alias key pairs; tokens preserved if already in .env.dev,
# else Terraform output or Turso Platform API mint (needs TURSO_PLATFORM_API_TOKEN + TF_VAR_TURSO_ORGANIZATION)
pwsh scripts/sync-production-turso-env-dev.ps1
```

**Alternative (production Turso from live worker secrets):**

```powershell
cd web
node scripts/pull-production-turso-secrets.mjs
```

Writes `TURSO_SUBSCRIPTIONS_*` + `TURSO_PRODUCTION_*` and scheduler equivalents from Cloudflare remote bindings (requires wrangler auth). Useful when Terraform state lacks auth_token outputs but workers are already configured.

**Print key names (no values):**

```powershell
cd web
npm run subscriptions:env-keys
# or: npm run subscriptions:env-keys -- production
node scripts/lib/turso-env-bindings.mjs staging
```

**Push secrets to GitHub / workers:**

```powershell
pwsh scripts/set-github-secrets.ps1 -Target Staging -SyncCloudflareWorkerSecrets
pwsh scripts/set-github-secrets.ps1 -Target Production -SyncCloudflareWorkerSecrets -AllowProduction
```

### Fallback behavior

| Scenario | Behavior |
|----------|----------|
| Production subscriptions **token** missing, staging token present | `inspect` / `list`: **warns** and uses staging DB. `send-test --target production`: **exits 1** (refuses) |
| Production subscriptions **URL** missing | Derive from Terraform output, or `deriveLibsqlUrl` from host suffix in any known Turso URL + `freedomtimes-subscriptions-production` |
| Production token missing in sync script | Mint via Turso Platform API if `TURSO_PLATFORM_API_TOKEN` set; skip overwrite if token already in `.env.dev` |
| `PUSH_PRODUCTION_ANDROID_FCM_*` missing | send-test tries `PUSH_ANDROID_FCM_*`, then `PUSH_STAGING_ANDROID_FCM_*` |
| VAPID env-specific key missing | send-test tries unprefixed `PUSH_VAPID_*` |
| `TURSO_AUTH_TOKEN` only | Used as last-resort token resolver for production — **avoid**; run production sync instead |

### Common mistakes

| Mistake | Fix |
|---------|-----|
| `TURSO_TOKEN` holds a database JWT | Use `TURSO_PLATFORM_API_TOKEN` for Platform API; use `TURSO_*_SUBSCRIPTIONS_*_TOKEN` for DB access |
| `TURSO_AUTH_TOKEN` for inspect/send-test against subscriptions | Run sync; use `TURSO_SUBSCRIPTIONS_AUTH_TOKEN` or `TURSO_STAGING_SUBSCRIPTIONS_DB_TOKEN` |
| `PUSH_STAGING_ANDROID_FCM_*` for production Android send-test | Prefer `PUSH_PRODUCTION_ANDROID_FCM_*`; staging keys work locally as fallback only |
| Subscribed on staging, `--target production` | `--target` must match subscription origin / DB |
| Stale token, HTTP 404 on inspect | Re-run appropriate sync script; compare URL host to `terraform output` |
| VAPID 401 on send | `subscriptions:compare-vapid-keys`; re-sync worker secrets; users may need to re-subscribe |

---

## Section B — Testing scripts reference

Install once:

```powershell
cd web
npm install
cd ../shared/push && npm install && cd ../../web
```

### npm scripts summary

| npm script | Script file | Default target |
|------------|-------------|----------------|
| `subscriptions:env-keys` | `scripts/lib/turso-env-bindings.mjs` | prints both staging + production |
| `subscriptions:inspect` | `scripts/inspect-push-notifications.mjs` | **staging** |
| `subscriptions:list` | same (`--list` injected) | **staging** |
| `subscriptions:compare-vapid-keys` | `scripts/compare-push-vapid-keys.mjs` | **staging** (first arg) |
| `subscriptions:send-test` | `scripts/send-test-push-notification.mjs` | **staging** (`--target`) |
| `subscriptions:reset-sent-article` | `scripts/reset-sent-article-notification.mjs` | **production** |
| `subscriptions:db:migrate` | `scripts/apply-turso-sql.ts` | production-first env |
| `subscriptions:db:seed` | same | production-first env |
| `subscriptions:db:deploy` | migrate + seed | production-first env |
| `subscriptions:db:backfill-sent-articles` | `scripts/backfill-sent-article-notifications.ts` | by `--origin` |

---

### subscriptions:env-keys

**Purpose:** Print Turso `.env.dev` key names per environment (no secret values).

```powershell
cd web
npm run subscriptions:env-keys
npm run subscriptions:env-keys -- production
```

**Required env:** none (prints reference only).

---

### subscriptions:inspect / subscriptions:list

**Purpose:** Read-only Turso state — subscription counts, recent rows, `sent_article_notifications`, scheduler `send_article_notifications` job.

**npm:**

```powershell
npm run subscriptions:inspect -- staging
npm run subscriptions:inspect -- production

npm run subscriptions:list -- staging --web --active
npm run subscriptions:list -- production --limit 50
```

**Flags** (inspect and list):

| Flag / arg | Meaning |
|------------|---------|
| `staging` \| `production` | First positional arg; default `staging` |
| `--list` | Subscriptions table only (always on for `subscriptions:list`) |
| `--web` | Filter `subscription_json.platform = web` |
| `--active` | Filter `active = 1` |
| `--limit N` | Row limit (default 10 inspect / 25 list) |

**Required env:** Turso URL + token for target (see Section A). Uses **both** subscriptions and scheduler bindings (`bindingsForTarget`).

**Staging vs production:** pass `staging` or `production` as first argument after `--`.

---

### subscriptions:compare-vapid-keys

**Purpose:** Fingerprint `.env.dev` VAPID public key vs deployed page `data-public-key` (prefix/suffix only — never prints full keys).

```powershell
npm run subscriptions:compare-vapid-keys -- staging
npm run subscriptions:compare-vapid-keys -- staging --origin https://staging.freedomtimes.news/posts/weekly-summary-22-june-2026
npm run subscriptions:compare-vapid-keys -- production --origin https://freedomtimes.news/posts/some-slug
```

**Args:**

| Arg | Meaning |
|-----|---------|
| `staging` \| `production` | First positional; default `staging` |
| `--origin <url>` | Page URL to fetch; default staging/production site origin |

**Required env:** `PUSH_STAGING_SUBSCRIBE_PUBLIC_KEY` or `PUSH_PRODUCTION_SUBSCRIBE_PUBLIC_KEY` (or `PUSH_VAPID_PUBLIC_KEY` fallback).

---

### subscriptions:send-test

**Purpose:** Deliver one push to a stored subscription — **same delivery code** as scheduler (`shared/push/deliverPushNotification.mjs`). Updates `last_success_at` / failure columns.

**Modes:**

- **Article** (`--slug`, `--article <slug>`, or `--article-id`): fetches `{siteOrigin}/api/recent-published-posts.json`, builds payload via `buildArticlePushPayload` (25-post limit).
- **Generic** (default): default title/body/url; warns if you pass `--url`/`--title`/`--body` without article flags.

**Examples:**

```powershell
# Staging web — connectivity
npm run subscriptions:send-test -- --target staging --subscription-id <uuid>

# Staging — production-like article payload
npm run subscriptions:send-test -- --target staging --subscription-id <uuid> --slug weekly-summary-22-june-2026

# Production web
npm run subscriptions:send-test -- --target production --subscription-id <uuid> --slug weekly-summary-15-june-2026

# Production Android (FCM)
npm run subscriptions:send-test -- --target production --subscription-id <android-uuid> --slug weekly-summary-15-june-2026

# By endpoint prefix, single active row, dry-run, force inactive row
npm run subscriptions:send-test -- --target staging --endpoint https://updates.push.services.mozilla.com/
npm run subscriptions:send-test -- --target staging --mine
npm run subscriptions:send-test -- --target staging --subscription-id <uuid> --dry-run
npm run subscriptions:send-test -- --target staging --subscription-id <uuid> --force
```

**Flags:**

| Flag | Purpose |
|------|---------|
| `--target staging\|production` | Turso + push credentials (default `staging`) |
| `--subscription-id <uuid>` | One `push_subscriptions.id` |
| `--endpoint <prefix>` | Newest row whose `endpoint` starts with prefix |
| `--mine` | Exactly one active subscription |
| `--slug <post-slug>` | Article mode |
| `--article <post-slug>` | Alias for `--slug` |
| `--article-id <emdash-id>` | Article mode by post id |
| `--url`, `--title`, `--body` | Generic mode only |
| `--dry-run` | Print payload; no send |
| `--force` | Send to `active=0` rows |

**Required env (by platform and target):**

| Target | Turso | Web | Android | iOS |
|--------|-------|-----|---------|-----|
| staging | `TURSO_STAGING_SUBSCRIPTIONS_*` | `PUSH_STAGING_VAPID_*` + subscribe public | FCM not configured on staging scheduler | `PUSH_STAGING_IOS_APNS_*` |
| production | `TURSO_SUBSCRIPTIONS_*` or `TURSO_PRODUCTION_SUBSCRIPTIONS_*` | `PUSH_PRODUCTION_VAPID_*` | `PUSH_PRODUCTION_ANDROID_FCM_*` (staging FCM fallback locally) | `PUSH_PRODUCTION_IOS_APNS_*` |

**Site origins (hardcoded):** staging `https://staging.freedomtimes.news`, production `https://freedomtimes.news` — not `SITE_ORIGIN` from `.env.dev`.

**Refused:** `--target production` when production subscriptions token is missing and bindings fell back to staging.

---

### subscriptions:reset-sent-article

**Purpose:** `DELETE` one row from `sent_article_notifications` so the scheduler can send that article again.

**Backup first** — see [CONTENT_PROMOTION_RUNBOOK.md](../CONTENT_PROMOTION_RUNBOOK.md) (Turso backups).

```powershell
npm run subscriptions:reset-sent-article -- --article-id weekly-summary-22-june-2026 --target staging
npm run subscriptions:reset-sent-article -- --article-id weekly-summary-15-june-2026 --target production
```

| Flag | Default | Meaning |
|------|---------|---------|
| `--article-id <slug-or-emdash-id>` | required | `article_id` column value |
| `--target staging\|production` | **production** | Which subscriptions DB |

**Required env:** subscriptions Turso URL + token for target.

---

### subscriptions:db:* and backfill

Schema/seed operations — not routine push testing, but use the same Turso env precedence as `apply-turso-sql.ts` (production `TURSO_SUBSCRIPTIONS_*` first, then staging fallback).

```powershell
npm run subscriptions:db:deploy
npx tsx scripts/backfill-sent-article-notifications.ts --origin https://freedomtimes.news
```

Backfill marks published posts as already notified (prevents retroactive scheduler spam).

---

### Notification diagnostic reports

Readers can submit anonymous notification troubleshooting reports from the push callout ("Report a problem"). Reports are stored in the **subscriptions** Turso database (`notification_diagnostics` table), not the tips database.

| Item | Value |
|------|--------|
| Migration | `infra/subscriptions-database/migrations/20260702_create_notification_diagnostics.sql` (+ status columns / value renames in later migrations) |
| Apply | `npm run subscriptions:db:migrate:staging` (staging) or `npm run subscriptions:db:migrate` (production) |
| Worker env | `TURSO_SUBSCRIPTIONS_DATABASE_URL`, `TURSO_SUBSCRIPTIONS_AUTH_TOKEN` |
| Handler | `web/src/lib/notification-diagnostics-server.ts` |
| Admin UI | `/admin/notification-diagnostics` (staging: sign in first, then open) |
| Admin API | `GET /api/admin/notification-diagnostics?status=new` — last 50 reports, newest first (default filter **`new`**) |
| Update API | `PATCH /api/admin/notification-diagnostics/:id` with `{ "status": "reviewed" \| "archived" \| "new" }` |
| Status values | `new`, `reviewed`, `archived` (same triage model as story tips) |
| Access | Auth0 role **`admin`** only (`requireNotificationDiagnosticsSession` / `authorizeNotificationDiagnosticsApiRequest` in `web/src/lib/notification-diagnostics-session.ts`) |
| Auth responses | **401** without session; **403** with valid session but wrong role (e.g. `editor`-only user) |

**Reviewing reports:** open the admin page after signing in on staging or production with an **`admin`** account. Each card shows timestamp, permission/browser/OS badges, the reader's optional note, and an expandable technical snapshot (service worker state, push subscription, errors). Triage actions match story tips: **Mark reviewed**, **Archive**, **Reopen**. Filter defaults to **New**. On locked staging, anonymous routes are blocked — sign in at `/` as admin, then open **Admin** → **Push diagnostics**.

If the table was previously created on the tips database by mistake, export/backup both databases, run `subscriptions:db:migrate` on subscriptions, and leave the empty or orphaned table on tips (harmless) or drop it manually after confirming no data to migrate.

### Reader test push (`/api/push-test-notification`)

The push callout **Send test notification** hits `POST /api/push-test-notification`. Rate limits are enforced in **Cloudflare KV** (not Turso):

| Limit | Window | KV key pattern |
|-------|--------|----------------|
| 2 sends | 5 minutes | `test:5m:{sha256(endpoint)}` (TTL 300s) |
| 3 sends | 24 hours | `test:24h:{sha256(endpoint)}` (TTL 86400s) |

- **Binding:** `READER_TEST_PUSH_THROTTLE` on the web worker (`web/wrangler.jsonc`).
- **Privacy:** keys use SHA-256 of the push endpoint only — no raw endpoint or user id in KV.
- **429 responses** include a `Retry-After` header (seconds until the active window expires).
- **Terraform:** worker KV bindings are owned by Wrangler (Terraform `cloudflare_holding_page` ignores `kv_namespace_binding` changes). Create namespaces with `npx wrangler kv namespace create "READER_TEST_PUSH_THROTTLE"` (staging/production IDs live in `wrangler.jsonc`).
- The subscriptions column `last_reader_test_at` is legacy; throttling is KV-authoritative after deploy.

---

### Auxiliary scripts (no npm alias)

| Script | Purpose |
|--------|---------|
| `web/scripts/pull-production-turso-secrets.mjs` | Pull production subscriptions + scheduler URL/token from Cloudflare wrangler remote bindings into `.env.dev` |
| `scripts/sync-staging-turso-env-dev.ps1` | Refresh four `TURSO_STAGING_*` keys |
| `scripts/sync-production-turso-env-dev.ps1` | Refresh production URLs + tokens (mint if needed) |
| `scripts/set-github-secrets.ps1` | Sync `.env.dev` → GitHub Actions + optional Cloudflare worker secrets |

**EmDash MCP** (`emdash-mcp-tools-call.mjs`) is for CMS content — not push delivery. Use it to publish/reset posts, not to inspect subscriptions.

---

### shared/push module

Location: `shared/push/` (install deps: `cd shared/push && npm install`).

| Module | Role |
|--------|------|
| `articleNotificationPayload.mjs` | `buildArticlePushPayload(siteOrigin, post)` — title, excerpt, absolute url, icon, optional featured image |
| `deliverPushNotification.mjs` | `parseStoredTarget`, `readWebPushConfig`, `readAndroidPushConfig`, `readIosPushConfig`, `deliverToStoredTarget` |
| `deliverPushNotification.types.mjs` | Shared types |

Scheduler worker TypeScript copies should stay in sync (`scheduler-worker/src/deliverPushNotification.ts`, `articleNotificationPayload.ts`).

Worker env keys consumed by `read*Config`:

- Web: `PUSH_VAPID_PUBLIC_KEY`, `PUSH_VAPID_PRIVATE_KEY`, `PUSH_VAPID_SUBJECT`
- Android: `PUSH_ANDROID_FCM_PROJECT_ID`, `PUSH_ANDROID_FCM_CLIENT_EMAIL`, `PUSH_ANDROID_FCM_PRIVATE_KEY`, `PUSH_ANDROID_FCM_CHANNEL_ID`
- iOS: `PUSH_IOS_APNS_TEAM_ID`, `PUSH_IOS_APNS_KEY_ID`, `PUSH_IOS_APNS_PRIVATE_KEY`, `PUSH_IOS_APNS_BUNDLE_ID`, `PUSH_IOS_APNS_HOST`

---

### Typical workflows

#### 1. First-time setup / stale credentials

```powershell
pwsh scripts/sync-staging-turso-env-dev.ps1
pwsh scripts/sync-production-turso-env-dev.ps1   # or pull-production-turso-secrets.mjs
cd web
npm run subscriptions:env-keys
npm run subscriptions:compare-vapid-keys -- staging --origin https://staging.freedomtimes.news/posts/<slug>
```

#### 2. Inspect → send-test (staging web)

```powershell
cd web
npm run subscriptions:inspect -- staging
npm run subscriptions:list -- staging --web --active
# copy newest id after subscribing in browser
npm run subscriptions:send-test -- --target staging --subscription-id <uuid> --slug <slug>
npm run subscriptions:inspect -- staging   # confirm last_success_at
```

#### 3. Reset sent article → wait for cron

```powershell
# backup subscriptions DB first (CONTENT_PROMOTION_RUNBOOK)
npm run subscriptions:reset-sent-article -- --article-id <slug> --target staging
# wait up to 10 min (staging cron); tail scheduler-worker logs
```

#### 4. Production multi-browser prep

See **[MULTI_BROWSER_PRODUCTION_PUSH_TEST.md](./MULTI_BROWSER_PRODUCTION_PUSH_TEST.md)**. Short sequence:

```powershell
pwsh scripts/sync-production-turso-env-dev.ps1
cd web
npm run subscriptions:env-keys
npm run subscriptions:compare-vapid-keys -- production
npm run subscriptions:inspect -- production
# subscribe on https://freedomtimes.news, then per-browser send-test with --target production
```

#### 5. VAPID / secret drift

```powershell
npm run subscriptions:compare-vapid-keys -- <env> --origin <post-url>
pwsh scripts/set-github-secrets.ps1 -Target Staging -SyncCloudflareWorkerSecrets
# redeploy web + scheduler workers; users re-subscribe if keys changed
```

#### 6. Scheduler delivery debug

```powershell
cd scheduler-worker
npx wrangler tail --env staging
# or --env production
```

Look for `article notification scan`, `push delivered ok`, `delivery failed`.

---

## Section C — Local vs Cloudflare Workers

Operator scripts and the scheduler worker share **`shared/push/`** delivery logic. You test locally with Node; production cron runs on Cloudflare Workers with `nodejs_compat`.

### Architecture

```
push_subscriptions (Turso)
       │
       ├─ subscriptions:send-test (Node, web/scripts/)
       │     load .env.dev → map PUSH_STAGING_* / PUSH_PRODUCTION_* to worker secret names
       │     → deliverToStoredTarget() in shared/push/deliverPushNotification.mjs
       │
       └─ scheduler queue consumer (Cloudflare Worker, scheduler-worker/)
             env PUSH_VAPID_* / PUSH_ANDROID_FCM_* / PUSH_IOS_APNS_* from Wrangler secrets
             → same deliverToStoredTarget() (re-exported from shared/push/deliverPushNotification.mjs)
```

| Component | Config source | Outbound push? |
|-----------|---------------|----------------|
| Web worker (`web/wrangler.jsonc`, `nodejs_compat`) | `PUSH_SUBSCRIBE_PUBLIC_KEY`, Turso subscriptions URL/token | No — subscribe API only |
| Scheduler worker (`scheduler-worker/wrangler.jsonc`, `nodejs_compat`) | `PUSH_VAPID_*`, FCM, APNs, Turso | Yes — cron + queue |
| `subscriptions:send-test` | Repo-root `.env.dev` only | Yes — one subscription |

**send-test does not call Wrangler** at send time. Keep `.env.dev` aligned with worker secrets via `scripts/set-github-secrets.ps1` and sync scripts.

### Delivery paths by platform

`parseStoredTarget()` in `shared/push/deliverPushNotification.mjs` reads `subscription_json`:

| `platform` | Turso JSON | Send path | `.env.dev` keys (staging example) |
|------------|------------|-----------|-------------------------------------|
| `web` (default) | `endpoint`, `keys.p256dh`, `keys.auth` | VAPID via `webpush-webcrypto` | `PUSH_STAGING_SUBSCRIBE_PUBLIC_KEY` + `PUSH_STAGING_VAPID_PRIVATE_KEY` + subject |
| `android` | `token` | FCM HTTP v1 | `PUSH_PRODUCTION_ANDROID_FCM_*` (production DB only) |
| `ios` | `token` | APNs HTTP/2 | `PUSH_STAGING_IOS_APNS_*` or `PUSH_PRODUCTION_IOS_APNS_*` |

Article payload (`title`, `body`, absolute `url`, icon, featured image, tag `article-{id}`) is built by `buildArticlePushPayload()` — imported by send-test and scheduler.

**Android tap fix:** FCM messages omit `clickAction` so Capacitor routes taps through `MainActivity` → `pushNotificationActionPerformed` using absolute `data.url`. Server-side fix in `shared/push/deliverPushNotification.mjs`; re-run send-test without rebuilding the app.

### Web Crypto / nodejs_compat

Web Push encryption uses `webpush-webcrypto`. On module load, `deliverPushNotification.mjs` calls `setWebCrypto()` with:

1. `globalThis.crypto` (Workers with `nodejs_compat`, modern Node)
2. Else dynamic `import('node:crypto').webcrypto` (local send-test on Node)

Workers must declare `"compatibility_flags": ["nodejs_compat"]` in `scheduler-worker/wrangler.jsonc` and `web/wrangler.jsonc`. If delivery throws `Web Crypto API not available`, check Node version (18+) or worker compatibility flags.

---

## Related docs

- **[PUSH_NOTIFICATIONS_TEST_PLAN.md](./PUSH_NOTIFICATIONS_TEST_PLAN.md)** — **entry point**: local testing, doc map, staging checklist, consolidated troubleshooting
- **[MULTI_BROWSER_PRODUCTION_PUSH_TEST.md](./MULTI_BROWSER_PRODUCTION_PUSH_TEST.md)** — production browser matrix, like-for-like payload guarantee
- **[CONTENT_PROMOTION_RUNBOOK.md](../CONTENT_PROMOTION_RUNBOOK.md)** — Turso backups before mutating subscriptions DB
- **`.env.dev.example`** — template with comments for Platform API vs DB tokens
- **`AGENTS.md`** (repo root) — EmDash MCP rules (not for Turso push scripts)
