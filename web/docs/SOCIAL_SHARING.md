# Sharing posts to social networks (admin only)

Admins can share a published post to the Freedom Times **Bluesky** account
([#21](https://github.com/cultpodcasts/freedomtimes/issues/21)) and **X** account
([#20](https://github.com/cultpodcasts/freedomtimes/issues/20)) from the EmDash admin. Nothing posts
automatically. An admin opens the post, checks the preview, presses the button and confirms. Each network is
shared separately.

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
| Staging, local dev, or any host other than `freedomtimes.news` / `www.freedomtimes.news` | "Disabled outside production". No button. Staging can never post to the real accounts. |
| Production, that network's secrets not set | "`<Network>` sharing isn't configured", naming the secrets below. No button. |
| Draft, scheduled or unpublished post | "Publish this post first". No button. |
| Ready | The exact post text (title, blank line, article link) and the extra rows below, then **Post to `<Network>`**. The confirm dialog repeats the text and the account. |
| Already shared to that network | "Shared to `<Network>`", with the date, who posted it and a link to the post. No button. |
| Someone is posting right now | "Posting in progress". |
| Last attempt's outcome unknown | A warning to check the profile, with **Release lock** (confirm required). |

Extra preview rows: Bluesky shows the link card title and description. X shows the post's length as X counts it.

"Production" means the Worker runs with `SITE_ACCESS_MODE=public` (only the `production` env in
`wrangler.jsonc`) **and** the request host is `freedomtimes.news` or `www.freedomtimes.news`.

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
A post shared to Bluesky can still be shared to X once, and the other way round.

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

Credentials are Worker secrets on the **production** Worker only. They are never committed, and none are
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

Do **not** set these on staging. Staging can't post even if they are set, but keeping them off staging means a
staging copy never holds the credentials.

**Keeping the secrets.** The normal production deploy (`wrangler deploy`, run when a PR merges) keeps Worker
secrets. A production **Terraform apply** re-uploads the Worker's Terraform-owned `secret_text` bindings and
can drop secrets set by hand (see
[NON_TERRAFORM_RESOURCES.md](../../NON_TERRAFORM_RESOURCES.md#terraform-holding-page-drift)). After a production
Terraform apply, open the panels. If one says "isn't configured", run that network's commands again. Wiring
these names into Terraform or `set-github-secrets.ps1` would make them survive, but it needs new GitHub or
`.env` secrets, so it is left for Jon to decide.

## Tests

`npm run test` includes `scripts/test-social-share.mts`. Bluesky and X are always mocked; no test can reach a
real account. It covers:

- the 401 and 403 rejections, and the editor-panel context check;
- the static check that both routes stay private with the default Admin permission;
- that `astro.config.ts` grants exactly the plugin's hosts;
- the scan of public files;
- staging and missing-secret states;
- the preview and confirm dialog;
- Bluesky: the UTF-8 byte offsets of the link facet, and the 300-character limit;
- X: the OAuth 1.0a signature against X's published worked example, the signed request, and the 280 weighted
  limit with the link counted as 23;
- one post per click, two simultaneous clicks posting once, and Bluesky and X recorded separately;
- lock release.
