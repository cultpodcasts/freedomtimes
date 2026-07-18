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

## One-time operator steps (after merge)

1. **Terraform apply** staging (then production) — provider v5 migration + `EMAIL` binding. Plan first; do not apply until reviewed.
2. **Onboard Email Sending** for `freedomtimes.news`  
   Cloudflare dashboard → **Compute** → **Email Service** → **Email Sending** → **Onboard Domain** → apex.  
   Confirm existing Email Routing redirects still work (`privacy@`, etc.).
3. **Deploy** the web Worker (staging first) so the Astro bundle + wrangler.jsonc bindings match.  
   Do not mutate bindings via one-off `npx wrangler` commands.
4. **Activate in EmDash** (per environment):  
   - Sign in to `/_emdash/admin` (desktop passkey)  
   - **Admin → Extensions** → activate **Cloudflare Email**  
   - **Settings → Email** → select that provider  
5. **Test magic link** from the Android app (or any client without passkeys).

## Related

- Android Digital Asset Links: `GET /.well-known/assetlinks.json` ([`assetlinks.json.ts`](../src/pages/.well-known/assetlinks.json.ts)) — optional for App Links / passkey WebView spikes; **not** required for magic link.
- Auth0 `/admin` and custom-scheme `news.freedomtimes.app://auth/callback` are separate from EmDash auth.
