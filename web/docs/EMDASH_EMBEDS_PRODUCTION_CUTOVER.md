# EmDash embeds cutover — production deploy, content migrate, rollback

**Scope:** ship `@emdash-cms/plugin-embeds` + EmDash `PortableText` reader path, remove FT `Video`/`PortableImage`/`PortableLink`, migrate production posts that still store `_type: "video"` → `youtube` / `embed`.

**Not in scope:** production publish of unrelated posts; Auth0 changes; agents MD→PT follow-up (sibling `freedomtimes-agents` — see PR notes).

**Hard rules:** Turso backup / rollback branch **before** any production EmDash mutate. Production `content_publish` may notify subscribers — warn, then publish when migrating live posts. Agents use Cursor EmDash MCP only (no shell MCP fallback).

---

## Preflight (must all be green)

| Check | Command / evidence |
|-------|-------------------|
| Staging reader smoke | Ahmadi, weekly 8 June, PBCC, Norway, Inès render correctly on staging |
| Staging video scan | `cd web && npm run pt:migrate:scan` → **0** items (already done on staging) |
| Production video scan (dry) | `EMDASH_ALLOW_PRODUCTION=1 node scripts/migrate-pt-content.mjs posts --scan --transforms video --url https://freedomtimes.news` |
| Turso auth (WSL) | `wsl bash -lic "turso auth whoami"` |
| Wrangler / CF | `npx wrangler whoami` (from `web/` with token env) |
| Git | This PR merged to `main` (or deploy from this branch only if operator explicitly overrides) |

Expected production migrate targets (confirm with scan):

- `ahmadi-religion-of-peace-and-light-crewe-raids-roundup-30-apr-2026`
- `weekly-summary-8-june-2026`
- `pbcc-plymouth-brethren-cult-in-plain-sight-what-unchosen-shows-us-about-hidden-c-1`

---

## Order of operations (production)

**Critical sequencing:** deploy **code first**, then **migrate content**. Old Worker still understands `_type: "video"` via legacy paths until this PR; after deploy, legacy `video` is gone from reader PT overrides — unmigrated `video` blocks would stop rendering correctly.

### Phase 0 — Capture rollback handles (before anything mutates)

1. **Git / Worker baseline**
   - Record current production Worker version:
     ```powershell
     cd web
     npx wrangler deployments list --config wrangler.jsonc --env production
     ```
   - Record `origin/main` SHA that production is running (or the SHA of the last green production release).

2. **Turso rollback branch (mandatory)**  
   From repo root:
   ```powershell
   pwsh ./scripts/turso-create-rollback-branch.ps1 `
     -ProductionDatabaseName freedomtimes-emdash-production `
     -AllowProduction `
     -Notes "emdash-embeds cutover pre-migrate"
   ```
   Keep the JSON under `.release/rollback-branches/`. Generate DB URL + token for that branch (Turso dashboard / CLI) and store with the metadata — required for Phase R.

3. **File export (second belt)**  
   ```powershell
   wsl bash -lc 'export PATH="$HOME/.turso:$PATH"; mkdir -p .release/backups; turso db export freedomtimes-emdash-production --output-file ./.release/backups/emdash-production-$(date +%Y%m%d-%H%M%S)-pre-embeds.db'
   ```

### Phase 1 — Deploy code (Worker only is enough for this PR)

Preferred (local hotfix path):

```powershell
pwsh ./scripts/deploy-production-local.ps1 -WorkerOnly -AllowProduction
```

Or CI: merge to `main` then `pwsh ./scripts/production-release.ps1 … -AllowProduction` per [PRODUCTION_RELEASE_RUNBOOK.md](../../PRODUCTION_RELEASE_RUNBOOK.md).

**Verify before migrating content:**

- Production homepage loads
- A post **without** video still looks normal (e.g. Norway judgment passages — headings not code blocks)
- Smoke draft/youtube if available

### Phase 2 — Migrate production content

Dry-run each slug, then apply + publish (publishes may notify subscribers):

```powershell
cd web
$env:EMDASH_ALLOW_PRODUCTION = "1"
# Prefer EMDASH_PRODUCTION_PAT (same resolver as staging MCP helper)

node scripts/migrate-pt-content.mjs posts ahmadi-religion-of-peace-and-light-crewe-raids-roundup-30-apr-2026 --transforms video --url https://freedomtimes.news
node scripts/migrate-pt-content.mjs posts ahmadi-religion-of-peace-and-light-crewe-raids-roundup-30-apr-2026 --transforms video --url https://freedomtimes.news --apply --publish

