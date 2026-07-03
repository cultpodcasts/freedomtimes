# Story tips - operator guide

Reader story tips use a **dedicated Turso database**, separate from push subscriptions.

See also: [`infra/tips-database/README.md`](../../infra/tips-database/README.md)

Notification troubleshooting reports ("Report a problem") use the **subscriptions** database - see [web/docs/PUSH_NOTIFICATIONS_OPERATOR.md](./PUSH_NOTIFICATIONS_OPERATOR.md).

## Database

| Item | Value |
|------|--------|
| Infra module | `infra/tips-database/` |
| Worker env (web Astro Worker) | `TURSO_TIPS_DATABASE_URL`, `TURSO_TIPS_AUTH_TOKEN` |
| Local staging `.env.dev` | `TURSO_STAGING_TIPS_DB_URL`, `TURSO_STAGING_TIPS_DB_TOKEN` |
| Migrations | `npm run tips:db:deploy:staging` from `web/` (staging) or `npm run tips:db:deploy` (production) |

**Not** Cloudflare D1 - same libSQL-over-HTTPS pattern as subscriptions and scheduler.

## Cloudflare Turnstile

| Secret / var | Purpose |
|--------------|---------|
| `TURSO_TIPS_*` | Story tips database only |
| `TURNSTILE_SITE_KEY` | Public site key (Worker secret or var; read at SSR runtime) |
| `TURNSTILE_SECRET_KEY` | Server-side verification (`wrangler secret put`) |

Cloudflare test keys (always pass) for local/staging:

- Site: `1x00000000000000000000AA`
- Secret: `1x0000000000000000000000000000000AA`

## Public vs staging access

See **[`web/docs/STAGING_ACCESS.md`](./STAGING_ACCESS.md)** for the full policy. Summary:

| Environment | Reader routes (`PUBLIC_READER_PATHS`) |
|-------------|-------------------------------------|
| **Production** (`SITE_ACCESS_MODE=public`) | Public — anonymous readers can submit tips, subscribe to push, etc. |
| **Staging** (`SITE_ACCESS_MODE=locked`) | **Login required** — `isPublicReaderPath()` returns false for every path |

On staging, reader submission routes are **not** exempt from the site lock. Test tips by signing in at `/` first, then open `/submit-a-tip`. Production keeps anonymous tip submission for real readers.

Enforcement uses `authorizeReaderApiRequest` / `requireReaderPageSession` in `web/src/lib/editorial-session.ts` — do not bypass with ad-hoc checks.

## Build provenance

Set at **build** time (before `npm run build` / worker deploy):

- `FT_BUILD_COMMIT_SHA` - Git commit SHA shown on `/tip-source` and `/submit-a-tip`
- `GITHUB_REPOSITORY` - defaults to `cultpodcasts/freedomtimes`

## Privacy

- Anonymous story tips: body only; no contact fields stored; handler does not log IP.
- Update the EmDash **privacy policy** CMS page with copy from `web/docs/PRIVACY_POLICY_READER_SUBMISSIONS.md` when ready to go live.

## Tips desk (admin UI)

Reader tips are **not** in EmDash. Operators with the Auth0 **`tips`** role (or **`admin`**) triage them at:

| Item | Value |
|------|--------|
| UI | `/admin/tips` |
| List API | `GET /api/admin/story-tips?status=new` |
| Update API | `PATCH /api/admin/story-tips/:id` with `{ "status": "reviewed" \| "archived" \| "new", "internalNotes": "..." }` |
| Auth | Auth0 session cookie (`ft_session`); CSRF header `X-CSRF-Token` on mutations |
| Roles | `tips` (tips desk only) or `admin` (full access including tips) |
| Enforcement | `requireTipsSession` / `authorizeTipsApiRequest` (`web/src/lib/tips-session.ts` → `admin-session.ts`); **401** without session, **403** with wrong role |

**Editors** (`editor` role) do **not** get tips desk access unless they are also assigned `tips` or `admin`.

### Auth0 setup

1. Apply Terraform in `infra/terraform/environments/auth0-shared` - adds API scope `tips:manage`, role `tips`, and grants `tips:manage` to `admin`.
2. In Auth0 Dashboard → User Management → Users, assign the **`tips`** role to tip-desk staff (or use **`admin`** for editors who should see everything).
3. Tips-only users sign in via `/auth/login` and land on `/admin/tips`. They do not get EmDash CMS access.

There is **no email or push alert** to tip-desk staff when a new tip arrives (see below). Check `/admin/tips` manually or poll the list API.

### Workflow fields (migration `20260703_add_story_tips_workflow.sql`)

| Column | Purpose |
|--------|---------|
| `status` | `new`, `reviewed`, or `archived` |
| `internal_notes` | Staff-only notes (not shown to submitters) |
| `reviewed_at` | ISO timestamp when status left `new` |
| `reviewed_by` | Display name from Auth0 session |

Apply after backup:

```powershell
cd web
npm run tips:db:deploy              # production (default)
npm run tips:db:deploy:staging      # staging only - always use for staging work
```

