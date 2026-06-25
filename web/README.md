# Freedom Times Web

Astro SSR app on Cloudflare Workers with EmDash CMS, Auth0 editorial auth, and optional Capacitor mobile shells.

← Project overview and doc index: [../README.md](../README.md)

---

## Operations runbooks

| Topic | Doc |
|---|---|
| Content promotion (staging → production) | [CONTENT_PROMOTION_RUNBOOK.md](CONTENT_PROMOTION_RUNBOOK.md) |
| Auth routes, cookies, staging login tests | [docs/AUTH.md](docs/AUTH.md) |
| Social images and favicons | [docs/SOCIAL_IMAGES_AND_FAVICONS.md](docs/SOCIAL_IMAGES_AND_FAVICONS.md) |
| Android builds | [docs/ANDROID_CAPACITOR_BUILD.md](docs/ANDROID_CAPACITOR_BUILD.md) |
| Worker secrets after deploy | [../scripts/set-github-secrets.md](../scripts/set-github-secrets.md) |

---

## Local development

### Environment variables

Copy `.env.example` to `.env` and set values:

```sh
AUTH0_DOMAIN=your-tenant.example-auth0.com
AUTH0_CLIENT_ID=...
AUTH0_CLIENT_SECRET=...
AUTH0_API_AUDIENCE=...
COOKIE_BASE_DOMAIN=example.com
AUTH0_ROLES_CLAIM_NAMESPACE=https://example.com
```

`wrangler dev` / Astro reads local env files directly — use pure runtime names (for example `AUTH0_DOMAIN`, not prefixed aliases). Role claim details: [docs/AUTH.md](docs/AUTH.md).

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
