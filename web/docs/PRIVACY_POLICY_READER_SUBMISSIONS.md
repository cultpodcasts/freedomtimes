# Privacy policy — reader submissions (CMS copy draft)

Add these sections to the EmDash **Privacy Policy** page (`/privacy-policy`). Do not publish to production CMS until editorial review.

## Story tips (`/submit-a-tip`)

When you submit a story tip:

- **Anonymous mode (default):** we store only the text of your tip and the time submitted. We do not store your name, email, IP address, or account information in our tip database.
- **Identified mode:** if you choose to provide contact details, we store your tip text plus the name and email you supply so we can follow up.
- **Human verification:** we use Cloudflare Turnstile to reduce spam. Cloudflare may process technical data at the edge; our application handler does not write IP addresses to the tips database.
- **Retention:** tips are kept for editorial review and deleted on request where applicable (contact privacy@freedomtimes.news).

You can verify the handler source code linked from [/tip-source](/tip-source).

## Notification troubleshooting ("Report a problem")

When you send a diagnostic report from the notification callout:

- We store a **sanitized technical snapshot** (browser family, OS family, notification permission state, service worker status, whether a push subscription exists, push service hostname only if subscribed, page path, and optional note you type).
- We do **not** store your IP address, email, account details, raw user agent string, full push subscription URL, or cryptographic keys.
- Reports are used only to debug notification delivery issues.

Story tips use a dedicated tips database. Notification diagnostic reports are stored in the subscriptions database alongside push subscription records (same Worker secrets: `TURSO_SUBSCRIPTIONS_*`).
