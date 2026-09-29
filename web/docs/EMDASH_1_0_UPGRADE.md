# EmDash 0.38.0 → 1.0.1

Operator note for the Freedom Times upgrade. The pull request changes packages and one config path. It does not migrate a database and it does not deploy a Worker.

Deploys stay on the existing local scripts in [DEPLOY.md](DEPLOY.md) (`deploy-staging-local.ps1`, then `deploy-production-local.ps1` only when production is explicitly requested). Do not connect Cloudflare Workers Builds to GitHub for `freedomtimes` or `freedomtimes-staging`.

Staging (`freedomtimes-staging`, Turso `freedomtimes-emdash-staging`) is the pre-production database. Apply core migrations there, verify, then repeat on production with a Worker-resolved backup.

## Packages

| Package | Installed before this PR | This PR |
|---|---|---|
| `emdash` | 0.38.0 | 1.0.1 |
| `@emdash-cms/cloudflare` | 0.38.0 | 1.0.1 (same version as `emdash`; the Cloudflare package depends on that exact `emdash`) |
| `@emdash-cms/plugin-embeds` | 0.1.45 (`@emdash-cms/blocks` 0.37.0) | 0.1.53 (`@emdash-cms/blocks` 1.0.1) |
| `web` | 0.0.28 | 0.0.29 |

`emdash` and `@emdash-cms/cloudflare` move together. A caret on `^1.0.1` accepts later 1.0 patches. Breaking changes after 1.0 ship only in a new major version.

Sources read for 0.39.0, 0.40.0, 0.41.0, 0.42.0, and 1.0.1:

- [Upgrade to EmDash 1.0](https://docs.emdashcms.com/upgrade-to-v1/)
- [Update EmDash](https://docs.emdashcms.com/deployment/updating/) (reference-field section)
- [Core database migrations](https://docs.emdashcms.com/deployment/core-migrations/)
- GitHub releases `emdash@0.39.0`, `emdash@0.40.0`, `emdash@0.41.0`, `emdash@0.42.0`, `emdash@1.0.1`

## Code change in this PR

`web/astro.config.ts` sets the libSQL migration executor by hand so the Worker keeps the request-scoped Turso shim, while `emdash migrate` still uses the official executor and `.emdash/migrations.json`.

EmDash 1.0 moved that executor off the public path. The string is now:

```ts
entrypoint: 'emdash/internal/db/libsql-migrations',
```

It was `emdash/db/libsql-migrations`. Sites that only call `emdash()` and never name that path need no config edit. This site names it, so the string has to move. `emdash migrate` rejects a manifest written by an older EmDash, so the first build after this PR must be the build that deploy migrates.

`migrations.runtime` stays `check`. The Worker returns 503 when known migrations are pending. It does not apply them on the first request. `dev` stays `auto`, and `astro dev` still refuses a production-looking `TURSO_DATABASE_URL`.

The Windows `createRequire` patch (`web/scripts/patch-emdash-windows-createrequire.mjs`) stays. It no-ops when the 0.37 needle is absent.

## What this site must do

1. Merge this PR (or deploy the branch) only through the local staging script. That script exports the staging Turso database before `emdash migrate`, builds `web/` (new manifest), applies `npx emdash migrate`, deploys `freedomtimes-staging`, then runs `emdash migrate --check`.
2. After staging is up: open `/_emdash/admin`, load one public post, save a disposable draft, and upload and fetch a disposable media file.
3. Production uses the same order only after that check, and only when production is requested: `pwsh ./scripts/backup-production-emdash.ps1 -AllowProduction`, then the production deploy script. Commit `freedomtimes-agents/data/backups/prod-emdash-YYYYMMDD-HHMMSS.json`. Core migrations have no undo. Rollback is the pre-upgrade database plus the previous Worker artifact together.

`EMDASH_AUTH_SECRET`, if already set on a Worker, stays. EmDash still reads it so commenter IP hashes stay stable. `emdash auth secret` and `emdash dev` are removed in 1.0. This repo does not call them. New plugin-secret encryption uses `emdash secrets generate` for `EMDASH_ENCRYPTION_KEY`. We do not store plugin secrets that need that key today.

## Checked against staging — no manual data step

Read on 29 Sep 2026 via EmDash MCP (`freedomtimes-staging`):

| Check | Result | Action |
|---|---|---|
| Reference fields (`posts`, `pages`, `archives`) | None. Field types in use: string, text, portableText, image, file, json, datetime, integer. | The 0.41 / 1.0 bind-reference-to-relation migration has nothing to convert. A field that later renders as a text box instead of a picker is unbound; bind it in Content Types only after choosing one selection for every locale. |
| Taxonomies | `category` and `tag`, both locale `en`, both on `posts`. | The 0.40 merge of per-locale `hierarchical` and `collections` has one locale, so the values cannot disagree. |
| `blocks` fields | None. | Do not add a `blocks` field until 1.0.1 is the only runtime on that database. 0.40 requires a 0.39-or-newer runtime before a blocks field exists, because an older runtime can overwrite block JSON. |
| Comments UI imports from `emdash/ui` | None. Comments are disabled on all three collections. | 1.0 removes `Comments` and `CommentForm` from `emdash/ui`. Import them from `emdash/ui/comments` if a page ever needs them. |
| `cloudflareCache()` | Not used. Route cache is not configured in `astro.config.ts`. | 1.0 removes it. KV object cache is unchanged. `CF_ZONE_ID` and `CF_CACHE_PURGE_TOKEN` were for that provider; this site does not rely on them for EmDash cache purge. |
| `experimental.registry` | Not set. | 1.0 removes it. Registry config, if added later, is the top-level `registry` option. |
| Direct imports of removed `emdash/routes/*`, `emdash/middleware/*`, and the other internal entry points | The only removed path we named was the libSQL migration executor, updated above. Outer middleware is `./src/emdash-outer-middleware.ts` and does not import `emdash/middleware/redirect`. | Leave official redirect middleware after `getRuntime`. |
| `emdash plugin` CLI | Not used. | Removed in 0.42. Sandboxed plugin authoring is `@emdash-cms/plugin-cli` (`emdash-plugin`). Native plugins stay npm packages. |
| Collection URL patterns with more than one `{placeholder}` in a single path segment | Public routes are our Astro pages (`/posts/[slug]`, `/archives/[slug]`, `/[slug]`), one placeholder per segment. | 0.42 stops `resolveEmDashPath()` from matching a pattern that packs several placeholders into one segment. Existing patterns keep generating links. If a collection 404s inside EmDash routing after upgrade, split the pattern (for example `/{slug}-{id}` → `/{id}/{slug}`). |

## Behavior to expect after migrate

These ship inside 0.39–1.0.1. They do not need a schema edit before deploy. They change what editors and agents see.

- **Edit locks (0.42).** `posts`, `pages`, and `archives` have edit locking on. MCP and REST writes (`content_update`, publish, unpublish, schedule, discard draft, revision restore) return `ENTRY_LOCKED` while someone else holds the lock. The error names the holder. Pass `overrideLock: true` to write anyway, or turn locking off for that collection under Content Types.
- **URL fields (0.42).** New saves accept only `http:`, `https:`, `mailto:`, `tel:`, a site-relative path, or a fragment. Stored `javascript:` or `data:` values are left in place and fail the next save until corrected.
- **Redirects (0.42).** The redirect middleware only follows a destination that starts with a single `/`. Rules with a scheme, `//`, `/\`, or control characters are skipped and logged.
- **OAuth client registration (0.42).** Anonymous `POST /_emdash/api/oauth/register` is limited to 10 per minute per client IP when EmDash can see the IP (Cloudflare, or `trustedProxyHeaders`).
- **Admin update banner (0.42).** Admins may see a dismissible notice when a newer `emdash` has been on npm for at least 24 hours. It calls `https://registry.npmjs.org/emdash` at most once a day and sends no site data. Turn it off with `updateCheck: false` on `emdash()` if that outbound call is unwanted.
- **Plugin capability names (1.0).** Old names such as `read:content` still work through 1.x and log a startup warning with the replacement (`content:read`). `@emdash-cms/plugin-embeds` and `cloudflareEmail` are the plugins we register. If the Worker log names one of them, upgrade that package.
- **Migration lock (0.39).** A cancelled `emdash migrate` can leave a lock. `--status` reports the lock id. After confirming nothing is migrating, release it with `emdash migrate --release-lock <id>` against the manifest from the new build. Our runtime mode is `check`, so a locked or pending database makes the Worker return 503 instead of migrating itself.

## Verify

- `web/package-lock.json` resolves `emdash@1.0.1` and `@emdash-cms/cloudflare@1.0.1`.
- Staging admin loads, a published post renders, a disposable draft saves, a disposable media file uploads and downloads.
- `emdash migrate --check` exits 0 against the staging database after the staging Worker deploy.
- Production gets the same check only after its own backup and deploy.
