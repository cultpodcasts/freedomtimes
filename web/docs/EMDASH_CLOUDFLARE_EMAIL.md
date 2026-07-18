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

### Provider upgrade path (follow-up — **not** in this change)

| Today | Needed for TF-owned `EMAIL` |
|-------|------------------------------|
| Cloudflare provider `~> 4.0` (locked ~4.52.x) | Provider **v5** (`~> 5`) |
| Nested `analytics_engine_binding` / no `send_email` | Unified `bindings = [{ type = "send_email", name = "EMAIL", … }]` on `cloudflare_workers_script` |

**Do not bump provider in the EmDash email PR.** v4 → v5 is a ground-up rewrite. In this repo it forces at least:

- Rewrite `modules/cloudflare_holding_page` (`name` → `script_name`; nested `*_binding` → `bindings`; lifecycle `ignore_changes` must be redesigned for Wrangler-owned KV/R2)
- **`cloudflare_workers_secret` is removed in v5** — today TF pushes `TURNSTILE_*` and `CLOUDFLARE_ANALYTICS_API_TOKEN` via that resource; need Secrets Store / `secret_text` / other replacement
- `cloudflare_workers_domain` → `cloudflare_workers_custom_domain`
- `cloudflare_record` → `cloudflare_dns_record` (FQDN `name`, `content` vs `value`)
- Staging + production HCP workspaces + lockfiles; plan both before apply
- Prefer official [tf-migrate](https://github.com/cloudflare/tf-migrate) + [v5 upgrade guide](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/guides/version-5-upgrade); this repo uses **modules**, so expect manual review

Until that follow-up lands, keep `wrangler.jsonc` `send_email` in sync so Worker **deploy** applies `EMAIL` (same pattern as KV/R2).

**Email Sending domain onboard** still has **no** first-class Terraform resource in provider 5.x (only `email_routing_*` exists). API `POST …/email_sending/subdomains` exists; onboard remains dashboard (or operator CLI), not TF.

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