node scripts/migrate-pt-content.mjs posts weekly-summary-8-june-2026 --transforms video --url https://freedomtimes.news --apply --publish

node scripts/migrate-pt-content.mjs posts pbcc-plymouth-brethren-cult-in-plain-sight-what-unchosen-shows-us-about-hidden-c-1 --transforms video --url https://freedomtimes.news --apply --publish

node scripts/migrate-pt-content.mjs posts --scan --transforms video --url https://freedomtimes.news
```

**Post-migrate verify**

| Slug | Expect |
|------|--------|
| Ahmadi | `<lite-youtube>` + Channel 4 `emdash-embed` video |
| Weekly 8 June | one `lite-youtube` |
| PBCC | `emdash-embed` players; no large white gap under cinematic clips |
| Scan | **0** remaining `video` |

Optional: after Ahmadi migrate, confirm BBC YouTube URL `PHEVjCZE47s` (ITV may be pulled) — staging already uses BBC; production may still need that caption/URL fix as a separate small edit.

### Phase 3 — Stabilize

- Watch for reader reports / broken embeds for 24h
- Do **not** delete the Turso rollback branch until stable
- Companion: merge agents MD→PT change so new drafts emit `youtube`/`embed` (not `_type: "video"`)

---

## Rollback plan (ready to execute)

Trigger if: production pages blank/broken for embeds, mass content corruption, deploy failure mid-cutover, or migrate writes wrong bodies.

### R1 — Stop further content writes

Do not run more `--apply` / `content_publish` until R2/R3 complete.

### R2 — Restore **code** (previous Worker)

**Option A — redeploy previous git SHA (preferred when main was green):**

```powershell
git fetch origin
git checkout <pre-cutover-main-sha>
pwsh ./scripts/deploy-production-local.ps1 -WorkerOnly -AllowProduction
git checkout main   # or return to working branch
```

**Option B — wrangler rollback to recorded deployment id** from Phase 0:

```powershell
cd web
npx wrangler rollback --config wrangler.jsonc --env production <deployment-id>
```

(Use the deployment id captured in Phase 0; confirm with `wrangler deployments list`.)

### R3 — Restore **database** (EmDash content)

Use the Phase 0 Turso **rollback branch** (point-in-time clone), not a blind re-migrate.

```powershell
# Values from Turso for the rollback branch named in .release/rollback-branches/*.json
pwsh ./scripts/switch-production-turso-secrets.ps1 `
  -DatabaseUrl "<rollback-libsql-url>" `
  -AuthToken "<rollback-db-token>" `
  -DatabaseName "<rollback-db-name>" `
  -SyncGitHub `
  -AllowProduction
```

Then redeploy or restart Worker secrets sync so production Worker reads the rollback DB (see script output / [PRODUCTION_RELEASE_RUNBOOK.md §6](../../PRODUCTION_RELEASE_RUNBOOK.md#6-rollback-strategy)).

**File export fallback** (if branch switch unavailable): restore from `.release/backups/emdash-production-*-pre-embeds.db` via Turso support/import procedures — slower; prefer the rollback branch.

### R4 — Verify rollback

- Production posts that were migrated show **pre-migrate** bodies again (legacy `video` OK if code rolled back too)
- Norway / Inès unchanged and intact
- Homepage + one weekly + one feature post load

### R5 — After rollback

- Leave rollback branch attached until root cause known
- Do **not** re-attempt migrate until code+content plan revalidated on staging
- If only content was bad but code is fine: prefer EmDash `revision_restore` / re-copy from staging for the few slugs instead of full DB switch — still keep the Turso branch as insurance

---

## What this migrate will **not** do

- It does **not** strip prose (Norway/Inès staging incidents were separate: rogue `_type: "code"` / partial `content_update`)
- It only rewrites `_type: "video"` → `youtube` or `embed`+`provider:"video"`
- Always dry-run and check the report under `web/data/pt-migrate/` (gitignored) before `--apply`

---

## Related docs

- [web/docs/DEPLOY.md](./DEPLOY.md) — deploy script matrix
- [web/CONTENT_PROMOTION_RUNBOOK.md](../CONTENT_PROMOTION_RUNBOOK.md) — Turso backups
- [PRODUCTION_RELEASE_RUNBOOK.md](../../PRODUCTION_RELEASE_RUNBOOK.md) — CI release + §6 rollback
- [docs/CLI_PATHS_WINDOWS.md](../../docs/CLI_PATHS_WINDOWS.md) — WSL Turso
