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
| Worker **bundle** | Wrangler deploy | `deploy-*-local.ps1` / CI |
| `send_email` binding `EMAIL` | **Declared in** [`web/wrangler.jsonc`](../wrangler.jsonc) (staging + production) | Cloudflare Terraform provider **4.x** cannot express `send_email`. Same class as KV/R2: Wrangler deploy applies the binding. Do **not** `wrangler secret put` / ad-hoc binding edits. |
| Email Sending **domain onboard** (`freedomtimes.news`) | Operator (dashboard) | No first-class TF resource for Email Sending onboard yet. Creates `cf-bounce.*` DNS; does **not** replace apex Email Routing MX used for redirects. |
| Apex Email Routing redirects | Existing dashboard setup (outside this repo) | Coexists with Sending — keep redirects intact |
| `_dmarc` / Sending DNS | Operator review after onboard | Prefer soft `p=none` if Cloudflare proposes `p=reject` before you are ready |
| EmDash plugin activation | Operator (EmDash UI) | Cannot be Terraform'd |

True Terraform ownership of the Worker `send_email` binding needs a **Cloudflare provider v5** migration (`bindings` with `type = "send_email"`). Track that as a follow-up; until then keep `wrangler.jsonc` in sync with the intended binding so deploys do not drop it.

## One-time operator steps (after merge + Worker deploy)

1. **Onboard Email Sending** for `freedomtimes.news`  
   Cloudflare dashboard → **Compute** → **Email Service** → **Email Sending** → **Onboard Domain** → apex.  
   Confirm existing Email Routing redirects still work (`privacy@`, etc.).

2. **Deploy** the web Worker (staging first) so `send_email` → `EMAIL` is present.  
   Do not mutate bindings via one-off `npx wrangler` commands.

3. **Activate in EmDash** (per environment):  
   - Sign in to `/_emdash/admin` (desktop passkey)  
   - **Admin → Extensions** → activate **Cloudflare Email**  
   - **Settings → Email** → select that provider  

4. **Test magic link** from the Android app (or any client without passkeys).

## Related

- Android Digital Asset Links: `GET /.well-known/assetlinks.json` ([`assetlinks.json.ts`](../src/pages/.well-known/assetlinks.json.ts)) — optional for App Links / passkey WebView spikes; **not** required for magic link.
- Auth0 `/admin` and custom-scheme `news.freedomtimes.app://auth/callback` are separate from EmDash auth.