For subscriptions diagnostics migration on staging, use `npm run subscriptions:db:migrate:staging` (not the unqualified script when `.env.dev` has production URLs set).

### Notifications (not implemented)

Push notifications on this site are **reader** article alerts only (`scheduler-worker`). There is no transactional email service wired up. Options for a later iteration:

| Option | Effort | Fit |
|--------|--------|-----|
| Poll `/admin/tips` or list API | Low | MVP - current approach |
| Email via Cloudflare Email / Resend | Medium | Needs new infra + Auth0 user email lookup |
| Separate editor Web Push channel | High | Editors would subscribe separately from readers |
| Slack/webhook from `persistStoryTip` | Medium | Good for small teams |

## Local staging rollout (GitHub CI unavailable)

When **GitHub Actions deploys are broken or untrusted**, use **local PowerShell + wrangler + Terraform only**. Do **not** rely on `gh workflow run`, pushes to `main`, or CI to apply tips infra or deploy the Worker.

### Local paths (no GitHub)

| Step | Command / script | Needs GitHub? |
|------|------------------|---------------|
| Staging Terraform (creates tips Turso DB + token) | `pwsh scripts/terraform-run.ps1 -Environment staging -Operation apply -LoadEnvFiles -AutoApprove` | No |
| Auth0 `tips` role / scope (once) | `pwsh scripts/terraform-run.ps1 -Environment auth0-shared -Operation apply -LoadEnvFiles -AutoApprove` | No |
| Write Turso URLs into `.env.dev` | `pwsh scripts/sync-staging-turso-env-dev.ps1` | No |
| Tips DB migrations | `cd web; npm run tips:db:deploy:staging` | No |
| Subscriptions diagnostics (if needed) | `cd web; npm run subscriptions:db:migrate:staging` | No |
| Push secrets to Cloudflare Workers | `pwsh scripts/set-github-secrets.ps1 -SyncCloudflareWorkerSecrets -Target Staging` | No (GitHub sync is optional; this flag talks to Cloudflare API only) |
| Build + deploy web + scheduler | `pwsh scripts/deploy-staging-workers-only.ps1` | No |
| Same deploy + secret sync in one go | `pwsh scripts/deploy-staging-workers-only.ps1 -SyncCloudflareWorkerSecrets` | No |
| Full staging rebuild (Terraform + secrets + deploy) | `pwsh scripts/staging-rebuild-local.ps1` | No |
| Web Worker only (Terraform outputs for build) | `pwsh scripts/deploy-staging-worker-local.ps1` | No |
| From `web/`: npm alias for workers deploy | `npm run deploy:staging:workers` | No |

**Prerequisites in repo-root `.env.dev`:**

- **`TURSO_TOKEN_STAGING`** (preferred for staging Terraform; same as GitHub secret) or `TURSO_PLATFORM_API_TOKEN` / `TF_VAR_turso_api_token` — Turso **Platform** API token (not a database JWT).
- `TF_VAR_CLOUDFLARE_ACCOUNT_ID`, Cloudflare API token (wrangler auth), existing EmDash Turso build keys (`TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`) for `deploy-staging-workers-only.ps1`.
- After tips Terraform apply + sync: `TURSO_STAGING_TIPS_DB_URL`, `TURSO_STAGING_TIPS_DB_TOKEN`.

### Copy-paste: story tips on staging (local only)

Run from repo root `freedomtimes/` unless noted.

```powershell
# 0) One-time: Platform token for Turso provider (if staging apply was blocked)
#    Add TURSO_PLATFORM_API_TOKEN=... to .env.dev (Turso dashboard → Settings → API tokens)

# 1) Create / update staging infra including freedomtimes-tips-staging
pwsh scripts/terraform-run.ps1 -Environment staging -Operation apply -LoadEnvFiles -AutoApprove

# 2) Refresh .env.dev with tips_turso_* outputs (and other staging DB URLs)
pwsh scripts/sync-staging-turso-env-dev.ps1

# 3) Apply tips schema to staging Turso (uses --staging / TURSO_STAGING_TIPS_DB_*)
cd web
npm run tips:db:deploy:staging

# 4) Push Worker secrets (includes TURSO_TIPS_* when .env.dev has staging tips keys)
cd ..
pwsh scripts/set-github-secrets.ps1 -SyncCloudflareWorkerSecrets -Target Staging

# 5) Turnstile test keys on staging Worker (no redeploy required; takes effect on next request)
$site  = '1x00000000000000000000AA'
$secret = '1x0000000000000000000000000000000AA'
$site  | npx wrangler secret put TURNSTILE_SITE_KEY  --config .\web\wrangler.jsonc --env staging
$secret | npx wrangler secret put TURNSTILE_SECRET_KEY --config .\web\wrangler.jsonc --env staging

# 6) Deploy code (uncommitted local tree is fine)
$env:FT_BUILD_COMMIT_SHA = (git rev-parse HEAD)
$env:GITHUB_REPOSITORY = 'cultpodcasts/freedomtimes'
pwsh scripts/deploy-staging-workers-only.ps1

# 7) Verify
npx wrangler secret list --config .\web\wrangler.jsonc --env staging
# Expect: TURSO_TIPS_DATABASE_URL, TURSO_TIPS_AUTH_TOKEN, TURNSTILE_SITE_KEY, TURNSTILE_SECRET_KEY
# Sign in at / first — staging requires login for all content
curl -sI https://staging.freedomtimes.news/submit-a-tip
# Expect login wall when no session cookie
curl -sI https://staging.freedomtimes.news/admin/tips
```

