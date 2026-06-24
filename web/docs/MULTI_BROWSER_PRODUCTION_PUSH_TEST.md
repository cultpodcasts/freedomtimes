# Multi-browser production web push test — operator runbook

Use this runbook to verify **production** push delivery across desktop and mobile browsers on `https://freedomtimes.news`. It uses the same Turso rows and delivery path as the live scheduler (`subscriptions:send-test` → shared `deliverPushNotification`).

For staging-only pre-promotion checks, see [PUSH_NOTIFICATIONS_TEST_PLAN.md](./PUSH_NOTIFICATIONS_TEST_PLAN.md).

## Quick reference

| Step | Command / action |
|------|------------------|
| Subscribe | Open `https://freedomtimes.news`, enable **Reader Alerts** on each browser/device |
| Inspect DB | `cd web` → `npm run subscriptions:inspect -- production` |
| Compare VAPID | `npm run subscriptions:compare-vapid-keys -- production` |
| Send one test | `npm run subscriptions:send-test -- --target production --subscription-id <uuid> --slug <post-slug>` |
| Dry-run first | Add `--dry-run` to send-test (no delivery, prints payload) |

Production scheduler delay: **30 minutes** after `publishedAt` before cron sends. Use **send-test** for immediate verification without waiting.

---

## Prerequisites (operator machine)

1. **Repo-root `.env.dev`** with production Turso + push keys (local scripts read **only** `.env.dev`, not Cloudflare secrets directly).

   ```powershell
   pwsh scripts/sync-production-turso-env-dev.ps1
   ```

   Required keys (see `.env.dev.example`):

   | Purpose | Keys |
   |---------|------|
   | Turso subscriptions | `TURSO_SUBSCRIPTIONS_DATABASE_URL` + `TURSO_SUBSCRIPTIONS_AUTH_TOKEN` (or `TURSO_PRODUCTION_SUBSCRIPTIONS_DB_*`) |
   | Turso scheduler (inspect only) | `TURSO_SCHEDULER_DATABASE_URL` + `TURSO_SCHEDULER_AUTH_TOKEN` |
   | Web VAPID (send-test) | `PUSH_PRODUCTION_SUBSCRIBE_PUBLIC_KEY`, `PUSH_PRODUCTION_VAPID_PRIVATE_KEY`, `PUSH_PRODUCTION_VAPID_SUBJECT` |
   | Android FCM (native app rows only) | `PUSH_PRODUCTION_ANDROID_FCM_*` |
   | iOS APNs (native app rows only) | `PUSH_PRODUCTION_IOS_APNS_*` |

2. **VAPID alignment** — subscribe key on the site must match send key in `.env.dev` and scheduler worker secrets (`PUSH_SUBSCRIBE_PUBLIC_KEY` / `PUSH_VAPID_*` on Cloudflare). The live worker secrets are synced from the same production pair via `set-github-secrets.ps1`; **send-test does not read Cloudflare** — it uses `.env.dev` only.

   ```powershell
   cd web
   npm run subscriptions:compare-vapid-keys -- production
   ```

   Fingerprints of `.env.dev` public key and deployed page `data-public-key` should match.

3. **OS notifications** enabled; Focus Assist / Do Not Disturb off for the test window.

4. **Node deps** installed once:

   ```powershell
   cd web
   npm install
   cd ../shared/push && npm install && cd ../../web
   ```

---

## Step 1 — Subscribe on production (each browser/device)

Repeat for **every** browser you want in the matrix. Each browser keeps its **own** push subscription (separate Turso row).

1. Open a **private/incognito** window (clean service worker + permission state).
2. Go to `https://freedomtimes.news` (any published post is fine).
3. Scroll to **Reader Alerts** → **Enable notifications**.
4. Choose **Allow** when prompted (see browser notes below).
5. Confirm the callout shows notifications enabled for this browser.
6. Optional: DevTools → Application → Service Workers — `service-worker.js` active for `freedomtimes.news`.

**Important:** Production subscriptions live in the **production** Turso DB. Subscribing on `staging.freedomtimes.news` does **not** create rows you can test with `--target production`.

---

## Step 2 — Capture subscription IDs

From `web/`:

```powershell
# Full state (counts + scheduler job):
npm run subscriptions:inspect -- production

# Subscription rows only — best for copying IDs during a test session:
npm run subscriptions:list -- production --web --active
```

In the output, find **your** row(s):

| Column | How to use it |
|--------|----------------|
| `id` | Copy this UUID for `subscriptions:send-test --subscription-id` |
| `platform` | Should be `web` for browsers (not `android` / `ios`) |
| `endpoint_prefix` | Identifies push vendor / browser family (see table below) |
| `user_agent` | Browser + OS string from the device you just used |
| `active` | Must be `1` for send-test (unless `--force` on a dead row) |
| `created_at` | When the row was first registered — should match the minute you clicked Enable |
| `updated_at` | Bumps on re-subscribe or delivery — rows sort newest-first |

### Endpoint prefix → browser

| `endpoint_prefix` starts with | Typical browser |
|-------------------------------|-----------------|
| `https://fcm.googleapis.com/fcm/send/` or `https://fcm.googleapis.com/wp/` | Chrome, Edge (Chromium), Chrome Android |
| `https://updates.push.services.mozilla.com/` | Firefox (desktop and mobile) |
| `https://web.push.apple.com/` | Safari (macOS; iOS 16.4+ **installed PWA** only) |

If several active rows share a vendor (e.g. multiple Chrome profiles), use **`user_agent`**, **`created_at`**, and subscribe-one-browser-at-a-time, or subscribe → list → record `id` before moving to the next browser.

Alternative send-test selectors:

