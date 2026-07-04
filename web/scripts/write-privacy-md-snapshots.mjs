/**
 * One-off local prep: write markdown snapshot files from live CMS markdown exports.
 * Run after content_get (markdown:true) — updates _tmp-*-privacy.md from embedded rev tokens.
 */
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");

// Markdown bodies match content_get (markdown:true) as of 2026-07-04T20:03Z.
// Only the intro date line differs between before/after bump.

const STAGING_REV = "MjoyMDI2LTA3LTA0VDIwOjAzOjE2LjE5NFo=";
const PRODUCTION_REV = "NDoyMDI2LTA3LTA0VDIwOjAzOjE3LjkyMVo=";

const sharedTail = String.raw`

## Summary

Nothing in this policy contradicts the following statements:

1. We don't collect any of your personal info, including your IP address, other than information you voluntarily provide.
1. We don't sell your personal info to advertisers or other third parties.
1. We share your personal info only when legally required, or when reasonably necessary to prevent harm in an emergency situation.
1. We retain your personal info, excluding info you make public, for no more than 30 days after you request deletion.
1. We have never received any legal or government demands for user information.

## Complete terms

As used in this policy, "Personal Info" is data that can identify a particular person or device. Aggregate data isn't considered Personal Info.

**1. Freedom Times never collects your Personal Info except to communicate with you**

Our Services don't collect any of your Personal Info. Unlike most websites, our site doesn't collect your IP address. We do detect non-personally identifiable geo-location information to optimize our services, but we definitely don't collect your precise geo-location or associate geo-location information with a particular user.

Because we do not collect information about your online activities over time and across third-party websites or online services, there is no need for us to respond to a browser's Do Not Track settings, although we strongly support a consumer's right to set such a preference and encourage all website operators to honor this consumer choice.

We may request your email address or a username to communicate with you. This info is used only as you'd expect and deleted upon request.

Optionally, you may choose to provide your email address and communicate with us via email.

To improve the Services and your experience on our site, we may collect aggregate usage data from the Services and our website, including number of page views, visitor browser types, operating systems, or the links clicked to navigate to and from our site. None of the aggregate data that may be collected has associated user or device data. Our cookies don't track you. Or check your browser preferences.

**2. Freedom Times never sells your email address or any other Personal Info you volunteer**

We don't receive payment in cash or in kind from third parties in exchange for your Personal Info. Further, we don't allow third parties to collect info about you on our site through cookies or other means.

**3. Freedom Times shares your Personal Info only in specific circumstances**

There are a few, rare circumstances when we may have to share your Personal Info either to obey the law or protect our rights. We'll share your Personal Info only to comply with laws or legally enforceable requests, to enforce our own rights and contracts with users or third parties, or to prevent harm to others and their property in an emergency situation.

In all instances, we'll share the minimum info necessary to meet the immediate need and inform you of our disclosure when legally and practically possible.

**4. Freedom Times retains the Personal Info you volunteer for one month or less**

We remove your Personal Info from our records within 30 days of any request to do so.

**5. Transparency report**

As explained above, we will comply with a request for user data when the law requires it, but we require valid legal process to compel the disclosure of user data to the government; such as a legitimate and properly scoped court order, or a search warrant supported by probable cause and issued by an appropriate law enforcement authority. We interpret requests narrowly, and we will oppose unlawful or overbroad requests for specific user data.

Recipients of National Security Requests can only publish reporting bands instead of specific figures. If we receive such a request, we may challenge these reporting bands, in addition to opposing any unlawful or overbroad requests.

## Story tips (/submit-a-tip)

When you submit a story tip:

**What Freedom Times stores**

- **Anonymous (default):** your tip text and when you sent it. We do not save your name, email, IP address, or account details.
- **With contact details:** your tip text plus the name and email you provide so we can follow up.
- **Retention:** tips are kept for editorial review and deleted on request where applicable (contact privacy@freedomtimes.news).

**What Cloudflare does for the bot check**

Before your tip reaches us, [Cloudflare Turnstile](https://www.cloudflare.com/en-gb/application-services/products/turnstile/) runs a spam check on Cloudflare's systems using technical browser signals (such as IP address, browser type, and connection details). We do not receive or store those signals. Cloudflare says it uses them only to tell humans from bots — not to identify you or show you ads. See Cloudflare's [Turnstile privacy addendum](https://www.cloudflare.com/turnstile-privacy-policy/).

For GDPR, third-party roles, lawful bases, and how to exercise your rights, see **Third-party services (Cloudflare Turnstile)** below.

You can verify the handler source code linked from [/tip-source](/tip-source).

## Third-party services (Cloudflare Turnstile)

We use Cloudflare Turnstile on /submit-a-tip to block automated spam before tips reach our editorial team.

**Roles**

- **Freedom Times (data controller):** we decide why and how your tip is processed. For the Turnstile bot check, Cloudflare acts as our data processor — it handles browser signals on our instructions, solely to detect bots.
- **Cloudflare (also data controller):** Cloudflare separately processes the same signals to improve Turnstile's bot detection. This is described in Cloudflare's [Turnstile privacy addendum](https://www.cloudflare.com/turnstile-privacy-policy/).

**What Cloudflare collects**

When you complete the check, Cloudflare processes technical signals such as your IP address, TLS fingerprint, browser user-agent, site key, and the site you are visiting. Cloudflare states it cannot directly identify individuals from these signals and does not use them to identify, profile, or target you.

**Lawful basis (EU and UK residents)**

- **For bot detection on our behalf, we rely on our ****legitimate interest** in protecting our submission form from abuse. As controller, we determine the lawful basis; Cloudflare processes on our instructions.
- **For improving Turnstile, Cloudflare relies on its ****legitimate interests** in maintaining effective bot detection (see the addendum, section 5).

**International transfers**

Processing may involve transfers outside your country. Safeguards and further detail are in Cloudflare's [privacy policy](https://www.cloudflare.com/privacypolicy/) and the [Turnstile privacy addendum](https://www.cloudflare.com/turnstile-privacy-policy/).

**Your rights**

- To exercise data protection rights relating to Turnstile on our site, contact **privacy@freedomtimes.news**. Cloudflare directs visitors to contact the website operator (us) for processor-related requests.
- For Cloudflare's own processing as controller, you may also contact Cloudflare's Data Protection Officer at **dpo@cloudflare.com**.

## Notification troubleshooting ("Report a problem")

When you send a diagnostic report from the notification callout:

- We store a sanitized technical snapshot (browser family, OS family, notification permission state, service worker status, whether a push subscription exists, push service hostname only if subscribed, page path, and optional note you type).
- We do not store your IP address, email, account details, raw user agent string, full push subscription URL, or cryptographic keys.
- Reports are used only to debug notification delivery issues.

Story tips use a dedicated tips database. Notification diagnostic reports are stored in the subscriptions database alongside push subscription records (same Worker secrets: TURSO_SUBSCRIPTIONS_*).

## Changes to this policy

We may make small, inconsequential changes to this policy with or without notice to you, so you're encouraged to review the policy from time to time. Substantive changes to this policy will be emailed to users who submit a request to [privacy@freedomtimes.news](mailto:privacy@freedomtimes.news).

## Contact

You can contact us at [privacy@freedomtimes.news](mailto:privacy@freedomtimes.news) if you have any questions about this policy.
`;

const stagingIntro =
	"# Freedom Times Privacy Policy\n\nThis policy was updated May 9, 2026\n\nWe're committed to protecting your privacy and collecting only the minimum amount of info needed to provide our software and services (including the app Freedom Times) — referred to as \"Services\". Your use of the Services indicates you agree to this policy and our [terms of use](https://disconnect.me/terms).\n";

const productionIntro =
	"# Freedom Times Privacy Policy\n\nThis policy was updated May 9, 2026\n\nWe're committed to protecting your privacy and collecting only the minimum amount of info needed to provide our software and services (including the app Freedom Times) — referred to as \"Services\". Your use of the Services indicates you agree to this policy and our [terms of use](/terms-conditions).\n";

for (const [env, md, rev] of [
	["staging", stagingIntro + sharedTail, STAGING_REV],
	["production", productionIntro + sharedTail, PRODUCTION_REV],
]) {
	writeFileSync(join(repoRoot, `_tmp-${env}-privacy.md`), md);
	writeFileSync(
		join(repoRoot, `_tmp-privacy-policy-${env}-snapshot.json`),
		JSON.stringify({
			_rev: rev,
			item: { status: "published", data: { content: md } },
		}),
	);
}

console.log("snapshots ready");
