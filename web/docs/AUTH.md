# Authentication

Editorial authentication is **same-origin** on the Cloudflare Worker: Auth0 session cookies on the site domain, with EmDash admin and MCP on the same deployment. For the architectural overview, see [ARCHITECTURE.md](../../ARCHITECTURE.md) section 4.11.

## Routes

| Route | Purpose |
|---|---|
| `/` | Public holding page |
| `/homepage` | Protected broadsheet homepage (`admin` or `editor` role) |
| `/admin/tips` | Protected story tips desk (`admin` or `tips` role) — see [STORY_TIPS_OPERATOR.md](./STORY_TIPS_OPERATOR.md) |
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
| `admin` | EmDash CMS, broadsheet homepage, tips desk |
| `editor` | EmDash CMS, broadsheet homepage |
| `tips` | Tips desk only (`/admin/tips`) |

After login, users with `admin` or `editor` go to `/homepage`; users with only `tips` (or `admin`) also reach the tips desk and land on `/admin/tips` when they have no editorial role.

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
4. Role check passes for `admin`, `editor`, or `tips`
5. Redirect to `GET /homepage` (editorial roles), `GET /admin/tips` (tips-only), or `GET /signed-in` for the admin test page
6. Token verifies and page renders

**Live tail during each test:**

```powershell
cd web
npx wrangler tail freedomtimes-holding-staging --format pretty
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

## Deployment notes

Staging Worker deploy and secret sync are covered in [web/README.md](../README.md) and [scripts/set-github-secrets.md](../../scripts/set-github-secrets.md).
