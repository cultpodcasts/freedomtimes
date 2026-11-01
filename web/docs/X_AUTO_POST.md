# Automatic X and Bluesky posts when an article publishes

Publishing does not post to X or Bluesky. The post editor offers the exact text and an **Open X to post** or **Open Bluesky to post** link as soon as the post is open. An agent does not post, and does not offer to post, in the publish step. After the article has been live for **30 minutes** (the same wait the production push scheduler uses), the agent may offer to post it. The post uses the same clients, the same text, and the same KV keys as the admin panels ([SOCIAL_SHARING.md](./SOCIAL_SHARING.md)).

The text is the social title (or the SEO title, or the post title), a blank line, `#Cult` and the organisation hashtags that fit, a blank line, and `https://freedomtimes.news/posts/<slug>` last. X counts a link as 23 and fills 280. Bluesky fills 300 graphemes and attaches the article card. The two hashtag lines can differ.

A network posts only when its production secrets are already on the Worker (the same names as the panels). If they are not, that network is skipped. The post editor shows the exact text and an **Open X to post** or **Open Bluesky to post** link. EmDash renders that link with `target="_blank"`. Opening it does not post; the person signed in as the Freedom Times account presses Post on that site. Nothing is emailed.

Staging publishes never send. A republish of a post that already went out on a network does not send that network again. One network failing does not stop the other, and a failure does not fail the publish.

## Modes

`X_AUTO_POST_MODE` in `web/wrangler.jsonc`:

| Value | What happens |
|---|---|
| `off` | Nothing. |
| `dry-run` | Builds both texts and intent links and writes them to the Worker log. No network call, no KV record. **This is the staging value.** |
| `api` | Posts to each network whose secrets are set. **Not set on publish.** Use it only when an agent is carrying out the offer after the 30-minute delay. |

Production `X_AUTO_POST_MODE` is `dry-run`, so a publish only logs the intent links. `api` runs only when **both** are true:

- `SITE_ACCESS_MODE=public` (the production Worker)
- `X_AUTO_POST_ALLOW_SEND=yes` (set only in the production env block)

Locked staging, local dev, and a staging smoke test that flips `SITE_ACCESS_MODE` to `public` all dry-run, because they do not have the allow flag. A leftover `intent` value (the retired email path) also dry-runs. To stop production without a code change, set `X_AUTO_POST_MODE` to `off` or remove `X_AUTO_POST_ALLOW_SEND`.

Dry-run log line, once per network: `dry-run <network> <post id> (<length>) <intent URL>`.

- X: `https://x.com/intent/post?text=<url-encoded text>`
- Bluesky: `https://bsky.app/intent/compose?text=<url-encoded text>`

## When the X developer account exists

The @_freedomtimes developer signup is blocked (“Your account has been flagged and cannot proceed”). The account is not suspended. The recent developer-forum thread for this same flag, where X is still taking the request, is [Developer Console onboarding blocked](https://devcommunity.x.com/t/developer-console-onboarding-blocked-your-account-has-been-flagged-and-cannot-proceed-account-not-suspended/277865). Stay with that thread. Do not open a second thread, app, or account.

[Topic 278836](https://devcommunity.x.com/t/developer-console-signup-blocked-your-account-has-been-flagged-and-cannot-proceed/278836) is a different person’s post from 20 Oct 2026. X closed it and sent them to the Help Center. That is not this request.

When that flag is lifted, set the four production X secrets already documented in [SOCIAL_SHARING.md](./SOCIAL_SHARING.md) (`X_API_KEY`, `X_API_KEY_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET`). Publishing still does not post. After the 30-minute delay, the agent may offer to post, and the panel can post with those secrets. There is no separate OAuth 2.0 client and no email step.

Each X post that includes the article link is a paid API call (about $0.20). Set a spending limit in the developer console. Bluesky app passwords are not metered the same way.

Until a network's secrets exist, the offer is the intent link on that post.

## Dry run locally

This does not call X or Bluesky, even if the mode argument would be `api` on production:

```powershell
npx tsx scripts/x-auto-dry-run.mts --title "Headline" --slug my-article
```

It prints both texts and both intent links. Staging is the same mode: the hook logs those lines and stops.

## Code

- `src/plugins/x-auto-post.ts` — `ft-x-auto-post`, hook `content:afterPublish`
- `src/lib/x-auto/` — the production gate and the publish hook
- `src/lib/social-share/` — the shared drafts, clients, and the editor intent link
- Tests: `npm run test:x-auto` and `npm run test:social-share`
