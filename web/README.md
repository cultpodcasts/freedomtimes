# Freedom Times Web (Astro + Cloudflare Workers)

This app implements the current staging auth gate flow:

1. Holding page with a `Log in with Google` button
2. Auth0 login through Google SSO
3. If role includes `admin`, user is sent to `/signed-in`
4. If not admin, user is redirected back to the holding page

## Environment Variables

Copy `.env.example` to `.env` and set values:

```sh
AUTH0_DOMAIN=your-tenant.example-auth0.com
AUTH0_CLIENT_ID=...
AUTH0_CLIENT_SECRET=...
AUTH0_API_AUDIENCE=...
API_BASE_URL=...
COOKIE_BASE_DOMAIN=example.com
AUTH0_ROLES_CLAIM_NAMESPACE=https://example.com
API_UPSTREAM_MODE=apim
```

Local development does not use `scripts/set-github-secrets.ps1`.
`wrangler dev` / Astro reads local env files directly, so keys must use the pure runtime names shown above (for example `AUTH0_DOMAIN`, not prefixed aliases).

Role detection checks either of these claims in the ID token:

- `${AUTH0_ROLES_CLAIM_NAMESPACE}/roles` (when namespace is configured)
- `roles`

The user is considered admin only if one role equals `admin` (case-insensitive).

## Commands

Run all commands from `web/`:

- `npm install`
- `npm run dev`
- `npm run build`
- `npm run preview`

## Routes

- `/` holding page
- `/auth/login` starts Auth0 login
- `/auth/callback` handles code exchange + role check
- `/auth/logout` clears app session + logs out at Auth0
- `/signed-in` protected admin page

## Staging Login Flow Runbook

Expected end-to-end behavior on your configured staging workspace URL:

1. `GET /auth/login`
2. Redirect to Auth0 authorize endpoint
3. `GET /auth/callback?code=...&state=...`
4. Role check passes for `admin` or `editor`
5. Redirect to `GET /signed-in`
6. Token verifies and page renders

Primary cookie names used by web auth:

- `ft_session` (HttpOnly id token)
- `ft_access_token` (HttpOnly API access token)
- `ft_csrf` (JS-readable CSRF token)

Stale-cookie protections:

- Callback and logout clear both host-only and domain-scoped cookie variants before setting or deleting auth cookies.
- Signed-in clears auth cookies and redirects to `/auth/login` when token verification fails with expired token.
- Signed-in detects duplicate `ft_session` values in the incoming `Cookie` header, clears auth cookies, and forces clean login.

Role denial behavior:

- If callback token verifies but required role is missing, auth cookies are cleared and user is redirected to `/?denied=1`.

### Live Tail Verification

Use Cloudflare live tail during each auth test:

```powershell
cd web
npx wrangler tail freedomtimes-holding-staging --format pretty
```

Report each attempt using this format:

- `auth/login outcome`
- `auth/callback outcome`
- `signed-in outcome`
- `final redirect/result`
- `any token verification or role-check errors`

Example success signal sequence:

- `[auth.login] starting login redirect`
- `[auth.callback] callback received`
- `[auth.callback] login successful`
- `[signed-in] token verified and page render allowed`

## API Auth Model (Target)

The target model for editorial API access is cookie-forwarded auth through APIM:

1. App issues API token in an HttpOnly cookie scoped for the parent domain.
2. Browser calls API host on subdomain with credentialed requests.
3. APIM extracts token from cookie, sets upstream Authorization header, and validates roles.
4. EasyAuth validates bearer token at Function boundary.

Security requirements for this model:

- explicit credentialed CORS policy on APIM
- CSRF protection on state-changing endpoints
- strict cookie attributes (`HttpOnly`, `Secure`, domain/path scope, short expiry)
- APIM header sanitization so client-provided auth header is not trusted

Current implementation note:

- The signed-in API test page now calls APIM with `credentials: include` and does not read or attach bearer tokens in browser JavaScript.
