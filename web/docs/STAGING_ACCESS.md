# Staging access policy

Freedom Times uses `SITE_ACCESS_MODE` to control whether anonymous readers can reach parts of the site.

| Value | Environment | Meaning |
|-------|-------------|---------|
| `public` | Production (`freedomtimes.news`) | Selected reader routes work without login |
| `locked` | Staging (`staging.freedomtimes.news`) | **Nothing is public** except EmDash internal auth |

Configured in `web/wrangler.jsonc` per Worker environment:

| Setting | Staging | Production |
|---------|---------|------------|
| `SITE_ACCESS_MODE` | `locked` (default) | `public` |
| Worker name | `freedomtimes-staging` | `freedomtimes` |

The top-level `vars` block defaults to `locked`; only the `production` env block overrides to `public`. Scheduler workers are separate: `freedomtimes-scheduler-staging` and `freedomtimes-scheduler`.

Historical Worker names (`freedomtimes-holding-staging`, `freedomtimes-holding`) were renamed — see `STAGING_RECOVERY.md` if old scripts remain in the Cloudflare dashboard.

## Hard rule: NOTHING ON STAGING IS PUBLIC

On locked staging, every HTML page and API route requires an Auth0 session **except**:

- `/_emdash/*` — EmDash CMS, OAuth, MCP (own auth; bypassed in `middleware.ts`)
- `/.well-known/*` — OAuth metadata aliases for MCP clients
- `/auth/*` — login wall must stay reachable
- `/` — staging login wall (`SecureAccessWall`)

**Never** add staging-only public exceptions. Do not add reader or editorial paths to `AUTH_BYPASS_RULES` in middleware.

## Temporary smoke test (staging → public)

For a short production-like reader test, an operator may flip staging to `SITE_ACCESS_MODE=public`:

1. **Cloudflare dashboard** — Workers & Pages → `freedomtimes-staging` → Settings → Variables → edit `SITE_ACCESS_MODE` to `public`, or
2. **Deploy** — temporarily change `env.staging.vars.SITE_ACCESS_MODE` in `web/wrangler.jsonc` and deploy staging.

While `public`, anonymous readers can reach `PUBLIC_READER_PATHS` on staging the same way as production. **Admin routes stay gated** — see below.

**Revert to `locked` when done.** The next staging deploy from the committed `wrangler.jsonc` resets to `locked` unless the file was changed. Do not leave staging on `public`.

## Production-public reader routes

These paths are anonymous on production only. They are listed in `PUBLIC_READER_PATHS` in `web/src/lib/auth.ts`:

| Path | Purpose |
|------|---------|
| `/submit-a-tip` | Story tip form |
| `/tip-source` | Handler source verification page |
| `/api/story-tips` | Tip submission API |
| `/api/tip-source.json` | Provenance JSON |
| `/api/version.json` | Deploy version JSON |
| `/api/push-subscriptions` | Reader push subscribe |
| `/api/notification-diagnostics` | Push troubleshooting reports |
| `/api/push-test-notification` | Reader test push |
| `/api/recent-published-posts.json` | Article feed for push scheduler |
| `/manifest.webmanifest` | PWA manifest |

On locked staging, `isPublicReaderPath()` returns `false` for all of these. Handlers still call `authorizeReaderApiRequest()` (API) or `requireReaderPageSession()` (pages) from `editorial-session.ts`, which require an Auth0 session when the site is locked.

**Reader submission on locked staging:** tip submit, push subscribe, notification diagnostics POST, push test notification, and the other paths above all require sign-in first. Unauthenticated requests get the login wall (pages) or **401** (APIs).

## Admin routes (always authenticated)

`/admin/*` pages and `/api/admin/*` APIs require a valid Auth0 session and the Auth0 **`admin`** role on **both** production and locked staging. `SITE_ACCESS_MODE=public` does **not** open admin routes. The **`editor`** role does not grant admin access.

Shared helpers live in `web/src/lib/admin-session.ts` (`requireAdminPageSession`, `authorizeAdminApiRequest`); role-specific wrappers in `admin-dashboard-session.ts`, `tips-session.ts`, and `notification-diagnostics-session.ts`. All wrappers use `hasAdminRole` — there is no separate `tips` Auth0 role.

