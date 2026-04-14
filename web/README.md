# Freedom Times Web (Astro + Cloudflare Workers)

This app implements the current staging auth gate flow:

1. Holding page with a `Log in with Google` button
2. Auth0 login through Google SSO
3. If role includes `admin` or `editor`, user is sent to `/homepage`
4. If no required role is present, user is redirected back to the holding page

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

## Wrangler Config Files

Two wrangler configs exist in `web/` — do not merge them:

| File | Purpose |
|---|---|
| `wrangler.build.jsonc` | Used by `npm run build` via `astro.config.mjs`. No `main` field — the Astro adapter generates `dist/server/entry.mjs` at build time and the `@cloudflare/vite-plugin` would error if `main` pointed to a file that does not yet exist. |
| `wrangler.jsonc` | Used by `npx wrangler deploy`. Has `main: "dist/server/entry.mjs"` and full `env` blocks with vars for staging and production. |

**Never add `main` to `wrangler.build.jsonc`.  
Never run `npx wrangler deploy` without `--config .\web\wrangler.jsonc --env <staging|production>` from repo root.**

See also: `scripts/set-github-secrets.md` for syncing Worker secrets after deploy.

## Commands

Run all commands from `web/`:

- `npm install`
- `npm run dev`
- `npm run build`
- `npm run preview`

## Capacitor Spike

Capacitor is installed in `web/` because the mobile spike wraps this Astro app directly.

This site currently runs as a Cloudflare Worker SSR app, not a static export. That means Capacitor should point at a live URL instead of trying to package the Worker runtime into the native shell.

A minimal placeholder web bundle is checked in for Capacitor sync operations. Runtime traffic still targets the configured live URL.

Default behavior:

- `CAPACITOR_SERVER_URL` defaults to `https://staging.freedomtimes.news`
- local emulator/device testing can override it to a local HTTP URL

Examples:

```powershell
cd web
$env:CAPACITOR_SERVER_URL = "https://staging.freedomtimes.news"
npm run cap:doctor
```

```powershell
cd web
$env:CAPACITOR_SERVER_URL = "http://10.0.2.2:4321"
npm run cap:doctor
```

Available spike commands:

- `npm run cap:doctor`
- `npm run cap:add:android`
- `npm run cap:add:ios`
- `npm run cap:sync:android`
- `npm run cap:sync:ios`
- `npm run cap:open:android`
- `npm run cap:open:ios`

Notes:

- Android can be spiked from Windows if the Android SDK and tooling are installed.
- iOS now has a Capacitor shell under `web/ios`, but local build validation still requires macOS with Xcode.
- Because this is a live-URL wrapper spike, changing the Worker deployment remains the source of truth for app content and auth behavior.

### Local Android Build

The Android shell is validated by syncing Capacitor and building `assembleDebug` from `web/android`.

Requirements:

- `JAVA_HOME` must point at a working JDK.
- `ANDROID_HOME` or `ANDROID_SDK_ROOT` must point at a writable Android SDK location.
- Prefer a user-scoped SDK over a protected install under `Program Files`, because Gradle may need to install or update SDK components.

Example PowerShell flow:

```powershell
cd web
$env:JAVA_HOME = "C:\path\to\jdk"
$env:ANDROID_HOME = "C:\path\to\android-sdk"
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
$env:PATH = "$env:JAVA_HOME\bin;$env:ANDROID_HOME\platform-tools;$env:PATH"
npm run cap:sync:android
cd android
.\gradlew.bat assembleDebug
```

Validated locally in this spike:

- JDK from Android install: `C:\Program Files\Android\openjdk\jdk-21.0.8`
- Writable SDK: `C:\Users\jonbr\.bubblewrap\android_sdk`

### Local iOS Build

The iOS shell is generated under `web/ios` and uses the same live-URL Capacitor configuration as Android.

Requirements:

- macOS with Xcode installed
- Xcode command line tools available
- A simulator build can run unsigned; a physical device build requires the usual Apple signing setup

Example macOS flow:

```sh
cd web
export CAPACITOR_SERVER_URL="https://staging.freedomtimes.news"
npm run cap:sync:ios
cd ios/App
xcodebuild \
  -project App.xcodeproj \
  -scheme App \
  -configuration Debug \
  -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO \
  build
```

### GitHub Validation

GitHub Actions validates both native shells on macOS so the spike does not depend on one workstation's local setup.

- Android validation installs Java and Android SDK packages, syncs Capacitor, and runs `assembleDebug`.
- iOS validation syncs Capacitor and runs an unsigned simulator build with `xcodebuild`.

### Signed iOS Archive Export

The iOS workflow also supports a manually dispatched signed archive/export path on GitHub-hosted macOS runners.

Workflow:

- `.github/workflows/capacitor-ios.yml`
- dispatch with `signed_export=true`
- choose `export_method` as `development`, `ad-hoc`, or `app-store`

Required GitHub secrets:

