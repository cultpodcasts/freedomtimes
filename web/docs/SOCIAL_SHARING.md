# Sharing posts to social networks (admin only)

Admins can share a published post to the Freedom Times **Bluesky** account
([#21](https://github.com/cultpodcasts/freedomtimes/issues/21)) and **X** account
([#20](https://github.com/cultpodcasts/freedomtimes/issues/20)) from the EmDash admin. Nothing posts
automatically from the button. An admin opens the post, checks the preview, presses the button and confirms. Each network is
shared separately. The text is the social title, then `#Cult` and a hashtag for each name in the post's organisations field, then the article link. Each network fills its own limit, so X can carry more tags than Bluesky. A tag that does not fit is skipped. The panels offer the post, including an intent link that opens in a new tab when secrets are not set. Publishing does not post. An agent may offer to post after the article has been live for 30 minutes ([X_AUTO_POST.md](./X_AUTO_POST.md)). Only production posts to the real accounts. On staging the panels can be tested
([#178](https://github.com/cultpodcasts/freedomtimes/issues/178)): as a **dry run** that sends nothing, or against
separate **test accounts** ([§ Testing on staging](#testing-on-staging)).

## Where it is

- **EmDash admin only.** Open a saved post in the EmDash admin (`/_emdash/admin`, Content → Posts → the post).
  The editor sidebar shows a **Post to Bluesky** panel and a **Post to X** panel.
- No public page, layout, component, script or static file renders the panels, the buttons or the route URLs.
  `scripts/test-social-share.mts` scans `src/` and `public/` to keep it that way.
- Code: `src/plugins/social-share.ts` (site-local native EmDash plugin `ft-social-share`, registered in
  `astro.config.ts`) and `src/lib/social-share/` (the shared panel logic in `panel.ts`, the Bluesky client in
  `bluesky.ts`, the X client in `x.ts`). `manifest.ts` lists the hosts the plugin may call (`bsky.social` and
  `api.x.com`), and a test keeps `astro.config.ts` in step with it.

## Who can use it

- **Admins only.** The panel routes (`/_emdash/api/plugins/ft-social-share/editor/bluesky` and
  `…/editor/x`) are private and keep EmDash's default `plugins:manage` permission (Admin role). EmDash rejects
  them before the plugin runs:
  - 401 when there is no signed-in session;
  - 403 for Editor, Author, Contributor and Subscriber;
  - 403 for cookie requests without the `X-EmDash-Request: 1` header, so a cross-site form can't trigger them (CSRF).
- The handler checks the Admin role again. It also requires the context EmDash attaches when the request
  comes from the post editor panel, so a direct call to a route is refused (403).
- Responses are `Cache-Control: private, no-store`, and the reader page cache never stores `/_emdash/` paths.
- Editors and Authors still see the two boxes in the post editor sidebar, because EmDash lists editor panels for
  everyone who can edit the post. For them the boxes fail to load with EmDash's permission error (403). That is
  expected: only an Admin can load them or post.

## What each panel shows

`<Network>` is Bluesky or X.

| Situation | Panel |
|---|---|
| Staging, that network's test secrets not set | Banner **"Staging: dry run"**, then the dry-run preview (below). Button **Dry run: Post to `<Network>`**. Nothing is sent or recorded. |
| Staging, that network's test secrets set | Banner **"Staging: posting to test account `<account>`"**, then the states below as in production, but every post goes to the test account. Button **Post to `<Network>` test account**. |
| Local dev, or any host other than `freedomtimes.news` / `www.freedomtimes.news` / `staging.freedomtimes.news` | Banner **"Local: dry run"** and the dry-run preview. Nothing is ever sent or recorded, and no secret is read. |
| Production, that network's secrets not set | "`<Network>` sharing isn't configured", naming the secrets below. No post button. The exact text and an **Open `<Network>` to post** link, which opens that network's compose page in a new tab. |
| Draft, scheduled or unpublished post | "Publish this post first". No button. |
| Ready | The exact post text (title, blank line, article link) and the extra rows below, then **Post to `<Network>`**. The confirm dialog repeats the text and the account. |
| Already shared to that network | "Shared to `<Network>`", with the date, who posted it and a link to the post. No button. |
| Someone is posting right now | "Posting in progress". |
| Last attempt's outcome unknown | A warning to check the profile, with **Release lock** (confirm required). |

Extra preview rows: Bluesky shows the link card title and description. X shows the post's length as X counts it.

"Production" means the Worker runs with `SITE_ACCESS_MODE=public` (only the `production` env in
`wrangler.jsonc`) **and** the request host is `freedomtimes.news` or `www.freedomtimes.news`. "Staging" means
`SITE_ACCESS_MODE=locked` **and** the host `staging.freedomtimes.news`. Anything else (local dev, which is also
`locked`; preview hosts; a public Worker on another host) counts as local (`socialShareMode` in
`src/lib/social-share/policy.ts`).

The production panels show no mode banner and behave exactly as before #178.

## What gets posted

Each network gets the post's social title (else its SEO title, else its title), a blank line, `#Cult` and one
hashtag per organisations name that fits, a blank line, then `https://freedomtimes.news/posts/<slug>`. The link
is last and always complete. X fills 280 weighted characters (a link counts as 23). Bluesky fills 300 graphemes
(a link counts in full), so its hashtag line can be shorter. The title is shortened with "…" only when the tags
and the link leave no room. If the post text changed after the panel loaded, the click is refused and the panel
shows the new preview.

### Bluesky

- Limit: 300 characters (graphemes).
- The link is a clickable link facet, and the post carries a link card (`app.bsky.embed.external`) with the title,
  the SEO description (else the lede), and a thumbnail when the post has an OG/social image. The card image uses
  the same resolver as article `og:image` (`readArticleNotificationImagePath` / `socialImage.ts`: `seo.image`
  including bare media ids → `_emdash_seo.seo_image` → `social_image` → featured/cover), then only Freedom Times
  production/staging hosts. Bluesky does not scrape Open Graph for API posts, so the Worker reads that image
  from the `MEDIA` R2 binding by EmDash storage key (not via HTTP to `/_emdash/api/media/file/…` — a Worker
  same-zone fetch hangs), caps at 1 MB, uploads with `com.atproto.repo.uploadBlob` (`image/*`), and sets
  `external.thumb` to the blob. If the R2 read or upload fails, the text card still posts without a thumb.
  (RedditPodcastPoster’s Bluesky path GETs an *external* ThumbUrl from YouTube/Spotify CDNs; FT cannot do
  that for its own media, so R2 is the equivalent.)
- AT Protocol calls, to `https://bsky.social`:
  1. `com.atproto.server.createSession` with the handle and app password;
  2. `com.atproto.repo.uploadBlob` when card-image bytes were read from R2;
  3. `com.atproto.repo.createRecord` (`app.bsky.feed.post`).
- The account must be hosted by Bluesky. A custom-domain handle such as `freedomtimes.news` is fine.
  `bsky.social` forwards the calls to the account's Bluesky server. An account on a self-hosted PDS isn't
  supported, because the plugin can only reach `bsky.social` and `api.x.com`.

### X

- Limit: 280, counted the way X counts. The link always counts as 23, because X wraps every URL in `t.co`.
  Emoji and CJK characters count 2. Anything in the title that looks like a link (e.g. `freedomtimes.news`) is
  also counted as 23, so the title is never under-counted. At worst it is trimmed slightly more than X needs.
- Auth: OAuth 2.0 user context. Before each post the Worker refreshes the live refresh token at
  `POST https://api.x.com/2/oauth2/token`, then calls `POST https://api.x.com/2/tweets` with
  `Authorization: Bearer <access_token>` and `{"text": …}`. X builds the link card from Open Graph tags.
- **Refresh-token rotation.** With `offline.access`, X may return a new `refresh_token` on each refresh.
  Worker secrets are immutable from inside the Worker, so the live token is stored in plugin KV
  (`x-oauth:refresh-token` in production, `x-oauth-test:refresh-token` on staging). The Worker secret
  (`X_REFRESH_TOKEN` / `X_TEST_REFRESH_TOKEN`) bootstraps an empty or reminted store; a rotated value is
  written back to KV immediately after a successful refresh. Reminting the Worker secret (new fingerprint)
  re-bootstraps from the secret and ignores the previous KV entry.
- **Cost.** The X API is pay-per-use with prepaid credits and no subscription. X's pricing page
  ([docs.x.com/x-api/getting-started/pricing](https://docs.x.com/x-api/getting-started/pricing), checked
  31 Oct 2026) lists **Post: Create (with URL) at $0.200 per request**, against $0.015 for a post without a
  link. Every share here contains the article link, so each successful share costs about **$0.20** in X
  credits. The Developer Console shows the current rates and can set a spending limit. Bluesky is free.

## No double posting

Each share is recorded in the plugin's KV under `share:<network>:<post id>` (`share:bluesky:…` or `share:x:…`).
A post shared to Bluesky can still be shared to X once, and the other way round. Staging test-account shares use
`share-test:<network>:<post id>` in the staging database, so a production record copied into staging never blocks
a test post, and a test post is never counted as a real one. A dry run records nothing, so it never blocks a later
real or test post.

1. Before calling the network, the panel claims the key atomically. Only one click can win, even if two admins
   click at once.
2. On success the record becomes `posted` with the post's URL, the time and who posted it. The post can't be
   shared to that network again.
3. If the network rejects the request with a 4xx (for example a wrong app password, X keys without write
   permission, no X credits, or a rate limit), no post was made. The claim is released and the panel shows the
   error.
4. If the outcome is unknown (the connection dropped, a 5xx, or a success with no post id), the claim stays,
   because the post may exist. Check the profile. If the post isn't there, press **Release lock**. A claim that
   has been pending for more than 2 minutes counts as interrupted and can be released the same way.

## Setting the secrets (Jon)

Canonical source is **`.env.dev`** (same as Auth0 / Turso / push). Sync to the production Worker with
`scripts/set-github-secrets.ps1` (not GitHub Actions — these names are Worker-only). Staging uses separate
`*_TEST_*` names ([§ Testing on staging](#testing-on-staging)). Each network works on its own.

| `.env.dev` / Worker secret | Value |
|---|---|
| `BLUESKY_HANDLE` | The account handle, e.g. `freedomtimes.news` (a leading `@` is ignored). |
| `BLUESKY_APP_PASSWORD` | A Bluesky **app password** for that account, not the account password. |
| `X_CLIENT_ID` | X app **OAuth 2.0 Client ID**. |
| `X_CLIENT_SECRET` | X app **OAuth 2.0 Client Secret** (confidential / Web App). |
| `X_REFRESH_TOKEN` | User refresh token for the Freedom Times X account (`offline.access`). |

### Bluesky

1. Create the app password: sign in at [bsky.app](https://bsky.app) as the Freedom Times account →
   **Settings** → **Privacy and security** → **App passwords** → **Add App Password**. Name it e.g.
   `freedomtimes-admin`, leave direct-message access off, and copy it into `.env.dev` as `BLUESKY_APP_PASSWORD`
   (and set `BLUESKY_HANDLE`).

### X (OAuth 2.0)

1. Sign in at [console.x.com](https://console.x.com) **as the Freedom Times X account**. Buy credits and set a
   spending limit.
2. App → **User authentication settings**: type **Web App** (confidential), callback
   `http://127.0.0.1:9876/callback`, and enable OAuth 2.0. Copy **Client ID** and **Client Secret** into
   `.env.dev` as `X_CLIENT_ID` / `X_CLIENT_SECRET`.
3. Mint the user refresh token (scopes `tweet.read tweet.write users.read offline.access`), signed in as the
   FT account:

   ```powershell
   npx tsx web/scripts/mint-x-oauth2-refresh-token.mts
   ```

   Paste the printed `X_REFRESH_TOKEN=…` into `.env.dev`. For the staging test app, use `--test` instead
   ([§ Testing on staging](#testing-on-staging)) — do not rename `X_TEST_*` onto production key names.

### Sync to Cloudflare

```powershell
# Production Worker (requires -AllowProduction)
.\scripts\set-github-secrets.ps1 -Target Production -SyncCloudflareWorkerSecrets -AllowProduction
```

Empty social keys are skipped, so a normal Auth0/Turso sync still works before these are filled. Secrets take
effect without a redeploy.

Do **not** put production social values on staging. Staging reads only `*_TEST_*` ([below](#testing-on-staging)).

**Keeping the secrets.** Prefer re-running `set-github-secrets.ps1` after filling `.env.dev`. A production
**Terraform apply** can drop hand-set Worker `secret_text` bindings
([NON_TERRAFORM_RESOURCES.md](../../NON_TERRAFORM_RESOURCES.md#terraform-holding-page-drift)); if a panel says
"isn't configured", sync again from `.env.dev`.

**OAuth 2.0 cutover.** After the OAuth 2.0 secrets are live, delete the obsolete OAuth 1.0a Worker secrets from
staging and production (`X_API_KEY`, `X_API_KEY_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET`, and the
matching `X_TEST_*` OAuth 1.0a names) so Terraform drift / console clutter does not leave dead credentials.

**Remint.** If refresh fails with an invalid-grant style error: mint again (`mint-x-oauth2-refresh-token.mts` or
`--test`), paste into `.env.dev`, sync Worker secrets. The new secret fingerprint re-bootstraps plugin KV; you
do not need to clear `x-oauth:refresh-token` by hand.

## Testing on staging

Open a published post in the staging EmDash admin (`https://staging.freedomtimes.news/_emdash/admin`, behind the
Auth0 lock as usual).

### Dry run (no setup)

With no test secrets on the staging Worker, each panel shows **"Staging: dry run"**. It shows the exact post text,
the preview rows, and the request a real post would send, with credentials left out:

- Bluesky: the `com.atproto.repo.createRecord` body, with the `app.bsky.feed.post` record, its link facet and the
  `app.bsky.embed.external` link card (title, description, link). Thumb is **omitted in dry-run** —
  `uploadBlob` needs a live session; the intended image URL (if any) appears only in the preview “Link card image”
  row until a real or staging test post;
- X: the `POST /2/tweets` body `{"text": …}`. X builds the link card itself from the article page's Open Graph tags.

**Dry run: Post to `<Network>`** checks everything a real post checks (published, the preview hasn't changed),
rebuilds the post and shows *"Dry run: … Nothing was sent and nothing was recorded."* No network call, no
KV record, no confirm dialog. Local dev (`npm run dev`) always behaves like this, even with test secrets in
`.dev.vars`.

### Posting to test accounts (Jon)

Set staging-only test-account secrets on the **staging** Worker (`freedomtimes-staging`, wrangler env `staging`).
They use their own names, so staging can never read or use a production secret, and production never reads these.
Each network works on its own.

| Staging secret (`.env.dev`) | Value |
|---|---|
| `BLUESKY_TEST_HANDLE` | The test account's handle, e.g. `freedomtimes-test.bsky.social`. |
| `BLUESKY_TEST_APP_PASSWORD` | An app password for the test account. |
| `X_TEST_CLIENT_ID` | Test app OAuth 2.0 Client ID. |
| `X_TEST_CLIENT_SECRET` | Test app OAuth 2.0 Client Secret. |
| `X_TEST_REFRESH_TOKEN` | Test account refresh token (`offline.access`). |

**Bluesky test account.**

1. Sign up a separate account at [bsky.app](https://bsky.app) (e.g. `freedomtimes-test.bsky.social`), with its own
   email address. Bluesky has no private accounts, so its posts are public; say "test account" in its bio.
2. As that account: **Settings** → **Privacy and security** → **App passwords** → **Add App Password**, e.g.
   `freedomtimes-staging`, no direct-message access.
3. Put both into `.env.dev`, then:

   ```powershell
   .\scripts\set-github-secrets.ps1 -Target Staging -SyncCloudflareWorkerSecrets
   ```

**X test account.**

1. Create a separate X account for testing (its own email or phone), and protect its posts if you like
   (**Settings** → **Privacy and safety** → **Audience** → **Protect your posts**).
2. Sign in at [console.x.com](https://console.x.com) **as the test account**, create an OAuth 2.0 Web App with
   callback `http://127.0.0.1:9876/callback`, put `X_TEST_CLIENT_ID` / `X_TEST_CLIENT_SECRET` in `.env.dev`, then
   mint **without** renaming onto production keys:

   ```powershell
   npx tsx web/scripts/mint-x-oauth2-refresh-token.mts --test
   ```

   Paste the printed `X_TEST_REFRESH_TOKEN=…` into `.env.dev`.
3. Sync:

   ```powershell
   .\scripts\set-github-secrets.ps1 -Target Staging -SyncCloudflareWorkerSecrets
   ```

**Cost.** Every real test post to X contains the article link, so it costs about **$0.20** in the test developer
account's X credits (Post: Create with URL, $0.200 per request; see [§ X](#x)). Dry runs and Bluesky are free.

**What the test post contains.** Exactly what production would post, including the
`https://freedomtimes.news/posts/<slug>` link (never a staging link: staging is behind the Auth0 lock, so a card
can't be built from it). If the post exists only on staging, that link is a 404 on production, and X shows no card.

The panel then shows **"Staging: posting to test account `<account>`"**, and the button, confirm dialog and
toast all say "test account". A staging test share is recorded under `share-test:…` (see
[§ No double posting](#no-double-posting)), so each post can be shared once per network to the test account;
use **Release lock** only as described there.

To stop: clear the `*_TEST_*` values in `.env.dev` and delete the matching staging Worker secrets (or re-sync after
clearing). Revoke the app password / refresh grant in the network as well. A staging **Terraform apply** can drop
hand-set Worker secrets; sync again from `.env.dev` if a panel goes back to the dry run.

## Tests

`npm run test` includes `scripts/test-social-share.mts`. Bluesky and X are always mocked; no test can reach a
real account. It covers:

- the 401 and 403 rejections, and the editor-panel context check;
- the static check that both routes stay private with the default Admin permission;
- that `astro.config.ts` grants exactly the plugin's hosts;
- the scan of public files;
- the mode (production, staging, local) from `SITE_ACCESS_MODE` and the host;
- the staging dry run (exact text and request, nothing sent or recorded, no credential shown) and local dev always
  dry-running, even with test secrets;
- choosing the test account on staging (only the `*_TEST_*` names are read; posts go to the test credentials and
  are recorded under `share-test:`), and a dry run not blocking a later test post;
- production unchanged (no banner, same text, production names only, test names ignored);
- the missing-secret state;
- the preview and confirm dialog;
- Bluesky: the UTF-8 byte offsets of the link facet, and the 300-character limit;
- X: OAuth 2.0 token refresh then Bearer `POST /2/tweets`, and the 280 weighted limit with the link counted as 23;
- one post per click, two simultaneous clicks posting once, and Bluesky and X recorded separately;
- lock release.