**Auth0 tips desk:** after `auth0-shared` apply, assign the `tips` role in the Auth0 dashboard. CI is not required.

**~~Do not use when CI is down:~~** ~~`gh workflow run terraform-staging.yml`~~, ~~merge to `main` expecting deploy~~, ~~`set-github-secrets.ps1` without `-SyncCloudflareWorkerSecrets` only (that path syncs GitHub repo secrets, not Workers)~~.

### Staging demo checklist (local)

Sign in at `https://staging.freedomtimes.news/` with an **editor** or **admin** Auth0 account before testing reader routes.

| Item | Status signal |
|------|----------------|
| Login wall | Anonymous `GET /submit-a-tip` → login wall (`/`); after sign-in → HTTP 200 |
| Turnstile | Form shows widget; submit enabled (not “Human verification is not configured”) |
| Tips Turso | `TURSO_TIPS_*` in `wrangler secret list --env staging` |
| End-to-end submit | While signed in, POST `/api/story-tips` succeeds; row in tips DB / visible at `/admin/tips` |
| Build provenance | `/tip-source` (signed in) shows commit SHA (not `unknown`) after setting `FT_BUILD_COMMIT_SHA` at build |

### Error-state previews (staging / dev only)

Sign in on staging first, then open these URLs. Submit the form (Turnstile + valid tip text) to trigger the simulated error. The form **POSTs to `/api/story-tips` for real**; the server returns a simulated HTTP error and **does not persist** the tip.

| URL | What you see | Server response | Real scenario it mirrors |
|-----|----------------|-----------------|---------------------------|
| `/submit-a-tip?simulate=expected-error` | Red banner “Your tip was not sent” | **400** `{ error }` for invalid payload (short body, missing contact, bad email); **403** `{ error }` Turnstile message when payload is valid | Validation failures and Turnstile rejection |
| `/submit-a-tip?simulate=unexpected-error` | Darker red banner “Something went wrong” | **500** `{ error: "We couldn't send your tip. Please try again." }` | DB/persist failure, unexpected server error |

How it works:

- Page URL `?simulate=` enables preview mode (banner only). On submit, the client includes `"_simulate": "expected-error"` or `"unexpected-error"` in the JSON POST body.
- `/api/story-tips` checks staging gating via `allowStoryTipSimulateMode(request.url)`. When allowed, it strips `_simulate`, skips Turnstile verification and DB writes, and returns the simulated status + JSON error.
- On **production**, `_simulate` in the POST body is stripped and ignored — normal validation, Turnstile, and persist run.

Gating (staging-only; **disabled on production unconditionally**):

- **Enabled** when `import.meta.env.DEV` (local), or staging is detected (`SITE_ACCESS_MODE=locked`, or hostname `staging.freedomtimes.news`).
- **Disabled** when production is detected (`SITE_ACCESS_MODE=public`, or hostname `freedomtimes.news` / `www.freedomtimes.news`). On production, `?simulate=` is ignored silently — no preview banner, normal form submit; `_simulate` in POST body is ignored.
- `FT_TIP_ERROR_PREVIEW` is not used (removed to avoid accidental enablement via worker secrets).

Client error handling (`submit-a-tip.astro`): expected statuses **400 / 403 / 429** show the server’s plain-language `error` string; **401** (expired staging session) prompts re-login; **500+** and fetch failures use `STORY_TIP_UNEXPECTED_ERROR_DETAIL` without exposing stack traces.

## First-time rollout checklist

1. **Backup** - not applicable until DB exists; after first create, export before schema changes.
2. **Terraform apply** - creates `freedomtimes-tips-staging` / `freedomtimes-tips-production`. Local apply needs `TURSO_PLATFORM_API_TOKEN` in `.env.dev` (Turso dashboard → Settings → API tokens), not a database JWT.
3. **Sync env** - `pwsh scripts/sync-staging-turso-env-dev.ps1` (or production sync).
4. **Migrate** - `cd web && npm run tips:db:deploy:staging` (staging) or `npm run tips:db:deploy` (production).
5. **Worker secrets** - `pwsh scripts/set-github-secrets.ps1 -SyncCloudflareWorkerSecrets -Target Staging` (local; does not require GitHub Actions).
6. **Turnstile** - staging test keys via wrangler (above) or production widget keys from Cloudflare dashboard.
7. **Deploy web Worker** - `pwsh scripts/deploy-staging-workers-only.ps1` (local); verify `/submit-a-tip` and `/tip-source`.
