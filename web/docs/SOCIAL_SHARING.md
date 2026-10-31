# Sharing posts to social networks (admin only)

Admins can share a published post to the Freedom Times Bluesky account from the EmDash admin
([#21](https://github.com/cultpodcasts/freedomtimes/issues/21)). Nothing posts automatically. An admin
opens the post, checks the preview and presses the button, then confirms.

## Where it is

- **EmDash admin only.** Open a saved post in the EmDash admin (`/_emdash/admin`, Content → Posts → the post).
  The editor sidebar shows a **Post to Bluesky** panel.
- No public page, layout, component, script or static file renders the panel, the button or the route URL.
  `scripts/test-social-share.mts` scans `src/` and `public/` to keep it that way.
- Code: `src/plugins/social-share.ts` (site-local native EmDash plugin `ft-social-share`, registered in
  `astro.config.ts`) and `src/lib/social-share/` (the panel logic and the Bluesky client).

## Who can use it

- **Admins only.** The panel route (`/_emdash/api/plugins/ft-social-share/editor/bluesky`) is private and keeps
  EmDash's default `plugins:manage` permission (Admin role). EmDash rejects it before the plugin runs:
  - 401 when there is no signed-in session;
  - 403 for Editor, Author, Contributor and Subscriber;
  - 403 for cookie requests without the `X-EmDash-Request: 1` header, so a cross-site form can't trigger it (CSRF).
- The handler checks the Admin role again. It also requires the context EmDash attaches when the request
  comes from the post editor panel, so a direct call to the route is refused (403).
- Responses are `Cache-Control: private, no-store`, and the reader page cache never stores `/_emdash/` paths.

## What the panel shows

| Situation | Panel |
|---|---|
| Staging, local dev, or any host other than `freedomtimes.news` / `www.freedomtimes.news` | "Disabled outside production". No button. Staging can never post to the real account. |
| Production, secrets not set | "Bluesky sharing isn't configured", naming the secrets below. No button. |
| Draft, scheduled or unpublished post | "Publish this post first". No button. |
| Ready | The exact post text (title, blank line, article link) and the link card, then **Post to Bluesky**. The confirm dialog repeats the text and the account. |
| Already shared | "Shared to Bluesky", with the date, who posted it and a link to the post. No button. |
| Someone is posting right now | "Posting in progress". |
| Last attempt's outcome unknown | A warning to check the Bluesky profile, with **Release lock** (confirm required). |

"Production" means the Worker runs with `SITE_ACCESS_MODE=public` (only the `production` env in
`wrangler.jsonc`) **and** the request host is `freedomtimes.news` or `www.freedomtimes.news`.

## What gets posted

- Text: the post's social title (else its SEO title, else its title), a blank line, then
  `https://freedomtimes.news/posts/<slug>`. The title is shortened with "…" so the whole post fits Bluesky's
  300-character limit. The link is always complete.
- The link is a clickable link facet, and the post carries a link card (`app.bsky.embed.external`) with the title
  and the SEO description (else the lede). The card has no image.
- AT Protocol calls, both to `https://bsky.social` (the plugin can't reach any other host):
  1. `com.atproto.server.createSession` with the handle and app password;
  2. `com.atproto.repo.createRecord` (`app.bsky.feed.post`).
- If the post text changed after the panel loaded, the click is refused and the panel shows the new preview.

## No double posting

Each share is recorded in the plugin's KV under `share:bluesky:<post id>`:

1. Before calling Bluesky, the panel claims the key atomically. Only one click can win, even if two admins click
   at once.
2. On success the record becomes `posted` with the Bluesky URL, the time and who posted it. The post can't be
   shared to Bluesky again.
3. If Bluesky rejects the request (for example a wrong app password), the claim is released and the panel shows
   the error.
4. If the outcome is unknown (the connection dropped, or Bluesky returned a 5xx), the claim stays, because the
   post may exist. Check the Bluesky profile. If the post isn't there, press **Release lock**. A claim that has
   been pending for more than 2 minutes counts as interrupted and can be released the same way.

## Setting the secrets (Jon)

Credentials are Worker secrets on the **production** Worker only. They are never committed, and none are
set in GitHub, `.env.dev` or Terraform.

| Secret | Value |
|---|---|
| `BLUESKY_HANDLE` | The account handle, e.g. `freedomtimes.news` (a leading `@` is ignored). |
| `BLUESKY_APP_PASSWORD` | A Bluesky **app password** for that account, not the account password. |

1. Create the app password: sign in at [bsky.app](https://bsky.app) as the Freedom Times account →
   **Settings** → **Privacy and security** → **App passwords** → **Add App Password**. Name it e.g.
   `freedomtimes-admin`, leave direct-message access off, and copy it.
2. From `web/`, put both secrets on the production Worker (Wrangler prompts for each value, so nothing lands in
   shell history):

   ```powershell
   npx wrangler secret put BLUESKY_HANDLE --config wrangler.jsonc --env production
   npx wrangler secret put BLUESKY_APP_PASSWORD --config wrangler.jsonc --env production
   ```

3. Open a published post in the production EmDash admin. The panel should show the preview and the button.
   Secrets take effect without a redeploy.

Do **not** set these on staging. Staging can't post even if they are set, but keeping them off staging means a
staging copy never holds the credentials.

To revoke: delete the app password in Bluesky (**Settings** → **Privacy and security** → **App passwords**),
then run `npx wrangler secret delete BLUESKY_APP_PASSWORD --config wrangler.jsonc --env production`.

**Keeping the secrets.** The normal production deploy (`wrangler deploy`, run when a PR merges) keeps Worker
secrets. A production **Terraform apply** re-uploads the Worker's Terraform-owned `secret_text` bindings and
can drop secrets set by hand (see
[NON_TERRAFORM_RESOURCES.md](../../NON_TERRAFORM_RESOURCES.md#terraform-holding-page-drift)). After a production
Terraform apply, open the panel. If it says "isn't configured", run the two commands above again. Wiring these
names into Terraform or `set-github-secrets.ps1` would make them survive, but it needs new GitHub or `.env`
secrets, so it is left for Jon to decide.

## Tests

`npm run test` includes `scripts/test-social-share.mts`. Bluesky is always mocked; no test can reach a real
account. It covers:

- the 401 and 403 rejections, and the editor-panel context check;
- the static check that the route stays private with the default Admin permission;
- the scan of public files;
- staging and missing-secret states;
- the preview and confirm dialog;
- the UTF-8 byte offsets of the link facet;
- the 300-character limit;
- one post per click, and two simultaneous clicks posting once;
- lock release.
