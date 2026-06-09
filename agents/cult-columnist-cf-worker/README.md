# Cult Columnist CF Worker

Standalone Cloudflare worker for the UK/EU cult-news pipeline.

**Node.js agent source** lives in the private sibling repo **freedomtimes-agents** (`../freedomtimes-agents` or `FREEDOMTIMES_AGENTS_DIR`). Regenerate D1 seeds from that repo’s JSON via `node scripts/generate-seed-migration.mjs` (run from this package).

## Objectives

- Run the cult-news pipeline as durable server-side infrastructure, not a local-only process.
- Preserve editorial quality by requiring human review between stages.
- Reuse existing Auth0 and config-management patterns from the main site.
- Keep HTTP fetch data transient (runtime cache only), with no seeded historical HTTP payloads.
- Publish summaries to Emdash only when there are valid stories; otherwise defer and sleep.

## Architecture (Cloudflare Agents / Project Think Track)

This project now uses the Cloudflare Agents SDK primitives and continues toward full Project Think coverage:

- Agent runtime: `Agent` base class from the Agents SDK (`src/orchestrator.ts`) with `routeAgentRequest` in `src/index.ts`.
- Durable execution: `runFiber()` + `stash()` checkpoints for long-running stage transitions.
- Sub-agents/facets: isolate major pipeline responsibilities where useful.
- Optional self-authored extensions: dynamic, sandboxed stage tools using codemode/extension manager (planned).
- Durable state: D1 for run state, stage status, config data, and review records.
- Transient HTTP runtime cache: D1 table with TTL (`http_cache_entries`) used only for active/local runs.

Current code runs through an Agents SDK orchestrator and callable RPC methods, while advanced Think features (extensions/session memory harness) remain planned.

## Pipeline Stages

- Stage 1: feed fetch
- Stage 2: candidate extraction
- Stage 3+: URL resolution, article fetch, scoring, dedup, grouping, render/publish (to be implemented)

Human review gates are required between stages.

## Security and Auth

- Public operational endpoints are Auth0-protected.
- Agent transport/internal SDK routes are handled by the Agents runtime.
- Uses the same Auth0 tenant/application model as the main site.
- Role-based authorization requires `editor` or `admin` role claim.
- JWT verification uses Auth0 JWKS with audience/issuer checks.

## Data Model and Seeding Policy

- Seeded data: static configuration only (feeds, host lists, term dictionaries, stopwords).
- No seeded HTTP data.
- HTTP cache is transient runtime data only and must expire via TTL.

Migrations:

- `migrations/0001_schema.sql`: core pipeline and config tables.
- `migrations/0002_seed_config.sql`: static config seed data.
- `migrations/0003_http_cache_schema.sql`: transient HTTP cache table.

## Environments

- `staging`: primary active environment for this worker.
- `production`: follow-on environment after staging validation and deployment pipeline readiness.

Wrangler environment config is defined in `wrangler.jsonc`.

## Config Management

Authority is the repo-root `.env.dev` pattern used across the monorepo.

- Non-sensitive values: wrangler `vars` (for example `AUTH0_API_AUDIENCE`, role namespace).
- Sensitive values: Worker secrets synced with existing scripts and conventions.
- Reuse existing secret-sync workflow and avoid introducing new secret systems.

### Runtime Focus Parameters (No Story Hardcoding)

- Keep week-ending story focus in runtime input, not in source code.
- Set optional `DISCOVERY_FOCUS_JSON` in Worker vars/secrets.
- Supported fields:
  - `focusSignalTerms`
  - `googleNewsGenericQueries`
  - `newsdataQueries`
  - `priorityWatchlistHosts`
- These are merged at runtime with the default discovery behavior so weekly priorities can change without code edits.

## Deployments

Deployments follow the same broad approach as existing workers, but this worker remains standalone in runtime/process boundaries.

- Staging deploy: `npm run deploy:staging`
- Terraform and dedicated CI/CD pipeline tracking is a separate deliverable (linked infra issue).

## Local Development

### Prerequisites

- Node.js 20+
- Wrangler CLI (via local dev dependency)
- Auth0 test token with `editor` or `admin` role

### Install

```powershell
cd agents/cult-columnist-cf-worker
npm install
```

### Apply local D1 migrations

```powershell
npm run db:migrate:local
```

### Start worker locally

```powershell
npm run dev
```

### Basic local checks

Unauthenticated request should return `401`:

```powershell
curl.exe -i http://127.0.0.1:8787/runs
```

Authenticated request should return run list:

```powershell
curl.exe -i -H "Authorization: Bearer <TOKEN>" http://127.0.0.1:8787/runs
```

Start a run:

```powershell
curl.exe -i -X POST -H "Authorization: Bearer <TOKEN>" http://127.0.0.1:8787/runs/start
```

Approve stage:

```powershell
curl.exe -i -X POST -H "Authorization: Bearer <TOKEN>" -H "Content-Type: application/json" -d "{}" http://127.0.0.1:8787/runs/<RUN_ID>/stages/feed_fetch/approve
```

Reject stage with notes:

```powershell
curl.exe -i -X POST -H "Authorization: Bearer <TOKEN>" -H "Content-Type: application/json" -d '{"notes":"feed errors need retry"}' http://127.0.0.1:8787/runs/<RUN_ID>/stages/feed_fetch/reject
```

## Next Implementation Milestones

- Add durable fiber recovery hooks and replay-safe stage resumption.
- Add remaining stages and scheduling behavior (`12h` sleep when no publishable stories).
- Add editor-facing stage diagnostics payloads for review UI.
- Wire Emdash publish path for completed, approved runs.