### Admin dashboard (`/admin`)

The staff hub at `/admin` shows a tile grid for signed-in admins:

| Tile | Route |
|------|-------|
| Story tips desk | `/admin/tips` |
| Push diagnostics | `/admin/notification-diagnostics` |
| EmDash CMS | `/_emdash/admin` |

The header **Admin** link is shown only for admins and points here.

| Route | Required role | Page helper | API helper |
|-------|---------------|-------------|------------|
| `/admin` | `admin` | `requireAdminDashboardSession()` | — |
| `/admin/tips` | `admin` | `requireTipsSession()` | — |
| `/api/admin/story-tips` | `admin` | — | `authorizeTipsApiRequest()` |
| `/api/admin/story-tips/:id` | `admin` | — | `authorizeTipsApiRequest()` |
| `/admin/notification-diagnostics` | `admin` | `requireNotificationDiagnosticsSession()` | — |
| `/api/admin/notification-diagnostics` | `admin` | — | `authorizeNotificationDiagnosticsApiRequest()` |

API auth responses: **401** when the session cookie is missing or invalid; **403** when the session is valid but the role is wrong. Mutating admin APIs also require the `X-CSRF-Token` header.

## Staging-only: `?simulate=` on submit-a-tip

On staging (and local dev), operators can preview tip-form error UX without persisting tips:

| URL | Simulated outcome |
|-----|-------------------|
| `/submit-a-tip?simulate=expected-error` | **400** / **403** validation or Turnstile errors |
| `/submit-a-tip?simulate=unexpected-error` | **500** server error |

The page shows a preview banner; submit POSTs to `/api/story-tips` for real with `_simulate` in the JSON body. The server returns the simulated error and **does not save** the tip.

**Production:** `?simulate=` and `_simulate` are ignored silently — normal validation, Turnstile, and persist run. See [STORY_TIPS_OPERATOR.md](./STORY_TIPS_OPERATOR.md) for full operator steps.

## Central enforcement (required for new routes)

Do **not** hand-roll `if (isLockedSiteAccess())` checks. Use the shared helpers:

| Handler type | Function |
|--------------|----------|
| API route in `PUBLIC_READER_PATHS` | `authorizeReaderApiRequest()` (`editorial-session.ts`) |
| Astro page in `PUBLIC_READER_PATHS` | `requireReaderPageSession()` (`editorial-session.ts`) |
| Editorial content (posts, `/homepage` on staging) | `requireEditorialSession()` (`editorial-session.ts`) |
| Admin page | `requireAdminPageSession()` or a role wrapper (`admin-session.ts`, `*-session.ts`) |
| Admin API | `authorizeAdminApiRequest()` or a role wrapper |

When adding a new production-public reader route:

1. Add the path to `PUBLIC_READER_PATHS` in `auth.ts`
2. Call `authorizeReaderApiRequest` or `requireReaderPageSession` at the top of the handler
3. Document the route in this file

## Testing reader flows on staging

1. Open `https://staging.freedomtimes.news/` and sign in with Auth0 (`editor` or `admin` role).
2. Navigate to the reader route (e.g. `/submit-a-tip`) or call the API with session cookies.
3. Unauthenticated requests to reader routes on staging must return the login wall (pages) or `401` (APIs).

Alternatively, use the temporary smoke test above to mimic anonymous production reader access — then revert to `locked`.

## Editorial content (separate from reader bypass)

Posts, pages, archives, and `/homepage` use `requireEditorialSession` on locked staging. On public production they are readable without login. That gating is per-page, not via `PUBLIC_READER_PATHS`.

## Related docs

- [`web/docs/STORY_TIPS_OPERATOR.md`](./STORY_TIPS_OPERATOR.md) — tip desk, Turnstile, and `?simulate=`
- [`web/docs/PUSH_NOTIFICATIONS_OPERATOR.md`](./PUSH_NOTIFICATIONS_OPERATOR.md) — push subscribe and diagnostics
- [`AGENTS.md`](../../AGENTS.md) — AI agent hard rules
