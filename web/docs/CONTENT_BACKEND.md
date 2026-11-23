# Content backend switch (Turso ↔ Cloudflare D1)

Temporary fallback added 23 November 2026 after the Turso starter account hit its
syncs quota and blocked reads on both production and staging EmDash databases.

## How the switch works

The Worker is **not** switched at request time only. EmDash's official D1 adapter
is selected at **Astro build time** by `FT_CONTENT_BACKEND`:

| Value | Adapter | Required bindings / secrets |
| --- | --- | --- |
| `turso` (default) | Existing request-scoped libsql shim | `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` secrets |
| `d1` | `d1({ binding: "EMDASH", session: "disabled" })` from `@emdash-cms/cloudflare` | wrangler `d1_databases` binding named `EMDASH` |

Set the same value in:

1. The build environment (`FT_CONTENT_BACKEND=d1` when running the staging/production deploy script).
2. `web/wrangler.jsonc` `env.<name>.vars.FT_CONTENT_BACKEND` so the deployed Worker records which backend it was built for.

Media stays on R2 (`MEDIA`). The scheduler / subscriptions Workers stay on Turso
and must not be pointed at these D1 databases.

## Current fallback databases (23 Nov 2026)

- Staging D1: `freedomtimes-emdash-staging-fallback-20261123` (`ba03720b-f6f8-4ab1-b3cf-c2809b4bb0bf`, WEUR), hydrated from `emdash-staging-20261122-192351.db`.
- Production D1: `freedomtimes-emdash-production-fallback-20261123` (`ece69b46-eacd-4ce5-9923-68185cfcfb48`, WEUR), hydrated from `emdash-production-20261122-192325.db`. Production Worker deploy of this binding is a separate, explicit step.

Hydrate with bound parameters (do **not** `wrangler d1 execute --file` a raw `sqlite3 .dump` — statements over 100 KB will fail):

```
node web/scripts/hydrate-d1-from-sqlite.mjs --sqlite .release/backups/<file>.db --database-id <uuid>
```

The Terraform Cloudflare API token used for Workers deploy does not include
`d1:write`. Creating and hydrating D1 is done with a local `wrangler login`
(OAuth has `d1:write`).

## Staging deploy while Turso is blocked

```
$env:FT_CONTENT_BACKEND = "d1"
pwsh ./scripts/deploy-staging-local.ps1 -WorkerOnly -SkipTursoBackup
```

`-SkipTursoBackup` also avoids `emdash migrate apply/check` against blocked Turso.

Do **not** `terraform apply` while the D1 binding exists only in `wrangler.jsonc`;
Terraform may strip it.

## Production deploy while Turso is blocked

```
$env:FT_CONTENT_BACKEND = "d1"
pwsh ./scripts/deploy-production-local.ps1 -WorkerOnly -AllowProduction -SkipTursoBackup
```

This deploys only the web Worker. Leave the scheduler / subscriptions Workers
on Turso (do not retarget them at D1). Rollback: `npx wrangler rollback 6926c482-02f8-4cdb-a379-e8de04f5c6c1 --env production --config wrangler.jsonc`.



## Swap back to Turso

1. Confirm Turso reads are unblocked (quota reset or plan change). Do not change billing from this runbook.
2. Set `FT_CONTENT_BACKEND=turso` in the shell and in `wrangler.jsonc` vars (or remove the var so the default applies).
3. Rebuild and deploy the same Worker. The `EMDASH` D1 binding can stay unused.
4. Or, without a new build, roll back the Worker:
   - Staging previous version: `cb64d297-b665-4bce-8d30-bacd0d87b596` (created 22 Nov 2026, 20:00 UTC / 20:00 Europe/London).
     `npx wrangler rollback cb64d297-b665-4bce-8d30-bacd0d87b596 --env staging --config wrangler.jsonc`
   - Production previous version: `6926c482-02f8-4cdb-a379-e8de04f5c6c1` (created 16 Nov 2026, 08:38 UTC / 08:38 Europe/London).
     `npx wrangler rollback 6926c482-02f8-4cdb-a379-e8de04f5c6c1 --env production --config wrangler.jsonc`

Content written only to D1 during the outage will not be on Turso after swap-back.
Treat the D1 window as read-mostly. Leave the scheduler on Turso.

## Test the switch by config (no deploy required for the unit of choice)

`FT_CONTENT_BACKEND=turso` (default) keeps `emdashTursoDatabase`. `FT_CONTENT_BACKEND=d1`
selects `emdashD1Database`. Any other value fails the build.

## D1 import notes

Cloudflare D1 leaves `PRAGMA foreign_keys` on (the pragma cannot be turned off,
even in a multi-statement or batch request). The hydrator therefore strips
`FOREIGN KEY` clauses from `CREATE TABLE` and loads rows with bound parameters.
Unique and primary-key constraints are kept. FTS5 virtual tables store their
own content (no `content=` table), so a `rebuild` of an empty virtual table
stays empty. The hydrator copies the source FTS rows with bound parameters;
shadow tables from the export are not replayed. Do not `wrangler d1 execute --file` a
raw `sqlite3 .dump` (100 KB statement limit).


## Writes on D1 and swap-back

EmDash 1.5.0 has no site-wide read-only mode (the official `d1()` adapter
only configures `binding`, `session`, `bookmarkCookie`, and `coalesce`.
"Read-only" in EmDash refers to per-entry edit locks, individual GET APIs,
or the CLI opening a SQLite file with `readOnly: true`). This fallback
therefore allows writes to the D1 database.

Any content, media metadata, or CMS changes written to D1 during the outage
**must be copied back to Turso before swap-back**. A Turso rebuild/deploy or
`wrangler rollback` will serve the pre-outage Turso database and will not
include D1-only writes. Do not swap back until that copy is done and verified,
or accept losing those changes.
