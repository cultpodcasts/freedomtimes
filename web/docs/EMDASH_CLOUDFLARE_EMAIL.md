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

EmDash emails a verify URL on the **site origin** that issued the login (production example):

```text
https://freedomtimes.news/_emdash/api/auth/magic-link/verify?token=<opaque>
```

On success the verify handler sets an **EmDash session cookie** for that host and redirects (typically to `/` or `/_emdash/admin`). That is why operators often land on the **site apex** after clicking.

## Android App Links (registered)

The Capacitor Android shell registers HTTPS App Links for:

| Host | Paths |
|------|--------|
| `freedomtimes.news` | entire host (includes magic-link verify) |
| `staging.freedomtimes.news` | entire host (debug / staging builds) |

See `web/android/app/src/main/AndroidManifest.xml` (`android:autoVerify="true"`) and `GET /.well-known/assetlinks.json` (package `news.freedomtimes.app` + staging/debug SHA-256; Play signing cert still separate — [ANDROID_CAPACITOR_BUILD.md](./ANDROID_CAPACITOR_BUILD.md)).

When Android delivers a **VIEW** intent for those HTTPS URLs, Capacitor fires `appUrlOpen` / `getLaunchUrl`. [`native-auth-bridge.ts`](../src/lib/native-auth-bridge.ts) loads that exact URL in the **WebView** so the magic-link token is consumed in the app cookie jar (opening the app to the homepage without the verify URL would leave you logged out).

### Outlook Safe Links (primary reason Firefox opens today)

Operator-observed wrapped link:

```text
https://emea01.safelinks.protection.outlook.com/?url=https%3A%2F%2Ffreedomtimes.news%2F_emdash%2Fapi%2Fauth%2Fmagic-link%2Fverify%3Ftoken%3D…
```

Decoded target is the EmDash verify URL above. What happens on tap:

1. The **initial** VIEW is for `safelinks.protection.outlook.com` — Android App Links for `freedomtimes.news` **cannot** claim that click.
2. Safe Links redirects into whatever browser already owns the navigation (often **Firefox**).
3. EmDash verify runs **in Firefox**, sets cookies in **Firefox’s jar**, then redirects to `https://freedomtimes.news/` — still in Firefox.
4. App Links do **not** steal an in-browser redirect or mid-tab navigation. They apply when Android creates a **new VIEW** for a matching HTTPS URL (Gmail “Open with”, long-press → Freedom Times, `adb`, copy/paste unwrap, etc.).
5. Opening the Capacitor app **after** Firefox already completed verify does **not** copy the session — WebView and Firefox are separate cookie jars. Staff still need to complete magic link **inside** the app (or use another client that opens the unwrapped URL in the app).

**Practical testing with Outlook mail:**

- Long-press the link → **Open with** / choose Freedom Times (if offered), or copy link → unwrap the `url=` query param → open `https://freedomtimes.news/_emdash/...` via App Links.
- Prefer a mailbox without Safe Links wrapping (Gmail, or M365 Safe Links bypass for `freedomtimes.news` / `*/_emdash/api/auth/magic-link/*` if you control the tenant).
- Accept browser EmDash CMS login for desktop/passkey; App Links are for native open-with, not a full fix for Safe Links→Firefox alone.

Verification steps (`adb`, Asset Links status): [ANDROID_CAPACITOR_BUILD.md](./ANDROID_CAPACITOR_BUILD.md) § App Links.

## Related

- Android Digital Asset Links: `GET /.well-known/assetlinks.json` ([`assetlinks.json.ts`](../src/pages/.well-known/assetlinks.json.ts)) — required for **verified** App Links (`autoVerify`); not required for EmDash email delivery itself.
- Auth0 `/admin` still uses custom-scheme `news.freedomtimes.app://auth/callback` (separate from EmDash magic links).
