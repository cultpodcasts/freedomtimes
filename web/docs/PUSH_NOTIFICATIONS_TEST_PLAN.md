# Browser push notifications — test plans

**`.env.dev` + scripts reference:** [PUSH_NOTIFICATIONS_OPERATOR.md](./PUSH_NOTIFICATIONS_OPERATOR.md) — Turso/VAPID/FCM/APNs keys, sync commands, every `subscriptions:*` script, and common mistakes.

## Production multi-browser matrix (primary)

**Operator runbook:** [MULTI_BROWSER_PRODUCTION_PUSH_TEST.md](./MULTI_BROWSER_PRODUCTION_PUSH_TEST.md)

Subscribe on `https://freedomtimes.news`, capture IDs (`npm run subscriptions:list -- production --web --active`), send immediate tests:

```powershell
cd web
npm run subscriptions:send-test -- --target production --subscription-id <uuid> --slug <post-slug>
```

Covers Chrome, Edge, Firefox (desktop), Chrome/Firefox Android, and Safari iOS web-push limits. Production scheduler delay is **30 minutes**; send-test bypasses the wait.

---

## Staging cross-browser test plan

Use staging **before** promoting a post to production. **Test web push on staging first** (`https://staging.freedomtimes.news`). Staging is configured for **immediate** notification eligibility (`PUBLISH_NOTIFICATION_DELAY_MINUTES=0`) and polls every **10 minutes**.

Native Android/iOS app push uses the **production** subscriptions DB and FCM/APNs credentials — see the Android rows in inspect, but this runbook focuses on **browser web push** only.

## Quick operator runbook (web push, multi-browser)

### 0. One-time setup (operator machine)

```powershell
cd web
npm install
cd ../shared/push && npm install && cd ../../web
npm run subscriptions:env-keys          # confirm Turso + VAPID keys present
npm run subscriptions:compare-vapid-keys -- staging --origin https://staging.freedomtimes.news/posts/weekly-summary-22-june-2026
```

If compare-vapid-keys mismatches `.env.dev` vs deployed `data-public-key`, fix secrets and redeploy the web + scheduler workers before subscribing.

### 1. Subscribe on each browser/device (manual)

Use a **private/incognito** window per desktop browser so subscriptions do not collide.

| # | Device / browser | Origin | Manual steps |
|---|------------------|--------|--------------|
| 1 | Windows **Chrome** | `https://staging.freedomtimes.news` | Open any post → **Reader Alerts** → **Enable notifications** → Allow. DevTools → Application → Service Workers: `service-worker.js` active. |
| 2 | Windows **Edge** | same | Same flow; permission bell is at the address-bar end. |
| 3 | Windows **Firefox** | same | Same flow; if blocked: `about:preferences#privacy` → Notifications → Settings. |
| 4 | **Chrome Android** | same (phone) | Chrome → staging post → Enable → Allow. Keep tab or add to home screen optional. |
| 5 | **Firefox Android** | same | Supported (Mozilla push endpoint). Same Enable flow. |
| 6 | **Safari macOS** | same | Safari 16+ → Enable → Allow. Settings → Websites → Notifications if prompt missed. |
| 7 | **Safari iOS** | same | iOS **16.4+** only. Web push works for sites with a valid manifest/service worker; add to Home Screen if Enable is disabled. Not the native Capacitor app. |

After each Enable click, note the **time** (for matching `created_at` in inspect).

### 2. Capture subscription IDs (after each subscribe)

From `web/` on your operator machine:

```powershell
# Full state (counts + scheduler job):
npm run subscriptions:inspect -- staging

# Subscription rows only — best for copying IDs during a test session:
npm run subscriptions:list -- staging --web --active
```

**Find your row** (newest `updated_at` / `created_at` right after you subscribed):

| Column | How to use it |
|--------|----------------|
| `id` | Copy this UUID into send-test `--subscription-id` |
| `platform` | Should be `web` for browsers (not `android` / `ios`) |
| `endpoint_prefix` | Push service fingerprint — see table below |
| `user_agent` | Browser + OS string from the device you just used |
| `created_at` | Should match the minute you clicked Enable |
| `active` | Must be `1` for send-test (inactive = stale endpoint) |

**Endpoint prefix cheat sheet (web only):**

