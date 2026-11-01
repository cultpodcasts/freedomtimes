# Automatic X post when an article publishes

When a **production** post is published, Freedom Times prepares an X post for **@_freedomtimes**: the headline, a short hook, and `https://freedomtimes.news/posts/<slug>` (so X can show the article card). The text is at most 280 on X's scale, where every link counts as 23.

Staging publishes never send. A republish or an edit of a post that already sent does not send again.

The admin **Post to X** button ([SOCIAL_SHARING.md](./SOCIAL_SHARING.md)) is separate. It still posts only when an admin confirms, and it uses OAuth 1.0a. This path does not press that button.

## Why a publish hook

EmDash runs `content:afterPublish` after a post is published, including when the scheduled-publish sweep promotes one. The hook runs in the web Worker, which already has Cloudflare Email (`EMAIL`, From `noreply@freedomtimes.news`). The plugin records the post id in its own KV only after a successful send.

A poll of `/api/recent-published-posts.json` is how push notifications work, but that feed is anonymous only on production. On locked staging it returns 401, and the scheduler Worker has no email binding. The hook sees the published item directly, on both hosts, and the production-only gate below decides whether anything is sent.

## Modes

`X_AUTO_POST_MODE` in `web/wrangler.jsonc`:

| Value | What happens |
|---|---|
| `off` | Nothing. |
| `dry-run` | Builds the text and the intent link and writes them to the Worker log. No email, no X call, no KV record. **This is the staging value.** |
| `intent` | **Stage A (on now in production).** Emails the intent link. |
| `api` | **Stage B.** Posts with OAuth 2.0 user context, then emails the X status URL. |

`intent` and `api` run only when **both** are true:

- `SITE_ACCESS_MODE=public` (the production Worker)
- `X_AUTO_POST_ALLOW_SEND=yes` (set only in the production env block)

Locked staging, local dev, and a staging smoke test that flips `SITE_ACCESS_MODE` to `public` all dry-run, because they do not have the allow flag. To stop production without a code change, set `X_AUTO_POST_MODE` to `off` or remove `X_AUTO_POST_ALLOW_SEND`.

The email goes to `X_AUTO_POST_NOTIFY_TO` (`socialmedia@freedomtimes.news`, which routes to the newsroom inbox).

## Stage A — what Jon receives

Subject `Post this on X: <headline>`. The body is the exact post, then:

`https://x.com/intent/post?text=<url-encoded text>`

Open it while signed in as @_freedomtimes, check the card, and press Post. The site has not posted.

Worker log line (dry-run and intent): the post id, the weighted length, and the intent URL. Dry-run does not email.

## Stage B — flip this on after X lifts the developer flag

Do this only once the @_freedomtimes developer signup works. Do not create a second app or account to get around the flag.

1. In the [X developer console](https://console.x.com), signed in as @_freedomtimes, create one app with OAuth 2.0, a confidential client, and User authentication. Set a redirect URI you control (an `http://127.0.0.1` URI is enough for the one-time script). Scopes: `tweet.read`, `tweet.write`, `users.read`, `offline.access`.
2. From `web/`, print the authorize URL and a code verifier (nothing is posted):

   ```powershell
   npx tsx scripts/x-oauth2-pkce.mts --client-id <client id> --redirect-uri <the redirect URI>
   ```

3. Open the URL as @_freedomtimes, approve, and copy the `code` query parameter from the redirect.
4. Exchange it. The script prints a refresh token once:

   ```powershell
   npx tsx scripts/x-oauth2-pkce.mts --client-id <client id> --client-secret <client secret> --redirect-uri <the same URI> --code <code> --verifier <verifier from step 2>
   ```

5. Store the three values as **production** Worker secrets (Wrangler prompts, so they are not in shell history). Never commit them. Staging does not get these.

   ```powershell
   npx wrangler secret put X_OAUTH2_CLIENT_ID --config wrangler.jsonc --env production
   npx wrangler secret put X_OAUTH2_CLIENT_SECRET --config wrangler.jsonc --env production
   npx wrangler secret put X_OAUTH2_REFRESH_TOKEN --config wrangler.jsonc --env production
   ```

6. Change the production var `X_AUTO_POST_MODE` from `intent` to `api` and deploy the production Worker. Leave `X_AUTO_POST_ALLOW_SEND` as `yes`. That is the whole switch: the same publish hook then calls `POST https://api.x.com/2/tweets` with `Authorization: Bearer` after `POST /2/oauth2/token` (`grant_type=refresh_token`).

X rotates the refresh token. The plugin saves the new one in plugin KV (`oauth2-refresh-token`) before it posts. The secret is only the first token. If a KV save fails after a rotation, the log says to run the PKCE script again. If the connection drops during the tweet call, the post is left pending for 2 minutes so it is not sent twice blindly; check the profile before republishing.

Each post that includes the article link is a paid X API call (about $0.20; see [SOCIAL_SHARING.md](./SOCIAL_SHARING.md)). Set a spending limit in the developer console.

To go back to the intent email, set `X_AUTO_POST_MODE` to `intent` and deploy. Already-sent post ids stay recorded either way.

## Dry run locally

This does not email and does not call X, even if the arguments say `api`:

```powershell
npx tsx scripts/x-auto-dry-run.mts --title "Headline" --hook "One sentence." --slug my-article
```

It prints the text, the weighted length, and the intent link. Staging is the same mode: the hook logs that line and stops.

## Code

- `src/plugins/x-auto-post.ts` — `ft-x-auto-post`, hook `content:afterPublish`
- `src/lib/x-auto/` — text, the production gate, dedupe, OAuth 2.0 client
- Tests: `npm run test:x-auto`
