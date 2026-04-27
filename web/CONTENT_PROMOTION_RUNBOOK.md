# EmDash Content Promotion Runbook (Staging -> Production)

This runbook documents the repeatable process for getting verified staging content live on production.

## Scope

- Promote entries (for example `posts`, `pages`, `archives`) from staging to production.
- Verify items are truly published (not draft-only).
- Recover from stale manifest cache issues such as `Collection "archives" not found`.
- For `archives`, validate associated media assets are present in production before go-live.

## Staging Policy

- Staging is publish-only for `posts` and `pages` (no drafts workflow).
- Local staging rebuild enforces supports as `["revisions","search"]` and clears `emdash:manifest_cache`.

## Prerequisites

1. Node dependencies installed in `web/` (`npm install`).
2. EmDash API token for staging and production.
3. Collection schema parity between staging and production.

Set local env vars before running commands:

```powershell
$env:EMDASH_STAGING_URL = "https://staging.freedomtimes.news"
$env:EMDASH_PRODUCTION_URL = "https://freedomtimes.news"
$env:EMDASH_STAGING_TOKEN = "<staging-token>"
$env:EMDASH_PRODUCTION_TOKEN = "<production-token>"
```

## 1. Verify Schema Parity First

Schema changes are made on staging during development. By release time, staging schema should already be valid. This step confirms production matches staging before promoting content — mismatched schemas will cause content create/update to fail.

Release rule: if a PR contains code or content promotion that depends on EmDash schema, do not close the PR and do not allow the `main` deployment until this parity check passes or the missing schema has been applied to production.

From `web/`, verify the collection fields match in both environments:

```powershell
npx emdash schema list -u $env:EMDASH_STAGING_URL -t $env:EMDASH_STAGING_TOKEN --json
npx emdash schema list -u $env:EMDASH_PRODUCTION_URL -t $env:EMDASH_PRODUCTION_TOKEN --json

npx emdash schema get archives -u $env:EMDASH_STAGING_URL -t $env:EMDASH_STAGING_TOKEN --json
npx emdash schema get archives -u $env:EMDASH_PRODUCTION_URL -t $env:EMDASH_PRODUCTION_TOKEN --json
```

Do not promote content until collection fields match.

## 2. Confirm Staging Item Is Actually Published

Listing published entries is not enough when draft/live pointers were previously inconsistent.
Check both draft view and published view for each item:

```powershell
# Example: post slug "example-post"
npx emdash content get posts example-post -u $env:EMDASH_STAGING_URL -t $env:EMDASH_STAGING_TOKEN --json
npx emdash content get posts example-post --published -u $env:EMDASH_STAGING_URL -t $env:EMDASH_STAGING_TOKEN --json
```

Expected outcome:

- `--published` returns the current live version.
- Non-published read does not show unexpected draft divergence.

If needed, publish explicitly:

```powershell
npx emdash content publish posts example-post -u $env:EMDASH_STAGING_URL -t $env:EMDASH_STAGING_TOKEN --json
```

## 3. Promote Content to Production

Recommended operational pattern:

1. Read source item from staging (`content get ... --json`).
2. Create or update same slug in production using JSON file input.
3. Publish in production.

Example:

```powershell
# 1) Export source JSON data (manually copy to file or script this in automation)
npx emdash content get posts example-post -u $env:EMDASH_STAGING_URL -t $env:EMDASH_STAGING_TOKEN --json

# 2) Create in production (or update existing item)
npx emdash content create posts --slug example-post --file .\tmp\example-post.json -u $env:EMDASH_PRODUCTION_URL -t $env:EMDASH_PRODUCTION_TOKEN --json

# 3) Publish in production
npx emdash content publish posts example-post -u $env:EMDASH_PRODUCTION_URL -t $env:EMDASH_PRODUCTION_TOKEN --json

# 4) Verify live output in production
npx emdash content get posts example-post --published -u $env:EMDASH_PRODUCTION_URL -t $env:EMDASH_PRODUCTION_TOKEN --json
```

Notes:

- `archives` usually include media references; ensure required files exist in production media storage.
- If create fails because slug exists, use `content get` on production and then `content update ... --rev <token>`.

## 4. Archives Media/R2 Preflight (Required for Archives Releases)

If promoting `archives`, run this preflight before final publish checks:

```powershell
# Compare staging vs production media inventory (high-level)
npx --prefix web emdash media list -u $env:EMDASH_STAGING_URL -t $env:EMDASH_STAGING_TOKEN --json
npx --prefix web emdash media list -u $env:EMDASH_PRODUCTION_URL -t $env:EMDASH_PRODUCTION_TOKEN --json

# Inspect specific media record referenced by archive content
npx --prefix web emdash media get <media-id> -u $env:EMDASH_PRODUCTION_URL -t $env:EMDASH_PRODUCTION_TOKEN --json

# Upload missing media into production
npx --prefix web emdash media upload .\path\to\asset.png --alt "Archive asset" -u $env:EMDASH_PRODUCTION_URL -t $env:EMDASH_PRODUCTION_TOKEN --json
```

Operational rule:

- Do not mark an archives release complete until all referenced media records resolve in production and the corresponding archive pages render with working image/file links.

## 5. Recover From "Collection not found" Manifest Issues

Symptom:

- Admin route shows `Collection "archives" not found`.
- Collection exists in `_emdash_collections`, but runtime manifest cache is stale.

Recovery (for the target environment database):

1. Delete `emdash:manifest_cache` from `options`.
2. Trigger one admin/API request to regenerate manifest.

Example Node one-liner (run in `web/`):

```powershell
$env:TURSO_DATABASE_URL = "<target-env-db-url>"
$env:TURSO_AUTH_TOKEN = "<target-env-db-token>"

node -e 'const { createClient } = require("@libsql/client"); (async () => { const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN }); await db.execute("delete from options where name = ''emdash:manifest_cache''"); const check = await db.execute("select count(*) as c from options where name = ''emdash:manifest_cache''"); console.log("remaining=" + check.rows[0].c); })().catch((e) => { console.error(e); process.exit(1); });'
```

After this, reload admin and re-test the collection route.

## 6. Production Go-Live Checklist

1. Schema parity confirmed (`schema list/get`).
2. Staging source item validated as published.
3. Production item created/updated and published.
4. Production `--published` read returns expected content.
5. Public route renders expected page.
6. For archives, media links and downloadable file URLs work.
