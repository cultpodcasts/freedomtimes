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
