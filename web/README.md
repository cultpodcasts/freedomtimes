# Freedom Times Web

Astro SSR app on Cloudflare Workers with EmDash CMS, Auth0 editorial auth, and optional Capacitor mobile shells.

← Project overview and doc index: [../README.md](../README.md)

---

## Operations runbooks

| Topic | Doc |
|---|---|
| Post-build Worker bundle patches (`patch-cloudflare-bundle.ts`) | [docs/PATCH_CLOUDFLARE_BUNDLE.md](docs/PATCH_CLOUDFLARE_BUNDLE.md) |
| Content promotion (staging → production) | [CONTENT_PROMOTION_RUNBOOK.md](CONTENT_PROMOTION_RUNBOOK.md) |
| Push notifications (local testing, scripts, `.env.dev`) | [docs/PUSH_NOTIFICATIONS_TEST_PLAN.md](docs/PUSH_NOTIFICATIONS_TEST_PLAN.md) — also [docs/PUSH_NOTIFICATIONS_OPERATOR.md](docs/PUSH_NOTIFICATIONS_OPERATOR.md), [docs/MULTI_BROWSER_PRODUCTION_PUSH_TEST.md](docs/MULTI_BROWSER_PRODUCTION_PUSH_TEST.md) |
| Auth routes, cookies, staging login tests | [docs/AUTH.md](docs/AUTH.md) |
| Social images and favicons | [docs/SOCIAL_IMAGES_AND_FAVICONS.md](docs/SOCIAL_IMAGES_AND_FAVICONS.md) |
| Android builds | [docs/ANDROID_CAPACITOR_BUILD.md](docs/ANDROID_CAPACITOR_BUILD.md) |
| Worker secrets after deploy | [../scripts/set-github-secrets.md](../scripts/set-github-secrets.md) |

---

## Local development

### Environment variables

Two local files — see **[docs/ENV_DEV.md](docs/ENV_DEV.md)** for the full setup (templates, Turso sync scripts, where each value comes from).

| File | Template | Purpose |
|------|----------|---------|
| Repo-root **`.env.dev`** | [`.env.dev.example`](../.env.dev.example) | Turso, Terraform, push operator scripts, Worker/GitHub secret sync |
| **`web/.env`** | [`.env.example`](.env.example) | Auth0 runtime vars for `npm run dev` |

```powershell
# From repo root
Copy-Item .env.dev.example .env.dev
pwsh ./scripts/sync-staging-turso-env-dev.ps1   # optional: refresh TURSO_STAGING_*

# From web/
Copy-Item .env.example .env
```

`npm run dev` reads **`web/.env`** only. EmDash also needs `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` (usually in `.env.dev` after sync) — copy into `web/.env` or use `npx dotenv-cli -e ..\.env.dev -- npm run dev`. Use pure runtime names in `web/.env` (for example `AUTH0_DOMAIN`, not `AUTH0_LOGIN_APP_CLIENT_ID_STAGING`). Role claim details: [docs/AUTH.md](docs/AUTH.md).

### Commands

Run from `web/`:

```powershell
npm install
npm run dev
npm run build
npm run preview
```

---

## Wrangler config files

Two wrangler configs exist — do not merge them:

| File | Purpose |
|---|---|
| `wrangler.build.jsonc` | Used by `npm run build` via `astro.config.mjs`. No `main` field — the Astro adapter generates `dist/server/entry.mjs` at build time. |
| `wrangler.jsonc` | Used by `npx wrangler deploy`. Has `main: "dist/server/entry.mjs"` and full `env` blocks for staging and production. |

**Never add `main` to `wrangler.build.jsonc`.**  
**Never run `npx wrangler deploy` without `--config .\web\wrangler.jsonc --env <staging|production>` from repo root.**

---

## Staging deployment

Deploy the staging Worker (matching CI):

```powershell
cd web
npx wrangler deploy --config wrangler.jsonc --env staging `
  --var "AUTH0_API_AUDIENCE:https://api.freedomtimes.news" `
  --var "COOKIE_BASE_DOMAIN:freedomtimes.news" `
  --var "AUTH0_ROLES_CLAIM_NAMESPACE:https://freedomtimes.news/roles"
```

Secrets (`AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`, Turso tokens, etc.) are set separately — see [../scripts/set-github-secrets.md](../scripts/set-github-secrets.md).

---

## Capacitor (mobile)

The site runs as a Cloudflare Worker SSR app, not a static export. Capacitor wraps a **live URL** (default `https://staging.freedomtimes.news`) rather than packaging the Worker runtime.

```powershell
cd web
$env:CAPACITOR_SERVER_URL = "https://staging.freedomtimes.news"
npm run cap:doctor
```

Spike commands: `cap:sync:android`, `cap:sync:ios`, `cap:open:android`, `cap:open:ios`. Full Android build flow: [docs/ANDROID_CAPACITOR_BUILD.md](docs/ANDROID_CAPACITOR_BUILD.md). Prerequisites: [../LOCAL_DEV_REQUIREMENTS.md](../LOCAL_DEV_REQUIREMENTS.md).

iOS requires macOS/Xcode. GitHub Actions validates both shells — see `.github/workflows/capacitor-*.yml`.

---

## Scheduler worker

Push notifications and recurring jobs run in the sibling [scheduler-worker](../scheduler-worker) project — a separate Cloudflare Worker on a 10-minute cron schedule.

```powershell
cd scheduler-worker
npx wrangler deploy --config wrangler.jsonc --env staging
```

Scheduler secrets: `TURSO_SCHEDULER_DATABASE_URL`, `TURSO_SCHEDULER_AUTH_TOKEN`. VAPID keys for push delivery:

```powershell
cd scheduler-worker
npm run push:vapid:generate -- mailto:platform@freedomtimes.news
```

### Turso SQL migrations

From `web/`:

```powershell
npm run scheduler:db:deploy
npm run subscriptions:db:deploy
```

The web worker needs `TURSO_SUBSCRIPTIONS_DATABASE_URL`, `TURSO_SUBSCRIPTIONS_AUTH_TOKEN`, and `PUSH_SUBSCRIBE_PUBLIC_KEY` (or `PUSH_STAGING_SUBSCRIBE_PUBLIC_KEY` locally). The scheduler worker needs matching VAPID delivery keys per environment. See [../ARCHITECTURE.md](../ARCHITECTURE.md) for the push architecture.

---

## Routes

See [docs/AUTH.md](docs/AUTH.md) for the full auth route table and staging login runbook.