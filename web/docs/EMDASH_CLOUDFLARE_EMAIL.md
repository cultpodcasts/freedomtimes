# EmDash Cloudflare Email (magic links)

EmDash CMS login (`/_emdash/admin`) uses passkeys in a normal browser. Capacitor Android WebViews do not support passkeys, so **magic-link email** is the unlock for staff CMS access from the Android app.

This site uses the official EmDash provider:

```ts
import { cloudflareEmail } from '@emdash-cms/cloudflare/plugins';
```

wired in [`web/astro.config.ts`](../astro.config.ts) with:

| Option | Value |
|--------|--------|
| From | `noreply@freedomtimes.news` (apex — **no** `mail.` prefix) |
| Reply-To | `privacy@freedomtimes.news` |
| Binding | `EMAIL` |

Docs upstream: [Deploy to Cloudflare → Email](https://docs.emdashcms.com/deployment/cloudflare/).

## What Terraform vs Wrangler own

| Concern | Owner | Notes |
|---------|--------|--------|
| Worker **bundle** (Astro/EmDash code) + static assets | Wrangler deploy | `deploy-*-local.ps1` / CI |
| `send_email` binding `EMAIL` | **Terraform** (`cloudflare_workers_script` bindings, provider **~> 5.22**) | Declared in `modules/cloudflare_holding_page`. Mirror in [`web/wrangler.jsonc`](../wrangler.jsonc) so Worker **deploy** does not strip it. |
| `PAGE_VIEWS` analytics_engine | Terraform | Same script resource; dataset id from tfvars / output |
| `TURNSTILE_*`, `CLOUDFLARE_ANALYTICS_API_TOKEN` | Terraform | `secret_text` bindings (replaces removed v4 `cloudflare_workers_secret`) |
| KV `SESSION` / R2 `MEDIA` / Wrangler `plain_text` vars / `ASSETS` | Wrangler | Preserved across TF updates via `keep_bindings` (`kv_namespace`, `r2_bucket`, `plain_text`, `assets`) **and** `keep_assets = true` |

**Do not** apply Terraform Worker-script binding updates without `keep_assets = true` and those `keep_bindings` entries. A bindings-only upload that drops Assets / Wrangler `plain_text` vars corrupts SSR routing (observed: `GET /auth/login` → HTTP 400 `Missing slug`). After any bad TF upload, recover with a Wrangler Worker redeploy (or roll back to the last Wrangler deployment version).
| Email Sending **domain onboard** (`freedomtimes.news`) | Operator (dashboard) | **Still no** first-class TF resource for Sending onboard (only `email_routing_*` exists). Creates `cf-bounce.*` DNS; does **not** replace apex Email Routing MX. |
| Apex Email Routing redirects | Existing dashboard setup (outside this repo) | Coexists with Sending — keep redirects intact |
| `_dmarc` / Sending DNS | Operator review after onboard | Prefer soft `p=none` if Cloudflare proposes `p=reject` before you are ready |
| EmDash plugin activation | Operator (EmDash UI) | Cannot be Terraform'd |

## Onboard Email Sending (apex `freedomtimes.news`)

Email **Routing** (inbound: `newsroom@` / `privacy@` / `socialmedia@` / `developer@` → Outlook) and Email **Sending** (outbound magic links) are separate products. Onboarding Sending does **not** remove Routing redirects.

### Dashboard path

1. Sign in to [Cloudflare Dashboard](https://dash.cloudflare.com) → account that owns `freedomtimes.news`.
2. Open **Email** (or **Compute** → **Email Service**, depending on UI) → **Email Sending**.
3. **Onboard Domain** (or **Get started**) → choose apex **`freedomtimes.news`** (not a `mail.` subdomain).
4. Allow Cloudflare to add / propose DNS records. Confirm before switching DMARC to reject (see below).

### DNS you should expect

| Record | Purpose | Notes |
|--------|---------|--------|
| `cf-bounce.<something>.freedomtimes.news` (or similar) | Bounce / feedback handling for Sending | Cloudflare-managed; leave in place |
| DKIM (`*._domainkey…`) | Authenticate outbound From | Required for deliverability |
| Optional SPF / BIMI | Per Cloudflare wizard | Do not drop existing Routing MX |
| `_dmarc` | Policy for the domain | If Cloudflare suggests `p=reject`, prefer **`p=none`** (or `p=quarantine`) until magic-link and newsroom mail look healthy |

**Do not** delete apex MX / Email Routing rules while onboarding Sending.

### From address

Outbound EmDash mail uses **`noreply@freedomtimes.news`**. That address must be allowed on the Worker `send_email` binding (already set in Terraform + `wrangler.jsonc` as `allowed_sender_addresses`). After Sending is onboarded, Cloudflare will treat that From as authorized for the apex.

### Coexistence checklist (Routing)

After onboard, quickly confirm Routing still delivers:

- `privacy@freedomtimes.news`
- `newsroom@freedomtimes.news`
- `socialmedia@freedomtimes.news`
- `developer@freedomtimes.news`

If any break, restore Routing rules / MX before continuing EmDash tests.

## Operator sequence (staging → production)

1. **Terraform apply** (staging done for PR #77; production only when explicitly asked) — attaches `EMAIL` + `secret_text` bindings.
2. **Onboard Email Sending** for apex (section above) — dashboard one-time; applies to the zone (both staging Worker and production Worker send as apex From).
3. **Deploy** the web Worker so the Astro/`cloudflareEmail()` bundle is live (staging first):  
   `.\scripts\deploy-staging-local.ps1` (or CI).  
   Terraform attach of `EMAIL` alone does not ship app code; deploy ships the plugin. Keep `wrangler.jsonc` `send_email` in sync so deploy does not strip the TF-owned binding.
4. **Activate in EmDash** (per environment hostname):  
   - Sign in to `/_emdash/admin` (desktop passkey)  
   - **Admin → Extensions** → activate **Cloudflare Email**  
   - **Settings → Email** → select that provider  
5. **Test magic link** from the Android app (or any client without passkeys).

## Magic link URL (what EmDash sends)

EmDash upstream (`@emdash-cms/auth` `sendMagicLink`) builds a verify URL from `config.baseUrl` only — **no** URL-builder / `callbackURL` hook:

```ts
const url = new URL("/_emdash/api/auth/magic-link/verify", config.baseUrl);
url.searchParams.set("token", token);
```

Default email (desktop / mobile browser) therefore contains:

```text
https://freedomtimes.news/_emdash/api/auth/magic-link/verify?token=<opaque>
```

(The Sign-in button `href` and the plain-text link are the same URL.)

### Capacitor Android — custom scheme (Freedom Times)

When the magic-link **send** request comes from the Capacitor Android app, Freedom Times rewrites that href in the outbound email to the Auth0-shared custom scheme:

```text
news.freedomtimes.app://auth/magic-link/verify?token=<opaque>&ft_origin=https%3A%2F%2Ffreedomtimes.news
```

| Piece | Value |
|-------|--------|
| Scheme | `news.freedomtimes.app` (same as Auth0 `…://auth/callback`) |
| Host / path | `auth` / `/magic-link/verify` |
| Query | `token` (required); `ft_origin` (issuing HTTPS origin); optional `redirect` |

**Detection (prefer Capacitor signal, not bare Android UA):**

1. Cookie `ft_native_android=1` — set by [`native-auth-bridge.ts`](../src/lib/native-auth-bridge.ts) when `Capacitor.getPlatform() === 'android'`
2. Else cookie `ft_native_app=1` **and** (`X-Requested-With: news.freedomtimes.app` or Android UA)

Chrome on Android without those cookies still gets the HTTPS link.

**Flow:** email tap → Android VIEW intent → Capacitor `appUrlOpen` → bridge maps custom scheme → WebView `GET` HTTPS verify (session cookie in the app jar).

Implementation: Vite transform of EmDash’s `magic-link/send` email callback ([`magic-link-android-scheme-plugin.ts`](../src/vite/magic-link-android-scheme-plugin.ts) + [`native-android-magic-link.ts`](../src/lib/native-android-magic-link.ts)). AndroidManifest intent-filter includes `pathPrefix="/magic-link/verify"`.

**Caveats:** some email clients strip or refuse unknown custom schemes; Outlook Safe Links typically does **not** rewrite non-http(s) URLs the same way (so the token is less likely to be prefetched), but clients may still show the link as plain text. HTTPS App Links remain as a fallback for non-Android / desktop mail.

On success the verify handler sets an **EmDash session cookie** for that host and redirects (typically to `/_emdash/admin`). That is why operators often land in the admin UI after clicking.

### Single-use + 15-minute TTL (EmDash upstream)

Upstream (`emdash` + `@emdash-cms/auth`, v0.29) documents and implements:

- Tokens expire after **15 minutes**.
- Tokens are **strictly single-use**: `verifyMagicLink` **deletes** the hashed token from the DB before creating the session.
- There is **no** EmDash config for multi-use / `allowedAttempts` (unlike Better Auth). A second GET with the same `?token=` always fails.

Login error query params after redirect to `/_emdash/admin/login?error=…`:

| `error=` | Upstream `MagicLinkError.code` | Meaning |
|----------|--------------------------------|---------|
| `invalid_link` | `invalid_token` | Hash not in DB (already used / never existed / garbage token), or token row had no `userId` |
| `link_expired` | `token_expired` | Past `expiresAt` (TTL) |
| `missing_token` | *(route check)* | Verify hit **without** `?token=` |
| `user_not_found` | `user_not_found` | Token OK but user gone |
| `verification_failed` | *(other)* | Unexpected throw |

Seeing **`Authentication error: invalid_link` in the Capacitor app** means the WebView **did reach** the verify route with *some* token — App Links are not dropping the query string entirely (that would be `missing_token`). The token was already consumed or never matched.

“Passkeys Not Available Here” on the login page is expected in Android WebView; it is unrelated to why verify failed.

## Android App Links (registered)

The Capacitor Android shell registers HTTPS App Links for:

| Host | Paths |
|------|--------|
| `freedomtimes.news` | entire host (includes magic-link verify) |
| `staging.freedomtimes.news` | entire host (debug / staging builds) |

See `web/android/app/src/main/AndroidManifest.xml` (`android:autoVerify="true"`) and `GET /.well-known/assetlinks.json` (package `news.freedomtimes.app` + staging/debug SHA-256; Play signing cert still separate — [ANDROID_CAPACITOR_BUILD.md](./ANDROID_CAPACITOR_BUILD.md)).

When Android delivers a **VIEW** intent for those HTTPS URLs, Capacitor fires `appUrlOpen` / `getLaunchUrl`. [`native-auth-bridge.ts`](../src/lib/native-auth-bridge.ts) loads that exact URL in the **WebView** so the magic-link token is consumed in the app cookie jar (opening the app to the homepage without the verify URL would leave you logged out).

### Outlook Safe Links (Firefox + token burn)

Operator-observed wrapped link:

```text
https://emea01.safelinks.protection.outlook.com/?url=https%3A%2F%2Ffreedomtimes.news%2F_emdash%2Fapi%2Fauth%2Fmagic-link%2Fverify%3Ftoken%3D…
```

Decoded target is the EmDash verify URL above. Two failure modes matter for Capacitor:

**A — Click opens Firefox (session left in the browser)**

1. The **initial** VIEW is for `safelinks.protection.outlook.com` — Android App Links for `freedomtimes.news` **cannot** claim that click.
2. Safe Links redirects into whatever browser already owns the navigation (often **Firefox**).
3. EmDash verify runs **in Firefox**, sets cookies in **Firefox’s jar**, then redirects — still in Firefox.
4. App Links do **not** steal an in-browser redirect. They apply when Android creates a **new VIEW** for a matching HTTPS URL (Gmail “Open with”, long-press → Freedom Times, `adb`, copy/paste unwrap, etc.).
5. Opening the Capacitor app **after** Firefox already completed verify does **not** copy the session — separate cookie jars. Re-opening the **same** link in the app then yields **`invalid_link`** (token already deleted).

**B — Safe Links / Defender prefetch GET (token burned before any human click)**

Microsoft Safe Links and similar scanners often **HTTP GET** the rewritten target before the user taps. Because EmDash deletes the token on the first successful verify GET, that prefetch can leave a dead link. The human tap (browser or App Link) then lands on login with **`invalid_link`**. This matches “App Links work, but auth error” when the open path is correct.

**Practical testing with Outlook mail:**

- Request a **new** magic link; do **not** reuse a link already opened in Firefox (or already scanned).
- Prefer Gmail / a mailbox without Safe Links wrapping, or ask the M365 tenant admin for a Safe Links **do-not-rewrite** exception for `freedomtimes.news` / `*/_emdash/api/auth/magic-link/*`.
- Best isolation: copy the **unwrapped** `https://freedomtimes.news/_emdash/api/auth/magic-link/verify?token=…` from the mail source (or Safe Links `url=` query) and cold-open it with `adb` (below) **before** any other client GETs it.
- Long-press → **Open with** Freedom Times only helps if the token is still unused.

There is no Freedom Times knobs for multi-use TTL. Mitigations if scanners keep burning tokens: M365 allowlist, Gmail for staff tests, or a future human-click lander (GET returns HTML; only POST/confirm consumes) — would be custom or an EmDash upstream change.

### Capacitor App Link path (query string)

[`native-auth-bridge.ts`](../src/lib/native-auth-bridge.ts) passes `App.getLaunchUrl` / `appUrlOpen` through `new URL(…).toString()` and `location.replace` — **full URL including `?token=`**. Intent host filters do not strip the query. No App Link truncation bug was found for `invalid_link` (again: missing token → `missing_token`).

### Operator: verify with a fresh unused token

**A — Custom scheme (Capacitor Android email path)**

1. Open `/_emdash/admin/login` **inside the Capacitor Android app** (so `ft_native_android=1` is set).
2. Request a **new** magic link; do not open it yet.
3. Confirm the email Sign-in button is `news.freedomtimes.app://auth/magic-link/verify?token=…` (not `https://…`).
4. Tap the link (or cold-open with adb). Expect the app to open and land in `/_emdash/admin` signed in.

```powershell
adb shell am start -a android.intent.action.VIEW -d "news.freedomtimes.app://auth/magic-link/verify?token=YOUR_FRESH_TOKEN&ft_origin=https%3A%2F%2Ffreedomtimes.news"
```

**B — HTTPS App Link / adb (desktop request or fallback)**

1. On a desktop browser (or the app) request a **new** magic link; do not open the email link yet.
2. Unwrap to the bare verify URL (decode Safe Links `url=` if needed). Keep it secret; any GET burns it.
3. Cold-open **only** in the app:

```powershell
adb shell am start -a android.intent.action.VIEW -d "https://freedomtimes.news/_emdash/api/auth/magic-link/verify?token=YOUR_FRESH_TOKEN"
```

4. Expect redirect into `/_emdash/admin` (signed in), **not** login with `invalid_link`.
5. Optional negative check: run the **same** `adb` command again → should show `invalid_link` (proves single-use).

**Deploy notes:** email rewrite + bridge handler ship with the **web Worker**. The AndroidManifest magic-link intent-filter needs an **APK rebuild** (once) to register `…://auth/magic-link/verify`.

Asset Links / install notes: [ANDROID_CAPACITOR_BUILD.md](./ANDROID_CAPACITOR_BUILD.md) § App Links.

## Related

- Android Digital Asset Links: `GET /.well-known/assetlinks.json` ([`assetlinks.json.ts`](../src/pages/.well-known/assetlinks.json.ts)) — required for **verified** App Links (`autoVerify`); not required for EmDash email delivery itself.
- Auth0 `/admin` still uses custom-scheme `news.freedomtimes.app://auth/callback`. EmDash Capacitor Android magic links use `news.freedomtimes.app://auth/magic-link/verify` (same scheme).
