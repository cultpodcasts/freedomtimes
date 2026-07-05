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

- Login requests `scope=openid offline_access` — `offline_access` is required for Auth0 to issue a `refresh_token` alongside the ID/access tokens.
- Login also requests the configured API audience so Auth0 issues an API access token stored in an HttpOnly cookie.
- First-party consent is skipped via Terraform (`skip_consent_for_verifiable_first_party_clients = true`); users should not see a consent screen during normal login.
- For the Android Capacitor shell, Auth0 must allow the native callback URL `news.freedomtimes.app://auth/callback`.

## Cookies

| Cookie | Purpose |
|---|---|
| `ft_session` | HttpOnly ID token |
| `ft_access_token` | HttpOnly API access token |
| `ft_refresh` | HttpOnly refresh token — used for silent re-authentication once `ft_session` expires (see [Refresh tokens](#refresh-tokens-app-side) below) |
| `ft_csrf` | JS-readable CSRF token |

All auth cookies share the same `HttpOnly` (except `ft_csrf`), `Secure`, `SameSite=Lax`, `path=/`, and domain policy (`getCookieDomainForHost` — host-only unless `COOKIE_BASE_DOMAIN` matches).

**Stale-cookie protections:**

- Callback and logout clear both host-only and domain-scoped auth cookie variants (including `ft_refresh`).
- `requireEditorialSession` attempts a silent `ft_refresh` exchange before clearing cookies and redirecting to `/auth/login` when the session token is expired (see below).
- `/signed-in` clears auth cookies and redirects to `/auth/login` when the session token is expired and no refresh was possible.
- `/signed-in` detects duplicate `ft_session` values in the `Cookie` header, clears auth cookies, and forces a clean login.

**Role denial:** If the callback token verifies but the required role claim is missing, auth cookies are cleared and the user is redirected to `/?denied=1`.

## Staging login flow runbook

Use this when validating login on staging at [https://staging.freedomtimes.news](https://staging.freedomtimes.news).

**Expected sequence:**

1. `GET /auth/login`
2. Redirect to Auth0 authorize endpoint (Authorization Code flow, scope `openid offline_access`, API audience requested)
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

There is **no tenant-wide Auth0 SSO session management** in this repo (no `auth0_tenant` resource). The long-session path is **application-level refresh tokens**, not a tenant SSO cookie. The re-sign-in interval a user actually experiences is set by **two layers**, from most to least binding:

| Layer | What it controls | Where |
|---|---|---|
| ID token `exp` (JWT claim) | `verifyIdToken()` runs on **every** protected page/API request (`editorial-session.ts`, `signed-in.astro`). Once `exp` has passed, the app tries a silent refresh (below) before redirecting to `/auth/login` | Terraform: `auth0_client.admin_ui.jwt_configuration.lifetime_in_seconds` (`infra/terraform/modules/auth0_app/main.tf`, `var.id_token_lifetime_in_seconds`, default 28,800s / 8h) |
| `ft_session` / `ft_csrf` / `ft_refresh` cookie `maxAge` | Browser stops sending each cookie once its own `maxAge` elapses | App code: `web/src/lib/auth.ts` (`SESSION_COOKIE`/`CSRF_COOKIE` 8h, `REFRESH_TOKEN_COOKIE` matches `refresh_token_idle_lifetime_seconds`, default 14d) |

**Before this change:** `jwt_configuration.lifetime_in_seconds` was hardcoded to `3600` (1 hour), while the `ft_session` cookie declared an 8-hour `maxAge`. The ID token's own `exp` was the real bottleneck — the cookie's 8-hour window was mostly theoretical because `verifyIdToken()` rejected the token as expired after 1 hour and forced a fresh Auth0 login.

**Current (Terraform, this repo):** Per-application settings on the staging/production login apps are always managed: **8-hour ID token** (`id_token_lifetime_in_seconds`, matching the existing `ft_session` cookie `maxAge`) and a **rotating, expiring refresh token policy** on the Auth0 application (`enable_refresh_token_rotation`, default `true`; 30d absolute / 14d idle lifetimes).

| Setting | Was | Now | Managed by |
|---|---|---|---|
| ID token lifetime (`id_token_lifetime_in_seconds`) | 3,600s (1h, hardcoded) | 28,800s (8h) — matches the existing cookie `maxAge` | `modules/auth0_app` var, per staging/production login app |
| Refresh token rotation | not configured | `rotating` / `expiring`, absolute 30d, idle 14d (`enable_refresh_token_rotation`) | `modules/auth0_app` var, per staging/production login app |

**What this changes:** raising `id_token_lifetime_in_seconds` to 8h makes the ID token's lifetime match the cookie's already-declared 8-hour window, so users get the full 8 hours the app always intended instead of being forced to re-login after 1 hour. The refresh token policy backs a real silent-refresh flow (below), so once the 8-hour ID token expires, the app can extend the session for up to 14 days of activity (idle refresh token lifetime) without a full Auth0 login prompt.

### Refresh tokens (app side)

Auth0-side refresh token policy alone does nothing unless the app actually requests, stores, and uses a refresh token. This repo does:

1. **`web/src/pages/auth/login.ts`** requests `scope=openid offline_access` — `offline_access` is what makes Auth0 include a `refresh_token` in the token response.
2. **`web/src/pages/auth/callback.ts`** stores the returned `refresh_token` in a new `HttpOnly`, `Secure`, `SameSite=Lax` cookie (`ft_refresh`, `REFRESH_TOKEN_COOKIE` in `auth.ts`), `maxAge` matching `refresh_token_idle_lifetime_seconds` (default 14 days), same `path=/` and domain policy as the other auth cookies.
3. **`web/src/lib/editorial-session.ts`** (`requireEditorialSession`) attempts a silent refresh before forcing a login redirect: when the `ft_session` ID token is missing or fails `verifyIdToken()` (typically `exp` expiry), it reads `ft_refresh`, calls `exchangeRefreshTokenForTokens()` (grant_type `refresh_token` against `/oauth/token`) in `web/src/lib/auth.ts`, re-verifies the new ID token, and — if it still carries a valid editorial role — reissues all four auth cookies (Auth0 rotation returns a new `refresh_token` on every use). Only if there is no refresh cookie, or the refresh exchange/role-check fails, are cookies cleared and the user redirected to `/auth/login`.

This is deliberately **not** a separate `/auth/refresh` route: the refresh happens transparently inside the same request that discovered the expired token, so a protected page/API call either succeeds (session silently extended) or falls back to the login redirect in one round trip.

### Applying these changes

Plan/apply staging and production as usual (module changes only — no import needed, `auth0_client.admin_ui` already exists in state):

```powershell
pwsh scripts/terraform-run.ps1 -Environment staging -Operation plan -LoadEnvFiles
pwsh scripts/terraform-run.ps1 -Environment staging -Operation apply -LoadEnvFiles
pwsh scripts/terraform-run.ps1 -Environment production -Operation plan -LoadEnvFiles
pwsh scripts/terraform-run.ps1 -Environment production -Operation apply -LoadEnvFiles
```

`scripts/terraform-run.ps1` takes the per-environment file lock described in `infra/terraform/README.md`; do not run parallel Terraform against the same environment. **AI agents: do not run `apply` yourselves** — plan and report back per `AGENTS.md` guardrails; the operator applies.

## Deployment notes

Staging Worker deploy and secret sync are covered in [web/README.md](../README.md) and [scripts/set-github-secrets.md](../../scripts/set-github-secrets.md).
