# Authentication

Editorial authentication is **same-origin** on the Cloudflare Worker: Auth0 session cookies on the site domain, with EmDash admin and MCP on the same deployment. For the architectural overview, see [ARCHITECTURE.md](../../ARCHITECTURE.md) section 4.11.

## Routes

| Route | Purpose |
|---|---|
| `/` | Public holding page |
| `/homepage` | Protected broadsheet homepage (`admin` or `editor` role) |
| `/admin` | Protected staff hub (`admin` role only) — tips desk, push diagnostics, EmDash CMS link |
| `/admin/tips` | Protected story tips desk (`admin` role only) — see [STORY_TIPS_OPERATOR.md](./STORY_TIPS_OPERATOR.md) |
| `/auth/login` | Starts Auth0 Authorization Code flow |
| `/auth/callback` | Exchanges code, enforces roles, sets cookies |
| `/auth/logout` | Clears app session and logs out at Auth0 |
| `/signed-in` | Protected admin page |

Middleware keeps `/_emdash/*` and OAuth discovery paths outside the outer Auth0 gate so EmDash can complete its own OAuth and MCP flows.

## Environment variables

Copy `web/.env.example` to `web/.env`. Local development uses pure runtime names (for example `AUTH0_DOMAIN`, not prefixed aliases).

| Variable | Purpose |
|---|---|
| `AUTH0_DOMAIN` | Auth0 tenant |
| `AUTH0_CLIENT_ID` / `AUTH0_CLIENT_SECRET` | Application credentials |
| `AUTH0_API_AUDIENCE` | Resource-server identifier for access tokens and RBAC |
| `AUTH0_ROLES_CLAIM_NAMESPACE` | Namespace for custom role claims (e.g. `https://freedomtimes.news/roles`) |
| `COOKIE_BASE_DOMAIN` | Parent domain for auth cookies |
| `API_BASE_URL` | Editorial API base URL (when used) |

Role detection checks `${AUTH0_ROLES_CLAIM_NAMESPACE}/roles` when configured, or plain `roles`. Login succeeds when the user has at least one staff role (case-insensitive):

| Role | Access |
|------|--------|
| `admin` | EmDash CMS, broadsheet homepage, all Freedom Times `/admin/*` tools (tips desk, push diagnostics) |
| `editor` | EmDash CMS, broadsheet homepage (no Freedom Times `/admin` hub) |

After login, `admin` and `editor` users go to `/homepage`.

## Auth0 scope and consent

- Login requests `scope=openid` for minimal identity claims.
- Login also requests the configured API audience so Auth0 issues an API access token stored in an HttpOnly cookie.
- First-party consent is skipped via Terraform (`skip_consent_for_verifiable_first_party_clients = true`); users should not see a consent screen during normal login.
- For the Android Capacitor shell, Auth0 must allow the native callback URL `news.freedomtimes.app://auth/callback`.

## Cookies

| Cookie | Purpose |
|---|---|
| `ft_session` | HttpOnly ID token |
| `ft_access_token` | HttpOnly API access token |
| `ft_csrf` | JS-readable CSRF token |

**Stale-cookie protections:**

- Callback and logout clear both host-only and domain-scoped auth cookie variants.
- `/signed-in` clears auth cookies and redirects to `/auth/login` when the session token is expired.
- `/signed-in` detects duplicate `ft_session` values in the `Cookie` header, clears auth cookies, and forces a clean login.

**Role denial:** If the callback token verifies but the required role claim is missing, auth cookies are cleared and the user is redirected to `/?denied=1`.

## Staging login flow runbook