| Browser | Typical `endpoint_prefix` starts with |
|---------|--------------------------------------|
| Chrome (desktop + Android) | `https://fcm.googleapis.com/fcm/send/` |
| Edge (Chromium on Windows) | `https://wns2-`…`.notify.windows.com/` (WNS, not FCM) |
| Firefox (desktop + Android) | `https://updates.push.services.mozilla.com/` |
| Safari (macOS + iOS web) | `https://web.push.apple.com/` |

### 3. Test checklist — fill in as you go

| Browser / device | Subscribed? | Subscription `id` (staging) | send-test OK? | Tap opens post? | Notes |
|------------------|-------------|----------------------------|---------------|-----------------|-------|
| Chrome Win | ☐ | | ☐ | ☐ | |
| Edge Win | ☐ | | ☐ | ☐ | |
| Firefox Win | ☐ | | ☐ | ☐ | |
| Chrome Android | ☐ | | ☐ | ☐ | |
| Firefox Android | ☐ | | ☐ | ☐ | |
| Safari macOS | ☐ | | ☐ | ☐ | |
| Safari iOS | ☐ | | ☐ | ☐ | iOS 16.4+; may need Home Screen |

### 4. Send test push to each captured ID

**Rule:** `--target` must match the origin you subscribed on. Staging subscribe → `--target staging`. Production subscribe → `--target production`.

VAPID keys must match: the public key on the page (`PUSH_*_SUBSCRIBE_PUBLIC_KEY` / worker `PUSH_SUBSCRIBE_PUBLIC_KEY`) and the private key used by send-test / scheduler (`PUSH_*_VAPID_PRIVATE_KEY` / worker `PUSH_VAPID_PRIVATE_KEY`) must be the **same pair** for that environment.

```powershell
cd web

# Generic connectivity (fast — no featured image):
npm run subscriptions:send-test -- --target staging --subscription-id <chrome-win-uuid>

# Production-like article payload (same builder as scheduler):
npm run subscriptions:send-test -- --target staging --subscription-id <edge-win-uuid> --slug weekly-summary-22-june-2026

# Repeat per row — examples with placeholders:
npm run subscriptions:send-test -- --target staging --subscription-id <firefox-win-uuid>
npm run subscriptions:send-test -- --target staging --subscription-id <chrome-android-uuid> --slug weekly-summary-22-june-2026
npm run subscriptions:send-test -- --target staging --subscription-id <firefox-android-uuid>
npm run subscriptions:send-test -- --target staging --subscription-id <safari-macos-uuid> --slug weekly-summary-22-june-2026
npm run subscriptions:send-test -- --target staging --subscription-id <safari-ios-uuid>

# Dry-run (no send — confirms platform + payload):
npm run subscriptions:send-test -- --target staging --subscription-id <uuid> --dry-run

# When exactly one active row in DB:
npm run subscriptions:send-test -- --target staging --mine

# Match by endpoint prefix instead of id:
npm run subscriptions:send-test -- --target staging --endpoint https://updates.push.services.mozilla.com/
```

After each send: OS notification within seconds; **tap** should open the post on the same origin. Re-run `npm run subscriptions:list -- staging --web --active` — `last_success_at` should update.

**Service worker tap fix:** If notification arrives but tap does nothing, hard-refresh staging and confirm an updated `service-worker.js` is deployed (navigate/focus existing tab). Deploy web worker to staging/production before tap testing if you are on an older build.

### 5. Optional — scheduler path (no send-test)

After all direct sends pass, optionally verify cron delivery: publish or reset a staging post, wait up to 10 minutes, confirm all subscribed browsers receive it.

---

## Inspect / list commands

| Command | Purpose |
|---------|---------|
| `npm run subscriptions:inspect -- staging` | Counts, recent subs, sent articles, scheduler job (default target: **staging**) |
| `npm run subscriptions:inspect -- production` | Same for production DB |
| `npm run subscriptions:list -- staging --web --active` | Subscription table only; web browsers, active rows |
| `npm run subscriptions:list -- staging --limit 50` | More rows |

Flags for both inspect and list: `--web`, `--active`, `--limit N`, `--list` (list-only mode; also available via `subscriptions:list` npm script).

## Env keys (from sync scripts)