- `IOS_CERTIFICATE_P12_BASE64`: base64-encoded signing certificate `.p12`
- `IOS_CERTIFICATE_PASSWORD`: password for the `.p12`
- `IOS_PROVISIONING_PROFILE_BASE64`: base64-encoded `.mobileprovision`
- `IOS_TEAM_ID`: Apple Developer Team ID

Output artifact:

- `capacitor-ios-signed-export-<method>`

That artifact includes:

- exported `.ipa`
- `.xcarchive`
- generated `ExportOptions.plist`

This path is intended for Mac-based install/signing validation. It is separate from the unsigned simulator artifact.

## Routes

- `/` holding page
- `/homepage` protected broadsheet homepage (requires valid session and `admin` or `editor` role)
- `/auth/login` starts Auth0 login
- `/auth/callback` handles code exchange + role check
- `/auth/logout` clears app session + logs out at Auth0
- `/signed-in` protected admin page

## Auth0 Scope and Consent

- Login requests `scope=openid` for minimal identity claims.
- Login also requests the configured API audience so Auth0 issues an API access token used by the cookie-to-APIM flow.
- The Auth0 API is configured to skip first-party consent prompts, so normal staging/production login should not show the consent screen.
- For the Android Capacitor shell, Auth0 must also allow the native callback URL `news.freedomtimes.app://auth/callback` so the browser can hand the user back to the app after Google sign-in.

## Staging Login Flow Runbook

Expected end-to-end behavior on your configured staging workspace URL:

1. `GET /auth/login`
2. Redirect to Auth0 authorize endpoint
3. `GET /auth/callback?code=...&state=...`
4. Role check passes for `admin` or `editor`
5. Redirect to `GET /homepage`
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

## Staging Deployment Command (Cloudflare Worker)

To deploy the staging Cloudflare Worker with all required runtime variables (matching CI):

```powershell
cd web
npx wrangler deploy --config wrangler.jsonc --env staging \
  --var "AUTH0_API_AUDIENCE:https://api.freedomtimes.news" \
  --var "API_BASE_URL:https://api-staging.freedomtimes.news/editorial" \
  --var "COOKIE_BASE_DOMAIN:freedomtimes.news" \
  --var "AUTH0_ROLES_CLAIM_NAMESPACE:https://freedomtimes.news/roles" \
  --var "API_UPSTREAM_MODE:apim"
```

- This command must be run from the `web/` directory.
- All `--var` flags are required for correct runtime configuration.
- Secrets must be set separately using `npx wrangler secret put ...` for each secret (see below).

**Note:** This matches the GitHub Actions CI deploy process. If you skip any vars or secrets, the Worker may not function correctly at runtime.

### After Deploy: Sync Secrets

After deploying, re-sync all required secrets:

```powershell
npx wrangler secret put AUTH0_DOMAIN
npx wrangler secret put AUTH0_CLIENT_ID
npx wrangler secret put AUTH0_CLIENT_SECRET
```

You will be prompted for each value. These must match the values used in CI and production.

## Scheduler Worker

The notification scheduler runs as a separate Cloudflare Worker in the sibling [scheduler-worker](scheduler-worker) project, using [scheduler-worker/wrangler.jsonc](scheduler-worker/wrangler.jsonc).

- It is intentionally separate from the Astro SSR worker.
- It is triggered by a Cloudflare cron schedule every 10 minutes.
- It reads recurring jobs from the scheduler Turso database and dispatches handlers from [scheduler-worker/src/scheduler.ts](scheduler-worker/src/scheduler.ts).

Manual staging deploy example:

```powershell
cd scheduler-worker
npx wrangler deploy --config wrangler.jsonc --env staging
```

Required scheduler secrets:

```powershell
cd scheduler-worker
npx wrangler secret put TURSO_SCHEDULER_DATABASE_URL --config wrangler.jsonc --env staging
npx wrangler secret put TURSO_SCHEDULER_AUTH_TOKEN --config wrangler.jsonc --env staging
```

## Turso SQL Migrations

Database schema deployment for non-EmDash Turso workloads runs from the `web/` project with shared tooling.

- Scheduler SQL lives in `infra/scheduler-database/migrations` and `infra/scheduler-database/seeds`.
- Subscriptions SQL lives in `infra/subscriptions-database/migrations` and `infra/subscriptions-database/seeds`.

Manual staging examples:

```powershell
cd web
npm run scheduler:db:deploy
npm run subscriptions:db:deploy
```

For browser subscription capture, the web worker also needs:

- `TURSO_SUBSCRIPTIONS_DATABASE_URL`
- `TURSO_SUBSCRIPTIONS_AUTH_TOKEN`
- local development: `PUSH_STAGING_SUBSCRIBE_PUBLIC_KEY`
- deployed worker secret: `PUSH_SUBSCRIBE_PUBLIC_KEY`

The first two are synced from Terraform outputs in CI. The public key is safe to expose to the browser, but it still needs to be set on the worker separately until VAPID key management is wired into deployment.
