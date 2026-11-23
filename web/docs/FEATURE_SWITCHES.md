# Feature switches

Runtime on/off switches for whole features, with an admin page and an audit trail. Added in PR #198
for reader notifications while the Turso subscriptions DB is blocked.

| Piece | File |
| --- | --- |
| Registry + pure rules (precedence, parsing, audit) | `src/lib/feature-switches.ts` |
| KV I/O (override, audit, 30 s cache) | `src/lib/feature-switches-server.ts` |
| Admin list / effective state | `src/lib/feature-switch-admin.ts` |
| Admin API (`GET`, `POST {name, action}`) | `src/pages/api/admin/feature-switches.ts` |
| Admin page (tile on `/admin`) | `src/pages/admin/feature-switches.astro` |
| Tests (synthetic only) | `scripts/test-feature-switches.mts` |

## How the state is decided

1. **Admin override** (KV `SESSION`, key `ft-feature-switch:v1:<name>`), set at
   `/admin/feature-switches`. Takes effect without a deploy; each Worker isolate caches it for up to
   30 s and KV can take up to about a minute to reach every location.
2. Else the **Worker config** var (`env.<name>.vars` in `web/wrangler.jsonc`, e.g.
   `NOTIFICATIONS_ENABLED`: `on` / `off`).
3. Else the switch's **default** (in the registry).
4. **Auto-off** (only checked when 1–3 say on): a feature can turn itself off when a dependency is
   down. It never turns a switch on.

The admin page shows the effective state, which rule decided it and why, the config value, the
override (who and when), and the last 10 changes.

## Admin changes and audit

Enable / Disable write the override; **Clear override** removes it so the config applies again.
The page and the API require the admin role (same `requireAdminPageSession` /
`authorizeAdminApiRequest` gate as the other admin pages) and the API `POST` needs the
`X-CSRF-Token` header matching the `ft_csrf` cookie. Each change appends `{action, by, at, before}`
to `ft-feature-switch-audit:v1:<name>` (newest first, last 50 kept) and logs
`[feature-switch] changed` to the Worker logs. Overrides live in KV, never in Turso.

## Switch: `notifications` (`NOTIFICATIONS_ENABLED`)

Currently **off** on production and staging (23 Nov 2026) because the subscriptions DB is on Turso.
When off:

- the reader callout ("Get notified…") is not rendered;
- the web and native (Capacitor) bridges ask `GET /api/notifications-status` first and do not
  prompt, register or sync;
- `POST /api/push-subscriptions`, `/api/push-test-notification` and `/api/notification-diagnostics`
  return `503 {"error":"notifications_paused"}` (with `Retry-After`) before any Turso access;
- outage-alert push is skipped (email still goes out).

Auto-off reasons: `FT_SKIP_TURSO=1`, no `TURSO_SUBSCRIPTIONS_URL`, or a failed `SELECT 1` health
check (2 s timeout, result cached 5 min per isolate). Page renders skip the health check (config +
override only) so a render never waits on Turso; the APIs, the status endpoint and the admin page run
it, and only when the switch is otherwise on, so an "off" switch costs no Turso reads.

### Turning notifications back on (planned 1 Dec 2026)

1. Confirm the subscriptions DB is readable again (Turso quota reset).
2. Set `"NOTIFICATIONS_ENABLED": "on"` for each env in `web/wrangler.jsonc` and ship it through the
   normal GitHub deploy (staging on the PR, production on merge). Never deploy from a local machine.
3. If an override is set at `/admin/feature-switches`, press **Clear override**.
4. Check `/admin/feature-switches`: it should say **On · Worker config**. If it says
   **Automatically off**, the health check still fails.

For a quicker test, an admin can press **Enable** on staging first; the health check still keeps it
off if the DB is down.

## Adding a switch

Add an entry to `FEATURE_SWITCHES` (name, label, description, env var, default), add the env var to
`wrangler.jsonc` if you want a per-env default, and read it on the server with
`getFeatureSwitchState(name)` (`feature-switches-server.ts`). Extend
`getEffectiveSwitchState` in `feature-switch-admin.ts` if it has an auto-off rule.