See **[PUSH_NOTIFICATIONS_OPERATOR.md](./PUSH_NOTIFICATIONS_OPERATOR.md) Section A** for the full variable table, sync commands, worker secret mapping, FCM/APNs fallbacks, and common mistakes.

Quick refresh:

```powershell
pwsh scripts/sync-staging-turso-env-dev.ps1
pwsh scripts/sync-production-turso-env-dev.ps1
cd web
npm run subscriptions:env-keys
```

## Prerequisites

1. Staging site loads at `https://staging.freedomtimes.news` (login if `SITE_ACCESS_MODE=locked`).
2. Scheduler worker deployed: `freedomtimes-scheduler-staging` with VAPID + Turso secrets (see `web/README.md`).
3. Operator machine: Windows notifications enabled; Focus Assist / Do Not Disturb off for the test window.

## Inspect current state (optional)

From `web/` with staging or production Turso credentials in `.env.dev`:

```powershell
npm run subscriptions:inspect -- staging
npm run subscriptions:list -- staging --web --active
```

Check `push_subscriptions` (active rows, **`id`** column), `sent_article_notifications`, and `scheduler_jobs.last_error`. See **Quick operator runbook** above for identifying your row.

## Direct test push (one subscription, same delivery path as scheduler)

Use this to debug delivery and click-to-open without waiting for cron or publishing a post. The script routes by `subscription_json.platform`:

- **web**: VAPID + `webpush-webcrypto` (same as scheduler queue consumer)
- **android**: FCM HTTP v1 (same sender as scheduler; production credentials only)
- **ios**: APNs HTTP/2 (same sender as scheduler; sandbox on staging, production on production)

Prerequisites in `.env.dev` for the target environment:

- Turso subscriptions DB URL + token (`TURSO_STAGING_SUBSCRIPTIONS_DB_*` or production equivalents)
- **Web**: VAPID delivery keys (`PUSH_STAGING_VAPID_PRIVATE_KEY`, `PUSH_STAGING_SUBSCRIBE_PUBLIC_KEY`, `PUSH_STAGING_VAPID_SUBJECT` — or production `PUSH_PRODUCTION_*`)
- **Android (production)**: `PUSH_PRODUCTION_ANDROID_FCM_PROJECT_ID`, `PUSH_PRODUCTION_ANDROID_FCM_CLIENT_EMAIL`, `PUSH_PRODUCTION_ANDROID_FCM_PRIVATE_KEY`
- **iOS**: `PUSH_PRODUCTION_IOS_APNS_*` or `PUSH_STAGING_IOS_APNS_*` (all four: team id, key id, private key, bundle id)

```powershell
cd web
npm install
cd ../shared/push && npm install && cd ../../web
npm run subscriptions:inspect -- staging
# Copy the **newest active** `id` for your browser (same endpoint family can have multiple rows; stale Mozilla rows go active=0 after 410)

npm run subscriptions:compare-vapid-keys -- staging --origin https://staging.freedomtimes.news/posts/weekly-summary-22-june-2026

# Production-like article notification (title, excerpt, icon, featured image, tag article-{id} — same payload as scheduler):
npm run subscriptions:send-test -- --target production --subscription-id <uuid> --slug weekly-summary-15-june-2026

# Production Android native app (FCM — subscription_json.platform=android):
npm run subscriptions:send-test -- --target production --subscription-id 4cbb430e-2b24-4052-9f6b-ce88b8e94ceb --slug weekly-summary-15-june-2026

# Production iOS native app (APNs):
npm run subscriptions:send-test -- --target production --subscription-id <ios-uuid> --slug weekly-summary-15-june-2026

# Staging article test (web or iOS sandbox):
npm run subscriptions:send-test -- --target staging --subscription-id <uuid> --slug weekly-summary-22-june-2026
# Or by EmDash entry id:
npm run subscriptions:send-test -- --target staging --mine --article-id <emdash-post-id>
# --article <slug> is an alias for --slug

# Generic connectivity test only (no featured image; warns if you pass --url/--title):
npm run subscriptions:send-test -- --target staging --subscription-id <uuid>

# Dry-run (platform + payload, no send):
npm run subscriptions:send-test -- --target production --subscription-id 4cbb430e-2b24-4052-9f6b-ce88b8e94ceb --slug weekly-summary-15-june-2026 --dry-run

# Or when only one active row: --mine
# Or match by push endpoint prefix: --endpoint https://fcm.googleapis.com/fcm/send/
# Inactive rows (active=0) are refused unless --force
```

