# Push notifications — start here

Operator guide for testing browser and native push delivery on Freedom Times. Use this page to pick a workflow; follow links for env keys, script flags, and production browser matrices.

---

## Documentation map

| Doc | Use when |
|-----|----------|
| **[PUSH_NOTIFICATIONS_OPERATOR.md](./PUSH_NOTIFICATIONS_OPERATOR.md)** | `.env.dev` setup (sync scripts, var names, common mistakes), every `subscriptions:*` npm script, `shared/push` module, local vs worker architecture |
| **[MULTI_BROWSER_PRODUCTION_PUSH_TEST.md](./MULTI_BROWSER_PRODUCTION_PUSH_TEST.md)** | Production multi-browser session on `https://freedomtimes.news` (June 15 slug example, like-for-like payload guarantee, per-browser checklist) |
| [CONTENT_PROMOTION_RUNBOOK.md](../CONTENT_PROMOTION_RUNBOOK.md) | Turso backups before mutating subscriptions DB |
| [LOCAL_DEV_REQUIREMENTS.md](../../LOCAL_DEV_REQUIREMENTS.md) | Android Capacitor build, Firebase config, JDK/SDK for native app testing |

All operator scripts run from **`web/`** and load repo-root **`.env.dev`** (see OPERATOR Section A).

---

## Table of contents

