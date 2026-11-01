# Sharing posts to social networks (admin only)

Admins can share a published post to the Freedom Times **Bluesky** account
([#21](https://github.com/cultpodcasts/freedomtimes/issues/21)) and **X** account
([#20](https://github.com/cultpodcasts/freedomtimes/issues/20)) from the EmDash admin. Nothing posts
automatically. An admin opens the post, checks the preview, presses the button and confirms. Each network is
shared separately. Only production posts to the real accounts. On staging the panels can be tested
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
| Production, that network's secrets not set | "`<Network>` sharing isn't configured", naming the secrets below. No button. |
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

Both networks get the same text: the post's social title (else its SEO title, else its title), a blank line,
then `https://freedomtimes.news/posts/<slug>`. The title is shortened with "…" to fit the network's limit. The
link is always complete. If the post text changed after the panel loaded, the click is refused and the panel
shows the new preview.

### Bluesky

- Limit: 300 characters (graphemes).
- The link is a clickable link facet, and the post carries a link card (`app.bsky.embed.external`) with the title
  and the SEO description (else the lede). The card has no image.
- AT Protocol calls, both to `https://bsky.social`:
  1. `com.atproto.server.createSession` with the handle and app password;
  2. `com.atproto.repo.createRecord` (`app.bsky.feed.post`).
- The account must be hosted by Bluesky. A custom-domain handle such as `freedomtimes.news` is fine.
  `bsky.social` forwards the calls to the account's Bluesky server. An account on a self-hosted PDS isn't
  supported, because the plugin can only reach `bsky.social` and `api.x.com`.

### X

- Limit: 280, counted the way X counts. The link always counts as 23, because X wraps every URL in `t.co`.
  Emoji and CJK characters count 2. Anything in the title that looks like a link (e.g. `freedomtimes.news`) is
  also counted as 23, so the title is never under-counted. At worst it is trimmed slightly more than X needs.
- One call: `POST https://api.x.com/2/tweets` with `{"text": …}`, signed with OAuth 1.0a user context
  (HMAC-SHA1). X builds the link card itself from the article page's Open Graph tags.
- The confirm dialog names the account by the numeric user id at the start of the access token. That avoids a
  paid `users/me` lookup.
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

The real accounts' credentials are Worker secrets on the **production** Worker only (staging has its own
test-account names: [§ Testing on staging](#testing-on-staging)). They are never committed, and none are
set in GitHub, `.env.dev` or Terraform. Each network works on its own: set only Bluesky's, and only the
Bluesky panel goes live.

| Secret | Value |
|---|---|
| `BLUESKY_HANDLE` | The account handle, e.g. `freedomtimes.news` (a leading `@` is ignored). |
| `BLUESKY_APP_PASSWORD` | A Bluesky **app password** for that account, not the account password. |
| `X_API_KEY` | The X app's **API Key** (consumer key). |
| `X_API_KEY_SECRET` | The X app's **API Key Secret** (consumer secret). |
| `X_ACCESS_TOKEN` | The **Access Token** for the Freedom Times X account (starts with its numeric user id). |
| `X_ACCESS_TOKEN_SECRET` | The matching **Access Token Secret**. |

### Bluesky

1. Create the app password: sign in at [bsky.app](https://bsky.app) as the Freedom Times account →
   **Settings** → **Privacy and security** → **App passwords** → **Add App Password**. Name it e.g.
   `freedomtimes-admin`, leave direct-message access off, and copy it.
2. From `web/`, put both secrets on the production Worker (Wrangler prompts for each value, so nothing lands in
   shell history):

   ```powershell
   npx wrangler secret put BLUESKY_HANDLE --config wrangler.jsonc --env production
   npx wrangler secret put BLUESKY_APP_PASSWORD --config wrangler.jsonc --env production
   ```

To revoke: delete the app password in Bluesky (**Settings** → **Privacy and security** → **App passwords**),
then run `npx wrangler secret delete BLUESKY_APP_PASSWORD --config wrangler.jsonc --env production`.

### X

1. Sign in at [console.x.com](https://console.x.com) **as the Freedom Times X account**. The access token
   posts as the account that owns the app. Accept the developer agreement and buy credits (consider setting a
   spending limit).
2. Create an app. In its user authentication settings, set **App permissions** to **Read and write**.
3. On the app's **Keys and tokens** tab, copy the **API Key** and **API Key Secret**, then generate the
   **Access Token** and **Access Token Secret**. Generate the access token *after* setting Read and write.
   X's docs say changing an app's permissions needs new tokens to pick up the new scope, so a token made while
   the app was read-only can't post. If the panel shows "X refused the post" with a permission error,
   regenerate the access token and secret and set both again.
4. From `web/`:

   ```powershell
   npx wrangler secret put X_API_KEY --config wrangler.jsonc --env production
   npx wrangler secret put X_API_KEY_SECRET --config wrangler.jsonc --env production
   npx wrangler secret put X_ACCESS_TOKEN --config wrangler.jsonc --env production
   npx wrangler secret put X_ACCESS_TOKEN_SECRET --config wrangler.jsonc --env production
   ```

To revoke: regenerate (or revoke) the access token on the app's **Keys and tokens** tab, then run
`npx wrangler secret delete X_ACCESS_TOKEN_SECRET --config wrangler.jsonc --env production`.

### After setting them

Open a published post in the production EmDash admin. The panel for that network should show the preview and
the button. Secrets take effect without a redeploy.

Do **not** set these on staging. Staging never reads them (it reads only the `*_TEST_*` names below), and keeping
them off staging means a staging copy never holds the credentials.

**Keeping the secrets.** The normal production deploy (`wrangler deploy`, run when a PR merges) keeps Worker
secrets. A production **Terraform apply** re-uploads the Worker's Terraform-owned `secret_text` bindings and
can drop secrets set by hand (see
[NON_TERRAFORM_RESOURCES.md](../../NON_TERRAFORM_RESOURCES.md#terraform-holding-page-drift)). After a production
Terraform apply, open the panels. If one says "isn't configured", run that network's commands again. Wiring
these names into Terraform or `set-github-secrets.ps1` would make them survive, but it needs new GitHub or
`.env` secrets, so it is left for Jon to decide.

## Testing on staging

Open a published post in the staging EmDash admin (`https://staging.freedomtimes.news/_emdash/admin`, behind the
Auth0 lock as usual).

### Dry run (no setup)

With no test secrets on the staging Worker, each panel shows **"Staging: dry run"**. It shows the exact post text,
the preview rows, and the request a real post would send, with credentials left out:

- Bluesky: the `com.atproto.repo.createRecord` body, with the `app.bsky.feed.post` record, its link facet and the
  `app.bsky.embed.external` link card (title, description, link; no image);
- X: the `POST /2/tweets` body `{"text": …}`. X builds the link card itself from the article page's Open Graph tags.

**Dry run: Post to `<Network>`** checks everything a real post checks (published, the preview hasn't changed),
rebuilds the post and shows *"Dry run: … Nothing was sent and nothing was recorded."* No network call, no
KV record, no confirm dialog. Local dev (`npm run dev`) always behaves like this, even with test secrets in
`.dev.vars`.

### Posting to test accounts (Jon)

Set staging-only test-account secrets on the **staging** Worker (`freedomtimes-staging`, wrangler env `staging`).
They use their own names, so staging can never read or use a production secret, and production never reads these.
Each network works on its own.

| Staging secret | Value |
|---|---|
| `BLUESKY_TEST_HANDLE` | The test account's handle, e.g. `freedomtimes-test.bsky.social`. |
| `BLUESKY_TEST_APP_PASSWORD` | An app password for the test account. |
| `X_TEST_API_KEY` | The test X app's API Key. |
| `X_TEST_API_KEY_SECRET` | The test X app's API Key Secret. |
| `X_TEST_ACCESS_TOKEN` | The test X account's Access Token (starts with its numeric user id). |
| `X_TEST_ACCESS_TOKEN_SECRET` | The matching Access Token Secret. |

**Bluesky test account.**

1. Sign up a separate account at [bsky.app](https://bsky.app) (e.g. `freedomtimes-test.bsky.social`), with its own
   email address. Bluesky has no private accounts, so its posts are public; say "test account" in its bio.
2. As that account: **Settings** → **Privacy and security** → **App passwords** → **Add App Password**, e.g.
   `freedomtimes-staging`, no direct-message access.
3. From `web/` (Wrangler prompts for each value):

   ```powershell
   npx wrangler secret put BLUESKY_TEST_HANDLE --config wrangler.jsonc --env staging
   npx wrangler secret put BLUESKY_TEST_APP_PASSWORD --config wrangler.jsonc --env staging
   ```

**X test account.**

1. Create a separate X account for testing (its own email or phone), and protect its posts if you like
   (**Settings** → **Privacy and safety** → **Audience** → **Protect your posts**).
2. Sign in at [console.x.com](https://console.x.com) **as the test account**, accept the developer agreement and
   buy a small amount of credits (set a low spending limit). Create an app, set **App permissions** to **Read and
   write**, then on **Keys and tokens** copy the API Key and Secret and generate the Access Token and Secret
   (after setting Read and write, as above).
3. From `web/`:

   ```powershell
   npx wrangler secret put X_TEST_API_KEY --config wrangler.jsonc --env staging
   npx wrangler secret put X_TEST_API_KEY_SECRET --config wrangler.jsonc --env staging
   npx wrangler secret put X_TEST_ACCESS_TOKEN --config wrangler.jsonc --env staging
   npx wrangler secret put X_TEST_ACCESS_TOKEN_SECRET --config wrangler.jsonc --env staging
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

To stop: `npx wrangler secret delete BLUESKY_TEST_APP_PASSWORD --config wrangler.jsonc --env staging` (or
`X_TEST_ACCESS_TOKEN_SECRET`) and the panel goes back to the dry run. Revoke the app password or token in the
network as well. As for production, a staging **Terraform apply** can drop hand-set Worker secrets; set them again
if a panel goes back to the dry run.

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
- X: the OAuth 1.0a signature against X's published worked example, the signed request, and the 280 weighted
  limit with the link counted as 23;
- one post per click, two simultaneous clicks posting once, and Bluesky and X recorded separately;
- lock release.