### `subscriptions:send-test` flags

| Flag | Purpose |
|------|---------|
| `--target staging\|production` | Turso + push env (VAPID web; FCM/APNs native) (default `staging`) |
| `--subscription-id <uuid>` | Send to one row in `push_subscriptions` |
| `--endpoint <prefix>` | Match newest row whose endpoint starts with prefix |
| `--mine` | Send when exactly one active subscription exists |
| `--slug <post-slug>` | Article mode: fetch `{siteOrigin}/api/recent-published-posts.json` and build via shared `buildArticlePushPayload` (includes featured image when present) |
| `--article <post-slug>` | Alias for `--slug` |
| `--article-id <id>` | Article mode: match by EmDash entry id in the same feed |
| `--url`, `--title`, `--body` | Generic test mode only (warns; ignored when `--slug`, `--article`, or `--article-id` is set) |
| `--dry-run` | Print subscription + payload without sending |
| `--force` | Allow send to `active=0` rows (stale endpoints usually fail with 410) |

Article mode always uses a fixed site origin for the feed and payload icons (`https://staging.freedomtimes.news` or `https://freedomtimes.news` for production) — not `SITE_ORIGIN` from `.env.dev`. Article payloads use **absolute** `url` values (e.g. `https://freedomtimes.news/posts/<slug>`), same as the scheduler. Posts outside the latest 25 published entries are not found.

`--target production` is refused when Turso bindings fall back to the staging subscriptions DB (missing production token in `.env.dev`).

Expect OS notification within seconds. Click should open the post path on the same origin you subscribed from. Re-run inspect: `last_success_at` should update.

`--dry-run` prints payload and subscription without sending.

## Per-browser setup (repeat in Edge, Chrome, Firefox)

Each browser maintains its **own** push subscription. Test all three separately. Full multi-device checklist: **Quick operator runbook** at the top of this doc.

### 1. Open staging and subscribe

1. Open a **private/incognito** window (clean service worker + permission state).
2. Navigate to any published post on staging, e.g. `/posts/weekly-summary-22-june-2026`.
3. Scroll to **Reader Alerts** and click **Enable notifications**.
4. Choose **Allow** when the browser prompts (Edge: bell icon at address-bar end; Chrome: lock → Site settings → Notifications; Firefox: lock → Permissions).
5. Confirm the callout shows “Notifications enabled for this browser.”
6. In DevTools → Application → Service Workers: `service-worker.js` active for `staging.freedomtimes.news`.
7. In DevTools → Application → Push Messaging: subscription endpoint present.

### 2. Verify server-side registration

Re-run inspect script; `push_subscriptions` should show a new active row with recent `updated_at` and your browser’s user-agent.

### 3. Trigger a notification

**Option A — publish a new staging post**

1. Publish (or update `published_at` to now) a post in **staging** EmDash.
2. Wait up to **10 minutes** for the scheduler cron + queue consumer.
3. Expect a notification titled with the post headline.

**Option B — reset a known post (no new publish)**

1. Backup subscriptions Turso DB (runbook).
2. `node scripts/reset-sent-article-notification.mjs --article-id <post-id> --target staging`
3. Wait up to 10 minutes for the next cron tick.

### 4. Confirm delivery

- OS notification appears with correct title/body.
- Click opens the post path (`/posts/<slug>`).
- Inspect script: subscription row should have `last_success_at` updated; scheduler `last_error` should be null.

### 5. Browser-specific notes

| Browser | Gotchas |
|---------|---------|
| **Edge** | Permission prompt is easy to miss; use address-bar bell. |
| **Chrome** | Check `chrome://settings/content/notifications` if blocked. |
| **Firefox** | Requires HTTPS; check `about:preferences#privacy` → Notifications → Settings. |

## Production checklist (after staging passes)

Full step-by-step (desktop + mobile browsers, checklist table, VAPID): **[MULTI_BROWSER_PRODUCTION_PUSH_TEST.md](./MULTI_BROWSER_PRODUCTION_PUSH_TEST.md)**.

Short version:

