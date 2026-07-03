# Staging access policy

Freedom Times uses `SITE_ACCESS_MODE` to control whether anonymous readers can reach parts of the site.

| Value | Environment | Meaning |
|-------|-------------|---------|
| `public` | Production (`freedomtimes.news`) | Selected reader routes work without login |
| `locked` | Staging (`staging.freedomtimes.news`) | **Nothing is public** except EmDash internal auth |

Configured in `web/wrangler.jsonc` per Worker environment.

## Hard rule: NOTHING ON STAGING IS PUBLIC

On locked staging, every HTML page and API route requires an Auth0 session **except**:

- `/_emdash/*` — EmDash CMS, OAuth, MCP (own auth; bypassed in `middleware.ts`)
- `/.well-known/*` — OAuth metadata aliases for MCP clients
- `/auth/login`, `/auth/callback`, `/auth/logout` — login wall must stay reachable
- `/` — staging login wall (`SecureAccessWall`)

**Never** add staging-only public exceptions. Do not add reader or editorial paths to `AUTH_BYPASS_RULES` in middleware.

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

On locked staging, `isPublicReaderPath()` returns `false` for all of these.

## Admin routes (always authenticated)

`/admin/*` pages and `/api/admin/*` APIs require a valid Auth0 session and the correct role on **both** production and locked staging. `SITE_ACCESS_MODE=public` does **not** make admin routes anonymous.

Shared helpers live in `web/src/lib/admin-session.ts`; role-specific wrappers in `admin-dashboard-session.ts`, `tips-session.ts`, and `notification-diagnostics-session.ts`.

**`/admin`** is the staff hub: signed-in users with any staff role land on a dashboard of tiles linking to the tools their roles can access (tips desk, push diagnostics, EmDash CMS). The header **Admin** link points here.

| Route | Required Auth0 roles | Page helper | API helper |
|-------|---------------------|-------------|------------|
| `/admin` | `admin`, `editor`, or `tips` (any staff role) | `requireAdminDashboardSession()` | — |
| `/admin/tips` | `tips` or `admin` | `requireTipsSession()` | — |
| `/api/admin/story-tips` | `tips` or `admin` | — | `authorizeTipsApiRequest()` |
| `/api/admin/story-tips/:id` | `tips` or `admin` | — | `authorizeTipsApiRequest()` |
| `/admin/notification-diagnostics` | `admin` or `editor` | `requireNotificationDiagnosticsSession()` | — |
| `/api/admin/notification-diagnostics` | `admin` or `editor` | — | `authorizeNotificationDiagnosticsApiRequest()` |
| `/_emdash/admin` (EmDash CMS) | EmDash OAuth / MCP | — | — |

API auth responses: **401** when the session cookie is missing or invalid; **403** when the session is valid but the role is wrong. Mutating tips APIs also require the `X-CSRF-Token` header.

The **`tips`** role does **not** grant access to push diagnostics or EmDash CMS. The **`editor`** role does **not** grant tips desk access unless the user also has `tips` or `admin`.

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

1. Open `https://staging.freedomtimes.news/` and sign in with Auth0 (`editor`, `admin`, or `tips` role).
2. Navigate to the reader route (e.g. `/submit-a-tip`) or call the API with session cookies.
3. Unauthenticated requests to reader routes on staging must return the login wall (pages) or `401` (APIs).

## Editorial content (separate from reader bypass)

Posts, pages, archives, and `/homepage` use `requireEditorialSession` on locked staging. On public production they are readable without login. That gating is per-page, not via `PUBLIC_READER_PATHS`.

## Related docs

- [`web/docs/STORY_TIPS_OPERATOR.md`](./STORY_TIPS_OPERATOR.md) — tip desk and Turnstile
- [`web/docs/PUSH_NOTIFICATIONS_OPERATOR.md`](./PUSH_NOTIFICATIONS_OPERATOR.md) — push subscribe and diagnostics
- [`AGENTS.md`](../../AGENTS.md) — AI agent hard rules