- [Running notification code locally](#running-notification-code-locally)
- [Delivery paths (web, Android, iOS)](#delivery-paths-web-android-ios)
- [Quick start — pick a path](#quick-start--pick-a-path)
- [Staging cross-browser test plan](#staging-cross-browser-test-plan)
- [Production multi-browser](#production-multi-browser)
- [Like-for-like scheduler payload](#like-for-like-scheduler-payload)
- [Troubleshooting](#troubleshooting)
- [Scheduler logs](#scheduler-logs)

---

## Running notification code locally

You do **not** need `wrangler dev` or a deployed scheduler to test delivery. Operator scripts run on **Node.js** on your machine and call the same shared delivery code the production scheduler uses.

### One-time setup

```powershell
# Repo root — refresh Turso + push keys into .env.dev
pwsh scripts/sync-staging-turso-env-dev.ps1
pwsh scripts/sync-production-turso-env-dev.ps1   # optional; required for --target production

cd web
npm install
cd ../shared/push && npm install && cd ../../web

npm run subscriptions:env-keys
npm run subscriptions:compare-vapid-keys -- staging --origin https://staging.freedomtimes.news/posts/weekly-summary-22-june-2026
```

### What runs where

```
Browser subscribe (staging/production site)
    → web Cloudflare Worker (PUSH_SUBSCRIBE_PUBLIC_KEY) → Turso push_subscriptions

Scheduler cron (every 10 min, Cloudflare Worker, nodejs_compat)
    → queue consumer → shared/push deliverPushNotification → VAPID / FCM / APNs

Operator send-test (Node on your machine)
    → reads .env.dev → maps keys to worker shape → same shared/push deliverPushNotification
```

| Runtime | Entry | Shared module | Crypto for Web Push |
|---------|-------|---------------|-------------------|
| **Local send-test** | `web/scripts/send-test-push-notification.mjs` | `shared/push/deliverPushNotification.mjs` | `globalThis.crypto` or `node:crypto` fallback |
| **Scheduler worker** | `scheduler-worker/src/scheduler.ts` queue consumer | TypeScript copy of same module | Worker `globalThis.crypto` (`nodejs_compat` in `scheduler-worker/wrangler.jsonc`) |
| **Web worker** | Subscribe API only — no outbound push | — | Browser `PushManager` |

**Key point:** `subscriptions:send-test` signs and delivers with credentials from **`.env.dev` only** — it does not read Cloudflare secrets at runtime. If cron works but send-test fails, compare `.env.dev` with worker secrets (`subscriptions:compare-vapid-keys`, `set-github-secrets.ps1`).

Install `shared/push` deps before first send-test (`cd shared/push && npm install`). The scheduler worker keeps a TypeScript mirror of the shared module; after changing `shared/push/`, sync the worker copy.

### Typical local test loop

```powershell
cd web
npm run subscriptions:inspect -- staging
npm run subscriptions:list -- staging --web --active
# subscribe in browser, copy newest id
npm run subscriptions:send-test -- --target staging --subscription-id <uuid> --slug weekly-summary-22-june-2026
npm run subscriptions:inspect -- staging   # confirm last_success_at
```

Full script reference (all flags, env per platform): **[PUSH_NOTIFICATIONS_OPERATOR.md](./PUSH_NOTIFICATIONS_OPERATOR.md) Section B**.

---

## Delivery paths (web, Android, iOS)

`subscriptions:send-test` routes by `subscription_json.platform` in Turso — same as the scheduler queue consumer.

| Platform | Stored shape | Credentials (`.env.dev` → worker secrets) | `--target` notes |
|----------|--------------|-------------------------------------------|------------------|
| **web** | `endpoint` + `keys.p256dh` / `keys.auth` | `PUSH_*_SUBSCRIBE_PUBLIC_KEY` (subscribe) + `PUSH_*_VAPID_PRIVATE_KEY` (send) | Staging or production — must match subscribe origin |
| **android** | `token` (FCM) | `PUSH_PRODUCTION_ANDROID_FCM_*` → worker `PUSH_ANDROID_FCM_*` | **Production only** — staging scheduler has no FCM; Android rows live in production subscriptions DB |
| **ios** | `token` (APNs) | `PUSH_STAGING_IOS_APNS_*` (sandbox) or `PUSH_PRODUCTION_IOS_APNS_*` | Staging → `api.sandbox.push.apple.com`; production → `api.push.apple.com` |

**Web browsers:** Chrome, Edge, Firefox (desktop + Android), Safari macOS, Safari iOS PWA (16.4+, Home Screen). Endpoint prefix cheat sheet is in the staging checklist below and in [MULTI_BROWSER_PRODUCTION_PUSH_TEST.md](./MULTI_BROWSER_PRODUCTION_PUSH_TEST.md).

**Native apps:** Capacitor Android/iOS register FCM/APNs tokens into the **production** subscriptions DB. Use `--target production` with the app's subscription `id`. Android local build requirements: [LOCAL_DEV_REQUIREMENTS.md](../../LOCAL_DEV_REQUIREMENTS.md).

---

## Quick start — pick a path

### A — Staging web push (first time)

1. Sync staging Turso: `pwsh scripts/sync-staging-turso-env-dev.ps1`
2. Compare VAPID: `npm run subscriptions:compare-vapid-keys -- staging`
3. Subscribe on `https://staging.freedomtimes.news` → Reader Alerts → Enable
4. `npm run subscriptions:list -- staging --web --active` → copy `id`
5. `npm run subscriptions:send-test -- --target staging --subscription-id <uuid> --slug <post-slug>`

Continue with the [staging cross-browser checklist](#staging-cross-browser-test-plan) before promoting to production.

### B — Production multi-browser (immediate send-test)

Full runbook: **[MULTI_BROWSER_PRODUCTION_PUSH_TEST.md](./MULTI_BROWSER_PRODUCTION_PUSH_TEST.md)**.

Pinned test article: `weekly-summary-15-june-2026`. Production scheduler waits **30 minutes** after `publishedAt`; send-test bypasses that delay.

```powershell
pwsh scripts/sync-production-turso-env-dev.ps1
cd web
npm run subscriptions:compare-vapid-keys -- production
npm run subscriptions:list -- production --web --active
npm run subscriptions:send-test -- --target production --subscription-id <uuid> --slug weekly-summary-15-june-2026 --dry-run
npm run subscriptions:send-test -- --target production --subscription-id <uuid> --slug weekly-summary-15-june-2026
```

### C — Native Android / iOS

```powershell
npm run subscriptions:inspect -- production
npm run subscriptions:send-test -- --target production --subscription-id <uuid> --slug weekly-summary-15-june-2026
```

Requires `PUSH_PRODUCTION_ANDROID_FCM_*` or `PUSH_PRODUCTION_IOS_APNS_*` in `.env.dev` (see OPERATOR Section A).

---

## Staging cross-browser test plan

Use staging **before** promoting a post to production. Staging uses **immediate** notification eligibility (`PUBLISH_NOTIFICATION_DELAY_MINUTES=0`) and polls every **10 minutes**.

### 0. One-time setup

```powershell
cd web
npm run subscriptions:env-keys
npm run subscriptions:compare-vapid-keys -- staging --origin https://staging.freedomtimes.news/posts/weekly-summary-22-june-2026
```

If compare-vapid-keys mismatches `.env.dev` vs deployed `data-public-key`, fix secrets and redeploy web + scheduler workers before subscribing.

### 1. Subscribe on each browser/device

Use a **private/incognito** window per desktop browser.

| # | Device / browser | Manual steps |
|---|------------------|--------------|
| 1 | Windows **Chrome** | Post → **Reader Alerts** → **Enable** → Allow. DevTools → Application → Service Workers active. |
| 2 | Windows **Edge** | Same; permission bell at address-bar end. |
| 3 | Windows **Firefox** | Same; if blocked: `about:preferences#privacy` → Notifications. |
| 4 | **Chrome Android** | Same on `https://staging.freedomtimes.news`. |
| 5 | **Firefox Android** | Mozilla push endpoint; same Enable flow. |
| 6 | **Safari macOS** | Safari 16+ → Enable → Allow. |
| 7 | **Safari iOS** | iOS 16.4+; may need Add to Home Screen. Not the native Capacitor app. |

### 2. Capture subscription IDs

```powershell
npm run subscriptions:inspect -- staging
npm run subscriptions:list -- staging --web --active
```

| Column | Use |
|--------|-----|
| `id` | `--subscription-id` for send-test |
| `endpoint_prefix` | Browser fingerprint (see below) |
| `user_agent` | Match device you just used |
| `active` | Must be `1` |

| Browser | Typical `endpoint_prefix` |
|---------|---------------------------|
| Chrome (desktop + Android) | `https://fcm.googleapis.com/fcm/send/` |
| Edge (Chromium) | `https://wns2-`…`.notify.windows.com/` |
| Firefox | `https://updates.push.services.mozilla.com/` |
| Safari | `https://web.push.apple.com/` |

### 3. Test checklist

| Browser / device | Subscribed? | Subscription `id` | send-test OK? | Tap opens post? | Notes |
|------------------|-------------|---------------------|---------------|-----------------|-------|
| Chrome Win | ☐ | | ☐ | ☐ | |
| Edge Win | ☐ | | ☐ | ☐ | |
| Firefox Win | ☐ | | ☐ | ☐ | |
| Chrome Android | ☐ | | ☐ | ☐ | |
| Firefox Android | ☐ | | ☐ | ☐ | |
| Safari macOS | ☐ | | ☐ | ☐ | |
| Safari iOS | ☐ | | ☐ | ☐ | Home Screen if Enable disabled |

### 4. Send test per row

`--target` must match the origin you subscribed on.

```powershell
npm run subscriptions:send-test -- --target staging --subscription-id <uuid> --slug weekly-summary-22-june-2026
npm run subscriptions:send-test -- --target staging --subscription-id <uuid> --dry-run   # payload only
```

After each send: OS notification within seconds; tap opens the post. Confirm `last_success_at` in list output.

**Service worker tap:** If notification arrives but tap does nothing, hard-refresh and confirm updated `service-worker.js` is deployed.

### 5. Optional — scheduler path

Publish or reset a staging post, wait up to 10 minutes, confirm cron delivery to all subscribed browsers.

```powershell
# backup subscriptions DB first (CONTENT_PROMOTION_RUNBOOK)
npm run subscriptions:reset-sent-article -- --article-id <slug> --target staging
```

---

## Production multi-browser

**Full runbook:** [MULTI_BROWSER_PRODUCTION_PUSH_TEST.md](./MULTI_BROWSER_PRODUCTION_PUSH_TEST.md) — incremental one-browser-at-a-time loop, session checklist, VAPID alignment, optional cron verification.

Short version after staging passes:

1. Promote post to production EmDash.
2. Subscribe on `https://freedomtimes.news` (production DB is separate from staging).
3. `npm run subscriptions:inspect -- production`
4. Per-browser send-test with `--target production` and `--slug <post-slug>`.

---

## Like-for-like scheduler payload

With `--slug`, `--article <slug>`, or `--article-id`, **send-test builds the same notification packet as the scheduler**:

| Step | Scheduler (cron) | send-test (operator) |
|------|------------------|----------------------|
| Feed | `GET {siteOrigin}/api/recent-published-posts.json` | Same URL for `--target` |
| Payload | `buildArticlePushPayload(siteOrigin, post)` | **Same** `shared/push/articleNotificationPayload.mjs` |
| Delivery | `deliverToStoredTarget()` in queue consumer | **Same** `shared/push/deliverPushNotification.mjs` |

**Differs by design:** send-test targets one `--subscription-id`; scheduler fans out after the publish delay. Generic mode (no `--slug`) is **not** like-for-like — always pass `--slug` for article tests.

Details and code paths: [MULTI_BROWSER_PRODUCTION_PUSH_TEST.md](./MULTI_BROWSER_PRODUCTION_PUSH_TEST.md#like-for-like-payload-guarantee-article-mode).

---

## Troubleshooting

| Symptom | Likely cause | Action |
|---------|--------------|--------|
| `401` from push service | VAPID mismatch (subscribe public ≠ send private pair) | `npm run subscriptions:compare-vapid-keys -- <env>`; sync worker secrets; users re-subscribe |
| `410 Gone` / `No such subscription` | Stale push endpoint | Newest **active** `id` from list or `--mine`; re-subscribe; avoid `--force` on dead rows |
| `send-test` refuses `--target production` | Missing production Turso token; fell back to staging DB | `pwsh scripts/sync-production-turso-env-dev.ps1` or `node web/scripts/pull-production-turso-secrets.mjs` |
| `LibsqlError` 404 on inspect | Stale `TURSO_*_DB_TOKEN` in `.env.dev` | Re-run appropriate sync script; compare URL host to `terraform output` |
| Cron works, send-test fails | `.env.dev` credentials ≠ Cloudflare secrets | Compare VAPID; check FCM/APNs vars in OPERATOR Section A |
| `Android push delivery is not configured` | Missing FCM in `.env.dev` or `--target staging` for Android row | `--target production`; set `PUSH_PRODUCTION_ANDROID_FCM_*` |
| `iOS push delivery is not configured` | Missing APNs vars | `PUSH_PRODUCTION_IOS_APNS_*` or `PUSH_STAGING_IOS_APNS_*` |
| `FCM responded 404` / `UNREGISTERED` | Stale FCM device token | Re-open native app; pick newer active row |
| Article never notifies | Row in `sent_article_notifications` | Backup DB; `subscriptions:reset-sent-article` |
| Post not found in article mode | Slug outside latest 25 published posts | Pick another slug |
| Notification arrives, web tap does nothing | Old service worker | Hard-refresh; deploy web worker; SW should focus/navigate existing tab |
| Android tap opens app, not article | Was `clickAction: FCM_PLUGIN_ACTIVITY` without intent filter | **Fixed:** `shared/push/deliverPushNotification.mjs` omits `clickAction`; native `data.url` is absolute. Re-run send-test — no app rebuild required for server fix |
| iOS tap does nothing | Missing `url` in APNS payload | Same shared delivery sends absolute `url`; confirm `initializeNativePushBridge()` on app load |
| `Web Crypto API not available` | Node without crypto (rare) | Node 18+; `shared/push` wires `setWebCrypto` from `globalThis.crypto` or `node:crypto` |
| Subscribed on staging, tested with `--target production` | Wrong DB / VAPID pair | Match `--target` to subscribe origin |
| Button says permission on but not registered | Permission without PushManager subscribe | Click Enable again |

Env key mistakes (wrong token names, Platform API vs DB JWT): **[PUSH_NOTIFICATIONS_OPERATOR.md](./PUSH_NOTIFICATIONS_OPERATOR.md) Section A — Common mistakes**.

---

## Scheduler logs

```powershell
cd scheduler-worker
npx wrangler tail --env staging
# or --env production
```

Look for `article notification scan`, `queued N notifications`, `push delivered ok`, or `delivery failed`.
