# Self-hosted video embeds — prevent disappear, fix fast

Incident (2026-09-16): [Sham Aberdeen Ambush](https://staging.freedomtimes.news/posts/sham-aberdeen-ambush-james-taylor-jr-1970) still showed the hall clip in the **EmDash editor**, but the **published article** had no `<video>`. Stored PT was `_type: "embed"`, `provider: "video"`, MP4 on **`id`**, no **`url`**. Older reader code only read `url`. Cursor `content_update` could not carry the ~60KB Portable Text array as a tool argument (and a markdown string would have destroyed the embed).

Canonical code: `EmbedWithCaptions.astro` + `resolveSelfHostedVideoUrl` in `web/src/lib/content/videoCaptionTracks.ts`.

## 1. Mitigate videos disappearing

Do these so the published player does not vanish after an admin save.

**Reader (must be deployed)**

- Self-hosted video src is `url`, **or** `id` when `id` is `/_emdash/api/media/file/…`.
- Tests: `web/scripts/test-video-caption-tracks.mts` (`resolveSelfHostedVideoUrl`). `npm run build` runs them.

**Stored JSON**

- Prefer **both** `url` and `id` set to the same media-file path.
- Keep caption extras on the same node (`captionsUrl` / `captions[]` / `captionsDefaultOn`). Schema has no captions field; extras persist only if `content_update` sends a **Portable Text array**, never markdown.
- MCP / agent drafts: write `_type: "embed"`, `provider: "video"`, `url: "/_emdash/api/media/file/<key>.mp4"`. Copy that path onto `id` if the editor widget uses `id`.

**Do not**

- Save in the editor and trust the CMS preview alone. After any embed edit, open the **published** URL and confirm `<video>` / `<source>` (and `<track>` if captions).
- Send `data.content` as a markdown string. EmDash MD→PT drops custom embed extras and can drop the player.

**Scan before it ships**

```powershell
cd web
npm run pt:migrate:scan:embed-url
# Production:
# $env:EMDASH_ALLOW_PRODUCTION='1'
# node scripts/migrate-pt-content.mjs posts --scan --transforms embed-video-url --url https://freedomtimes.news
```

Zero hits = no published/draft posts with video-on-`id` and empty `url`. Non-zero = restore `url` (section 2) even if the Worker already has the `id` fallback — the next editor save is safer with both fields.

**After Worker deploys that touch `EmbedWithCaptions`**

Spot-check a known self-hosted post (Aberdeen hall clip) signed-in on staging. Editor visible + published missing is this bug, not a missing media file.

## 2. Rectify quickly (including large articles)

Do **not** paste a full article body into Cursor MCP `content_update`. A long-form post is often 50–80KB of PT JSON. That is small on disk and large as a chat/tool argument. Cursor may truncate it or coerce a string, which EmDash treats as markdown and **strips the embed**.

### Diagnose (MCP `content_get` is small enough)

```text
collection: posts
id: <slug>
```

Find `_type: "embed"` / `provider: "video"`. Bad: `id` is `/_emdash/api/media/file/….mp4` and `url` is missing. Confirm published HTML has `videoTagCount=0` and no mp4 path (cookie on locked staging).

### Backup first

Staging file export (repo root):

```powershell
wsl bash -lc 'export PATH="$HOME/.turso:$PATH"; mkdir -p .release/backups; stamp=$(date +%Y%m%d-%H%M%S); turso db export freedomtimes-emdash-staging --output-file ./.release/backups/emdash-staging-$stamp.db; ls -lh ./.release/backups/emdash-staging-$stamp.db'
```

Confirm a **multi-MB** `.db` (not 0 bytes). Log with `node web/scripts/write-emdash-backup-log.mjs`. Production: `pwsh ./scripts/backup-production-emdash.ps1 -AllowProduction`.

Inspect that SQLite with **Node** (`node:sqlite` or a small `.mjs`) if you need table counts — **not Python**.

### Apply without stuffing PT through the IDE

**Operators** (preferred for any post whose `content` is more than a handful of blocks):

```powershell
cd web
# Dry-run (writes web/data/pt-migrate/<slug>-*.json)
node scripts/migrate-pt-content.mjs posts <slug> --transforms embed-video-url

# Staging write + publish
node scripts/migrate-pt-content.mjs posts <slug> --transforms embed-video-url --apply --publish

# Production (explicit allow + operator asked)
$env:EMDASH_ALLOW_PRODUCTION = '1'
node scripts/migrate-pt-content.mjs posts <slug> --transforms embed-video-url --apply --publish --url https://freedomtimes.news
```

That script reads and writes via the same MCP HTTP `tools/call` as the IDE. It never puts the array on the PowerShell command line.

**AI agents:** Cursor MCP `content_get` to confirm the node. Do **not** `content_update` the full `data.content` array through `call_mcp_tool` / `CallDynamicTool` when the dump is tens of KB. Tell the operator to run the commands above. Do **not** fall back to `npx emdash content` (`AGENTS.md` §1 / §3).

If an operator already has a patched payload JSON (`collection`, `id`, `_rev`, `data.content`):

```powershell
node web/scripts/emdash-mcp-tools-call.mjs --url https://staging.freedomtimes.news content_update --args-file .release/<payload>.json
node web/scripts/emdash-mcp-tools-call.mjs --url https://staging.freedomtimes.news content_publish --args-file .release/<publish-args>.json
```

`--args-file` exists because inline `'<json>'` hits Windows command-line length limits. Agents still must not use this helper when Cursor MCP is down.

### Verify

Signed-in published HTML must contain `<video>`, the mp4 `src`, and caption `<track>` when VTT extras were present. Then reload the editor: the embed widget should still show the file (`id` kept).

## Related

- `web/docs/EDITORIAL_ENGLISH_GLOSSES.md` — PT embed types
- `web/docs/EMDASH_EMBEDS_PRODUCTION_CUTOVER.md` — legacy `_type: "video"` → youtube/embed
- `docs/CURSOR_EMDASH_MCP.md` — large media **and** large PT payloads
- `web/CONTENT_PROMOTION_RUNBOOK.md` — backups