- `--endpoint <prefix>` — newest row whose endpoint starts with prefix
- `--mine` — only when **exactly one** active subscription exists in the DB

---

## Step 3 — Send a production-like test push

Pick a **published** post slug that appears in the recent feed (latest 25 published posts):

```powershell
npm run subscriptions:send-test -- --target production --subscription-id <uuid> --slug weekly-summary-15-june-2026
```

Article mode fetches `https://freedomtimes.news/api/recent-published-posts.json` and builds the same payload as the scheduler (title, excerpt, icon, featured image, tag `article-{id}`).

**Dry-run** (recommended first time per browser):

```powershell
npm run subscriptions:send-test -- --target production --subscription-id <uuid> --slug <slug> --dry-run
```

Expect an OS notification within seconds. Tap should open `https://freedomtimes.news/posts/<slug>`.

Re-run `npm run subscriptions:list -- production --web --active`: your row’s `last_success_at` should update.

---

## Step 4 — Fill in the browser matrix

Copy this table and complete as you test:

| Browser | Device | Subscribed? | `subscription-id` (uuid) | `endpoint_prefix` (first 40 chars) | send-test OK? | Tap opens post? | Notes |
|---------|--------|-------------|--------------------------|-------------------------------------|---------------|-----------------|-------|
| Chrome | Windows desktop | ☐ | | | ☐ | ☐ | |
| Edge | Windows desktop | ☐ | | | ☐ | ☐ | Bell icon at address-bar end |
| Firefox | Windows desktop | ☐ | | | ☐ | ☐ | Lock → Permissions |
| Chrome | Android | ☐ | | | ☐ | ☐ | Site settings if blocked |
| Firefox | Android | ☐ | | | ☐ | ☐ | |
| Safari | iOS | ☐ | | | ☐ | ☐ | Web push: PWA to Home Screen, iOS 16.4+ |

---

## Per-browser setup notes

### Desktop — Windows

| Browser | Permission gotcha | If blocked |
|---------|-------------------|------------|
| **Chrome** | Prompt near address bar or notifications icon | `chrome://settings/content/notifications` |
| **Edge** | Easy to miss — use **bell** at right end of address bar | Settings → Cookies and site permissions → Notifications |
| **Firefox** | HTTPS required | `about:preferences#privacy` → Notifications → Settings |

### Mobile

| Browser | Notes |
|---------|--------|
| **Chrome Android** | Standard Web Push; endpoint usually `fcm.googleapis.com` |
| **Firefox Android** | Mozilla endpoint; same subscribe flow on production site |
| **Safari iOS** | **Limited:** Web Push only for sites **added to Home Screen** (PWA), iOS **16.4+**. In-browser Safari tab alone may not register Web Push. Native iOS app uses APNs (`subscription_json.platform=ios`) — use same send-test with production iOS credentials, not VAPID |

---

## VAPID and credentials (production)

| Layer | Where keys live | What send-test uses |
|-------|-----------------|---------------------|
| Browser subscribe | Cloudflare web worker `PUSH_SUBSCRIBE_PUBLIC_KEY` | Compare via `subscriptions:compare-vapid-keys` |
| Delivery (web) | Scheduler `PUSH_VAPID_PUBLIC_KEY`, `PUSH_VAPID_PRIVATE_KEY`, `PUSH_VAPID_SUBJECT` | `.env.dev` `PUSH_PRODUCTION_*` (or `PUSH_VAPID_*` fallback) |
| Operator scripts | Repo-root `.env.dev` only | Never reads Wrangler secrets at runtime |

If send-test reports `401` or VAPID mismatch:

1. `npm run subscriptions:compare-vapid-keys -- production`
2. Ensure `.env.dev` production pair matches what was synced to workers
3. Re-subscribe in the browser after fixing keys (old subscription may be invalid)

`--target production` is **refused** if Turso bindings fall back to staging (missing production token). Fix with `sync-production-turso-env-dev.ps1`.

---

## Troubleshooting (production)

| Symptom | Action |
|---------|--------|
| No row after subscribe | Wrong origin (staging vs production); hard-refresh; check browser blocked notifications |
| `active=0` on send-test | Stale endpoint — re-subscribe; pick newest `active=1` row |
| `410 Gone` / `No such subscription` | Dead endpoint; do not `--force` — subscribe again |
| `401` from push service | VAPID mismatch — compare keys; sync `.env.dev` with worker secrets |
| Post not found in article mode | Slug not in latest 25 published posts — pick another slug |
| Notification arrives, tap does nothing | Update service worker (hard refresh); confirm same origin |
| Cron works but send-test fails | Usually credentials in `.env.dev`; cron uses Cloudflare secrets |
| `LibsqlError` 404 on inspect | Stale Turso token — re-run `sync-production-turso-env-dev.ps1` |

Scheduler logs:

```powershell
cd scheduler-worker
npx wrangler tail --env production
```

---

## Optional — cron path (not required for browser matrix)

After send-test passes everywhere, you can confirm the scheduler path:

1. Promote or publish a post on production EmDash.
2. Wait **30 minutes** after `publishedAt` (`PUBLISH_NOTIFICATION_DELAY_MINUTES=30`).
3. Inspect: `sent_article_notifications` gains a row; subscriptions get `last_success_at`.

To re-test cron for an already-sent article (after Turso backup per runbook):

```powershell
npm run subscriptions:reset-sent-article -- --article-id <emdash-id> --target production
```

---

## Related docs

- [PUSH_NOTIFICATIONS_TEST_PLAN.md](./PUSH_NOTIFICATIONS_TEST_PLAN.md) — staging workflow, flag reference, shared troubleshooting
- `web/scripts/inspect-push-notifications.mjs` — read-only Turso state
- `web/scripts/send-test-push-notification.mjs` — one-shot delivery test
