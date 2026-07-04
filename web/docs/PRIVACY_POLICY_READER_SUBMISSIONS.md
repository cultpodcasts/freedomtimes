# Privacy policy — reader submissions (CMS copy draft)

Add these sections to the EmDash **Privacy Policy** page (`/privacy-policy`). Do not publish to production CMS until editorial review.

## Updated date (operators)

When you change privacy policy content in EmDash (staging and production):

1. **Back up first** — `content_get` on `pages` / `privacy-policy` and save the JSON before any `content_update`.
2. **CMS metadata** — saving the page sets `updatedAt`. The site header shows **Updated** when that timestamp is after **Published** (`EntryHeader.astro`).
3. **Intro paragraph** — the second body block still reads `This policy was updated …`. Bump that date to match the substantive edit (e.g. `This policy was updated 4 July 2026`) on **both** staging and production, or remove the line if you rely on the header only.
4. **After Turnstile / reader-submission edits** — merge sections from this doc, then update the intro date and verify `/privacy-policy` shows **Published** (original) and **Updated** (today) in the header.

## Story tips (`/submit-a-tip`)

When you submit a story tip:

**What Freedom Times stores**

- **Anonymous (default):** your tip text and when you sent it. We do not save your name, email, IP address, or account details.
- **With contact details:** your tip text plus the name and email you provide so we can follow up.
- **Retention:** tips are kept for editorial review and deleted on request where applicable (contact privacy@freedomtimes.news).

**What Cloudflare does for the bot check**

- Before your tip reaches us, [Cloudflare Turnstile](https://www.cloudflare.com/en-gb/application-services/products/turnstile/) runs a spam check on Cloudflare's systems using technical browser signals (such as IP address, browser type, and connection details). We do not receive or store those signals. Cloudflare says it uses them only to tell humans from bots — not to identify you or show you ads. See Cloudflare's [Turnstile privacy addendum](https://www.cloudflare.com/turnstile-privacy-policy/).

For GDPR, third-party roles, lawful bases, and how to exercise your rights, see **Third-party services (Cloudflare Turnstile)** below.

You can verify the story-tip handler source at the Git commit linked from [/tip-source](/tip-source).

## Third-party services (Cloudflare Turnstile)

We use Cloudflare Turnstile on `/submit-a-tip` to block automated spam before tips reach our editorial team.

**Roles**

- **Freedom Times (data controller):** we decide why and how your tip is processed. For the Turnstile bot check, Cloudflare acts as our **data processor** — it handles browser signals on our instructions, solely to detect bots.
- **Cloudflare (also data controller):** Cloudflare separately processes the same signals to improve Turnstile's bot detection. This is described in Cloudflare's [Turnstile privacy addendum](https://www.cloudflare.com/turnstile-privacy-policy/).

**What Cloudflare collects**

When you complete the check, Cloudflare processes technical signals such as your IP address, TLS fingerprint, browser user-agent, site key, and the site you are visiting. Cloudflare states it cannot directly identify individuals from these signals and does not use them to identify, profile, or target you.

**Lawful basis (EU and UK residents)**

- For bot detection on our behalf, we rely on our **legitimate interest** in protecting our submission form from abuse. As controller, we determine the lawful basis; Cloudflare processes on our instructions.
- For improving Turnstile, Cloudflare relies on its **legitimate interests** in maintaining effective bot detection (see the addendum, section 5).

**International transfers**

Processing may involve transfers outside your country. Safeguards and further detail are in Cloudflare's [privacy policy](https://www.cloudflare.com/privacypolicy/) and the [Turnstile privacy addendum](https://www.cloudflare.com/turnstile-privacy-policy/).

**Your rights**

- To exercise data protection rights relating to Turnstile on our site, contact **privacy@freedomtimes.news**. Cloudflare directs visitors to contact the website operator (us) for processor-related requests.
- For Cloudflare's own processing as controller, you may also contact Cloudflare's Data Protection Officer at **dpo@cloudflare.com**.

## Notification troubleshooting ("Report a problem")

When you send a diagnostic report from the notification callout:

- We store a **sanitized technical snapshot** (browser family, OS family, notification permission state, service worker status, whether a push subscription exists, push service hostname only if subscribed, page path, and optional note you type).
- We do **not** store your IP address, email, account details, raw user agent string, full push subscription URL, or cryptographic keys.
- Reports are used only to debug notification delivery issues.