Use this when validating login on staging at [https://staging.freedomtimes.news](https://staging.freedomtimes.news).

**Expected sequence:**

1. `GET /auth/login`
2. Redirect to Auth0 authorize endpoint (Authorization Code flow, scope `openid`, API audience requested)
3. `GET /auth/callback?code=...&state=...`
4. Role check passes for `admin` or `editor`
5. Redirect to `GET /homepage`, or `GET /signed-in` for the admin test page
6. Token verifies and page renders

**Live tail during each test:**

```powershell
cd web
npx wrangler tail freedomtimes-staging --format pretty
```

**Report each attempt with:**

- `auth/login` outcome
- `auth/callback` outcome
- `signed-in` outcome
- final redirect/result
- any token verification or role-check errors

**Example success signals:**

- `[auth.login] starting login redirect`
- `[auth.callback] callback received`
- `[auth.callback] login successful`
- `[signed-in] token verified and page render allowed`

## Session lifetime (Terraform)

The re-sign-in interval a user actually experiences is set by **three layers**, from most to least binding:

| Layer | What it controls | Where |
|---|---|---|
| ID token `exp` (JWT claim) | `verifyIdToken()` runs on **every** protected page/API request (`editorial-session.ts`, `signed-in.astro`) and redirects to `/auth/login` the moment the token's `exp` has passed — regardless of the cookie's own `maxAge` | Terraform: `auth0_client.admin_ui.jwt_configuration.lifetime_in_seconds` (`infra/terraform/modules/auth0_app/main.tf`, `var.id_token_lifetime_in_seconds`) |
| `ft_session` / `ft_csrf` cookie `maxAge` | Browser stops sending the cookie at all once this expires (a hard floor on top of the token's own `exp`) | App code: `web/src/pages/auth/callback.ts` (`maxAge: 60 * 60 * 8`) |
| Auth0 tenant SSO session (`session_lifetime` / `idle_session_lifetime`) | Whether a silent redirect to Auth0's `/authorize` (e.g. after the ID token above expires) can re-issue a fresh token **without** showing a login prompt | Terraform: `auth0_tenant.main` (`infra/terraform/environments/auth0-shared/main.tf`) — tenant-wide, not per-app |

**Before this change:** `jwt_configuration.lifetime_in_seconds` was hardcoded to `3600` (1 hour), while the `ft_session` cookie declared an 8-hour `maxAge`. The ID token's own `exp` was the real bottleneck — the cookie's 8-hour window was mostly theoretical because `verifyIdToken()` rejected the token as expired after 1 hour and forced a fresh Auth0 login.

**Current (Terraform, this repo):**

| Setting | Was | Now (default) | Managed by |
|---|---|---|---|
| ID token lifetime (`id_token_lifetime_in_seconds`) | 3,600s (1h, hardcoded) | 28,800s (8h) — matches the existing cookie `maxAge` | `modules/auth0_app` var, per staging/production login app |
| Refresh token rotation | not configured | `rotating` / `expiring`, absolute 30d, idle 14d (`enable_refresh_token_rotation`) | `modules/auth0_app` var, per staging/production login app |
| Auth0 tenant `session_lifetime` | Auth0 default 168h (7d) | 336h (14d) | `environments/auth0-shared` (`auth0_tenant.main`) |
| Auth0 tenant `idle_session_lifetime` | Auth0 default 72h (3d) | 168h (7d) | `environments/auth0-shared` (`auth0_tenant.main`) |

**What this actually changes today:** raising `id_token_lifetime_in_seconds` to 8h is a real, immediate fix — it makes the ID token's lifetime match the cookie's already-declared 8-hour window, so users get the full 8 hours the app always intended instead of being forced to re-login after 1 hour. The tenant `session_lifetime`/`idle_session_lifetime` bump makes any *fresh* `/auth/login` → Auth0 `/authorize` round trip (e.g. once the 8-hour token/cookie has expired) more likely to complete silently via Auth0's own SSO cookie, without a password/Google prompt.

**What this does *not* yet do:** the refresh token settings (`enable_refresh_token_rotation`, `refresh_token_lifetime_seconds`, `refresh_token_idle_lifetime_seconds`) configure Auth0-side policy only. `web/src/pages/auth/login.ts` still requests only `scope=openid` (no `offline_access`), and `exchangeCodeForTokens()` never calls the `refresh_token` grant — so no refresh token is ever issued or used today. To get a true "days-long session without any Auth0 redirect" experience, a follow-up change would need to:

1. Add `offline_access` to the `scope` in `login.ts`.
2. Store the returned `refresh_token` in a new `HttpOnly` cookie with a `maxAge` matching `refresh_token_idle_lifetime_seconds`.
3. Add a silent-refresh path (e.g. in `editorial-session.ts` or a new `/auth/refresh` route) that exchanges the refresh token for a new ID/access token pair when `verifyIdToken()` reports expiry, before falling back to a full `/auth/login` redirect.

That is deliberately **out of scope** for this Terraform-only change; the settings above just make it available to implement later without another Auth0-side change.

### Applying these changes

Tenant-wide settings (`auth0_tenant.main`) are new in `environments/auth0-shared`; **import the existing tenant first** so unrelated settings (friendly name, flags, support email, etc.) are not reset:

```powershell
pwsh scripts/terraform-run.ps1 -Environment auth0-shared -Operation init -LoadEnvFiles
pwsh scripts/terraform-run.ps1 -Environment auth0-shared -Operation import -LoadEnvFiles -ImportAddress auth0_tenant.main -ImportId auth0-shared-tenant
# placeholder ImportId; auth0_tenant import is ID-passthrough and not read back from Auth0
pwsh scripts/terraform-run.ps1 -Environment auth0-shared -Operation plan -LoadEnvFiles
# review the plan: expect changes to session_lifetime / idle_session_lifetime only
pwsh scripts/terraform-run.ps1 -Environment auth0-shared -Operation apply -LoadEnvFiles
```

Then plan/apply staging and production as usual (module changes only — no import needed, `auth0_client.admin_ui` already exists in state):

```powershell
pwsh scripts/terraform-run.ps1 -Environment staging -Operation plan -LoadEnvFiles
pwsh scripts/terraform-run.ps1 -Environment staging -Operation apply -LoadEnvFiles
pwsh scripts/terraform-run.ps1 -Environment production -Operation plan -LoadEnvFiles
pwsh scripts/terraform-run.ps1 -Environment production -Operation apply -LoadEnvFiles
```

`scripts/terraform-run.ps1` takes the per-environment file lock described in `infra/terraform/README.md`; do not run parallel Terraform against the same environment. **AI agents: do not run `apply` yourselves** — plan and report back per `AGENTS.md` guardrails; the operator applies.

## Deployment notes

Staging Worker deploy and secret sync are covered in [web/README.md](../README.md) and [scripts/set-github-secrets.md](../../scripts/set-github-secrets.md).
