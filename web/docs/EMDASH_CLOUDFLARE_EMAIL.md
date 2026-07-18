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
| Worker **bundle** (Astro/EmDash code) | Wrangler deploy | `deploy-*-local.ps1` / CI |
| `send_email` binding `EMAIL` | **Terraform** (`cloudflare_workers_script` bindings, provider **~> 5.22**) | Declared in `modules/cloudflare_holding_page`. Mirror in [`web/wrangler.jsonc`](../wrangler.jsonc) so Worker **deploy** does not strip it. |
| `PAGE_VIEWS` analytics_engine | Terraform | Same script resource; dataset id from tfvars / output |
| `TURNSTILE_*`, `CLOUDFLARE_ANALYTICS_API_TOKEN` | Terraform | `secret_text` bindings (replaces removed v4 `cloudflare_workers_secret`) |
| KV `SESSION` / R2 `MEDIA` | Wrangler | Preserved across TF updates via `keep_bindings` |
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

## Related

- Android Digital Asset Links: `GET /.well-known/assetlinks.json` ([`assetlinks.json.ts`](../src/pages/.well-known/assetlinks.json.ts)) — optional for App Links; **not** required for magic link. Production SHA-256 write-up: [ANDROID_CAPACITOR_BUILD.md](./ANDROID_CAPACITOR_BUILD.md).
- Auth0 `/admin` and custom-scheme `news.freedomtimes.app://auth/callback` are separate from EmDash auth.