1. Promote post to **production** EmDash.
2. Production delay is **30 minutes** after `publishedAt` before the scheduler sends (`PUBLISH_NOTIFICATION_DELAY_MINUTES=30`).
3. Subscribe on `https://freedomtimes.news` (production DB is separate from staging).
4. `npm run subscriptions:inspect -- production` — confirm subscriptions and no `last_error` on the scheduler job.
5. Per-browser send-test: `npm run subscriptions:send-test -- --target production --subscription-id <uuid> --slug <slug>`.

## Troubleshooting

| Symptom | Likely cause | Action |
|---------|--------------|--------|
| Button says permission on but not registered | Permission granted without PushManager subscribe | Click Enable again (fixed in client sync) |
| `last_error` on scheduler job | Missing VAPID/Turso/queue config | Cloudflare dashboard → worker secrets; redeploy scheduler |
| Article never notifies | Row already in `sent_article_notifications` | `reset-sent-article-notification.mjs` after backup |
| `Android push delivery is not configured` in `last_failure_reason` | Scheduler missing `PUSH_ANDROID_FCM_*` | Set `PUSH_PRODUCTION_ANDROID_FCM_*` in `.env.dev` / worker secrets |
| `send-test` refuses native Android on staging | FCM is production-only | Use `--target production` for Android app subscriptions |
| `410 Gone` / `No such subscription` on send-test | Stale push endpoint (old browser subscription row), not VAPID mismatch | Use newest **active** id from inspect or `--mine`; re-subscribe in browser; do not use `--force` on dead rows |
| `401` from push service | VAPID key mismatch between subscribe and send | `subscriptions:compare-vapid-keys`; sync `PUSH_SUBSCRIBE_PUBLIC_KEY` + scheduler `PUSH_VAPID_*` from same `.env.dev` pair |
| `Android push delivery is not configured` on send-test | Missing `PUSH_PRODUCTION_ANDROID_FCM_*` in `.env.dev`, or `--target staging` for an Android row (staging scheduler has no FCM) | Use `--target production` for Android; run `scripts/populate-android-fcm-env.ps1` or copy keys from GitHub secrets mapping |
| `iOS push delivery is not configured` on send-test | Missing `PUSH_PRODUCTION_IOS_APNS_*` or `PUSH_STAGING_IOS_APNS_*` | Set APNs key vars in `.env.dev` (same names as `set-github-secrets.ps1`) |
| `FCM responded 404` / `UNREGISTERED` | Stale FCM device token | Re-open the native app to refresh registration; inspect `push_subscriptions` for a newer active row |

| `LibsqlError: SERVER_ERROR.*404` on `subscriptions:inspect` | Stale `TURSO_STAGING_*_DB_TOKEN` in `.env.dev` (URL still matches Terraform; Turso may return 404 instead of 401) | From `infra/terraform/environments/staging`: `terraform output subscriptions_turso_database_auth_token` and `scheduler_turso_database_auth_token`; update repo-root `.env.dev`. URLs: `terraform output subscriptions_turso_database_url` |
| Staging works, production does not | Subscribed on wrong origin or prod not promoted | Subscribe on production; verify `/api/recent-published-posts.json` |
| Notification arrives but click does nothing (web) | Old service worker or no same-origin window | Hard-refresh staging, confirm `service-worker.js` updated; click should open/focus a tab (fixed: navigate existing window) |
| Android notification tap opens app but not the article | FCM `click_action: FCM_PLUGIN_ACTIVITY` without matching `MainActivity` intent filter, so `pushNotificationActionPerformed` never fires | Fixed in `shared/push/deliverPushNotification.mjs` (omit `clickAction`; native `data.url` is absolute). Re-run `subscriptions:send-test` — no app rebuild required for the server fix. Optional: rebuild Android after manifest intent-filter addition |
| iOS tap does nothing | Missing `url` in APNS custom payload or listener not registered | Same shared delivery now sends absolute `url`; confirm `initializeNativePushBridge()` runs on app load |
| Test push works, cron does not | Article already sent or post too new | `reset-sent-article-notification.mjs`; check `PUBLISH_NOTIFICATION_DELAY_MINUTES` |

## Scheduler logs

```powershell
cd scheduler-worker
npx wrangler tail --env staging
# or --env production
```

Look for `article notification scan`, `queued N notifications`, `push delivered ok`, or `delivery failed`.
