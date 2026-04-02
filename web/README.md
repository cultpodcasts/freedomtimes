# Freedom Times Web (Astro + Cloudflare Workers)

This app implements the current staging auth gate flow:

1. Holding page with a `Log in with Google` button
2. Auth0 login through Google SSO
3. If role includes `admin`, user is sent to `/signed-in`
4. If not admin, user is redirected back to the holding page

## Environment Variables

Copy `.env.example` to `.env` and set values:

```sh
AUTH0_DOMAIN=freedomtimes.uk.auth0.com
AUTH0_CLIENT_ID=...
AUTH0_CLIENT_SECRET=...
```

Role detection checks either of these claims in the ID token:

- `https://freedomtimes.news/roles`
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

Interim note:

- If a temporary JS-readable token path exists for testing, treat it as transitional and remove it once APIM cookie-to-header flow is fully deployed.
