# Reader search index (manual step)

The site search page (`/search`) and the subject chips do not need this step to ship. Title and article body are already in the EmDash FTS5 index, so those words match as soon as the page is deployed.

`excerpt`, `lede`, and `subjects` are marked `searchable` in `web/.emdash/seed.json`. That flag applies to a brand-new database. The live staging and production databases keep the old flags until someone updates them and rebuilds the index. Until that rebuild, a word that appears only in the standfirst, the lede, or a subject chip (and nowhere in the title or body) will not match.

**Do not run this during a normal code change.** It writes the content database. It needs an explicit yes in the chat, and a backup of the database the Worker is actually using, first. Do not run it from a cloud agent unless that yes is in the same chat.

The rebuild reads every non-deleted post once, including the article body. It is a one-time cost, not a cost per search. After it, EmDash's own triggers keep the index up to date on each save. Reader searches themselves only read the index plus a short list of titles and excerpts.

`getDb()` follows `FT_CONTENT_BACKEND`, so the same SQL runs on D1 and on Turso. The rebuild has to be done on whichever database that environment is serving.

## What gets indexed

Collection `posts`. Fields that should be searchable:

| Field | Already indexed | After this step |
| --- | --- | --- |
| `title` | yes | yes |
| `content` (article body, stored as plain text in the index) | yes | yes |
| `excerpt` | no | yes |
| `lede` | no | yes |
| `subjects` | no | yes |

`subjects` is a JSON array. The index stores that JSON as text, so the words inside the chips match. People, places, and organisations stay out of the index.

The FTS table is `_emdash_fts_posts`. A rebuild drops it, creates it again from the current searchable fields, and fills it.

## 1. Backup the database you are about to change

Check `web/wrangler.jsonc` `env.<name>.vars.FT_CONTENT_BACKEND`.

**While that environment is `d1` (the current fallback):** the Turso backup scripts snapshot the wrong database, because Turso steps are skipped. Sign in as an admin on that environment and download **Content database export** (`/admin/content-export`). Staging exports staging's D1; production exports production's D1. Keep the file off git. It contains drafts and account rows. See [CONTENT_BACKEND.md](./CONTENT_BACKEND.md) (Admin SQLite export).

**When that environment is `turso` again:** use the normal backup before any EmDash write. Production: `pwsh ./scripts/backup-production-emdash.ps1 -AllowProduction` from the repo root, then the usual backup record. Staging: the staging Turso export in [DEPLOY.md](./DEPLOY.md). Do not point those commands at D1.

Stop if the backup fails. Do not update fields or rebuild.

Do staging first. Production only after staging search still returns published posts.

## 2. Mark the three fields searchable

In Cursor, with the EmDash MCP server for that environment (`freedomtimes-staging`, then later `freedomtimes-production`), call `schema_update_field` once per field. Omitted settings stay as they are. Do not change the field type.

```json
{ "collection": "posts", "fieldSlug": "excerpt", "searchable": true }
```

```json
{ "collection": "posts", "fieldSlug": "lede", "searchable": true }
```

```json
{ "collection": "posts", "fieldSlug": "subjects", "searchable": true }
```

Confirm with `schema_get_collection` `{"slug":"posts"}` that those three, plus `title` and `content`, show `"searchable": true`.

## 3. Rebuild the posts index

There is no MCP tool for the rebuild. It is `POST /_emdash/api/search/rebuild` on that environment, as an EmDash user who has `search:manage` (an EmDash admin session, not only the reader sign-in). The path is under `/_emdash`, which uses EmDash's own login.

```http
POST /_emdash/api/search/rebuild
Content-Type: application/json

{ "collection": "posts" }
```

A successful body looks like `{ "ok": true, "data": { "collection": "posts", "indexed": <number> } }` (EmDash's usual success envelope). `indexed` should be in the same range as the number of non-deleted posts.

Then search the site for a word you know is only in an excerpt or a subject chip, and confirm a published post comes back. A draft must not.

## 4. Turso at swap-back (1 December 2026)

Anything written only to D1 is not on Turso. That includes these `searchable` flags and the rebuilt `_emdash_fts_posts` table.

- If the D1 database is copied onto Turso in full before the Worker is pointed back, the flags and the index come with it. Do not rebuild again.
- If Turso is the pre-change database (a rollback branch, or swap-back without that copy), repeat sections 1–3 against the Turso-backed Worker after the Turso backup. Until then, title and body search still work; excerpt, lede, and subject-only words do not.

Swap-back itself is [CONTENT_BACKEND.md](./CONTENT_BACKEND.md). This page does not change `FT_CONTENT_BACKEND`.
