# Outage alerts (5xx "Temporarily unavailable")

Added in PR #198. When the Worker serves a 5xx **HTML page** (the branded `src/pages/500.astro`,
its content-store-down 503 variant, an EmDash 503, or a thrown middleware error), `src/middleware.ts`
schedules `sendOutageAlert` with `waitUntil`. The visitor's response is never delayed or changed.

| Piece | File |
| --- | --- |
| Policy, dedupe key, message text (pure, unit tested) | `src/lib/outage-alert.ts` |
| KV dedupe, email + push delivery | `src/lib/outage-alert-server.ts` |
| Hook | `src/middleware.ts` (`onRequest` → `scheduleOutageAlert`) |
| Tests | `scripts/test-outage-alert.mts` |

## What triggers an alert

- Status 500–599, method GET/HEAD, `content-type: text/html`.
- Not `/api/*` or `/_emdash/api/*` (JSON endpoints have their own error handling).
- Environment: **production only by default**. Set the Worker var `OUTAGE_ALERTS=on` to also alert
  from staging, or `OUTAGE_ALERTS=off` to mute production.

## Dedupe / rate limit

At most **one alert per environment every 10 minutes**: KV `SESSION` key
`ft-outage-alert:v1:<environment>` (TTL 600 s) plus a per-isolate timestamp. If KV fails, the alert
still goes out (better a duplicate than silence).

## Channels

1. **Email (primary, works with Turso down).** Uses the existing Cloudflare Email Sending binding
   `EMAIL` (`send_email`, sender `noreply@freedomtimes.news`). Recipients: Worker secret
   `OUTAGE_ALERT_EMAIL_TO` (comma separated). It is a secret, not a `vars` entry, because this repo is
   public. Until it is set, every alert logs
   `[ft-outage-alert] NOT SENT by email: OUTAGE_ALERT_EMAIL_TO is not set` and nothing is emailed.
   Each recipient has to be an address Cloudflare Email Sending can deliver to (the same rules as
   the EmDash magic-link email).
2. **App / web push to admins (best effort).** Worker var or secret `OUTAGE_ALERT_PUSH_USER_IDS`
   (comma separated Auth0 `sub`s, e.g. `google-oauth2|1234…`) plus the existing push credentials
   (`PUSH_VAPID_*`, `PUSH_ANDROID_FCM_*`, `PUSH_IOS_APNS_*`, or the `PUSH_PRODUCTION_*`
   fallbacks). The device list comes from the **subscriptions DB, which is on Turso**, so this
   channel is down while Turso is blocked. A failure is logged (`push failed (subscriptions DB on
   Turso)`) and never blocks the email. The notification opens `/admin`.
   **Currently inert:** push is skipped while the `notifications` feature switch is off
   (`NOTIFICATIONS_ENABLED=off`, see `FEATURE_SWITCHES.md`), and `push_subscriptions.user_id` is not
   recorded yet, so no device can match an Auth0 `sub`. Making this work needs a follow-up that
   stores the signed-in user's `sub` with each subscription. Use email until then.

## Setup (production)

```powershell
cd web
npx wrangler secret put OUTAGE_ALERT_EMAIL_TO --env production   # e.g. you@example.com
# optional push:
npx wrangler secret put OUTAGE_ALERT_PUSH_USER_IDS --env production
```

Every alert is also logged (`[ft-outage-alert] 5xx served`) and can be read with `wrangler tail`.

## Test email (admin)

`/admin/outage-alerts` (admin role; tile "Outage alerts" on `/admin`) shows whether real alerts are on,
how many recipients are configured, and has a **Send test alert email** button. It calls
`POST /api/admin/outage-alert-test`, which uses the same admin gate as the content export, plus
`X-CSRF-Token`. It sends through the **same** `EMAIL` binding, sender and `OUTAGE_ALERT_EMAIL_TO`
recipients as a real alert. The subject is
`[TEST] Freedom Times <environment> outage alert email (<host>)`. There is no push. It is limited to
one test per environment per minute, and it works even where `OUTAGE_ALERTS` is off.

The JSON response reports `recipients`, `sent`, `failed` and any Cloudflare `messageIds`. The Worker logs
`[ft-outage-alert] email accepted by Cloudflare` for each recipient.

Operators without a browser session can call the same endpoint with
`Authorization: Bearer <OUTAGE_ALERT_TEST_TOKEN>`. That optional Worker secret must be at least 32
characters; when it is unset, the bearer path is off. It can only send this fixed test email to the
configured recipients.

## Current settings

| | production | staging |
| --- | --- | --- |
| `OUTAGE_ALERTS` | default (on) | `on` (`wrangler.jsonc` var) |
| `OUTAGE_ALERT_EMAIL_TO` (secret) | `developer@freedomtimes.news` | `developer@freedomtimes.news` |
| Push (`OUTAGE_ALERT_PUSH_USER_IDS`) | unset | unset |

`developer@freedomtimes.news` is an Email Routing rule that forwards to the owner's verified mailbox.
Email Sending is enabled for `freedomtimes.news`.
