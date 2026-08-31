# Agent and operator notes

## Primary guardrails (AI agents)

These apply to **every** Cursor agent session. When a guardrail blocks progress, **STOP and wait** for the operator — do not work around unless they **explicitly** override in that same chat.

1. **EmDash MCP — IF MCP FAILS WE DO NOT FALL BACK TO SHELL.** When Cursor EmDash MCP (`freedomtimes-staging` / `freedomtimes-production`, or equivalent servers under **Tools & MCP**) is **unavailable**, **errored**, **auth invalid**, or **`call_mcp_tool` is not registered**: **STOP immediately.** Tell the operator: *"EmDash MCP is not available in this session. Enable the EmDash MCP servers under Tools & MCP, restart Cursor if needed, refresh tokens (`emdash login` / PAT), and check Output → MCP Logs. Tell me when ready."* Then **wait**. **Never** fall back to `node web/scripts/emdash-mcp-tools-call.mjs`, `npx emdash content …`, `npx emdash schema …`, REST curl, or other shell/CLI workarounds. **Operators** may run shell helpers manually; **AI agents may not.**

2. **Database backup before any mutate.** Before Turso/libSQL writes, SQL migrations, seeds, or EmDash content writes (`content_update`, `content_publish`, etc.), create a **recoverable backup** of the target database first. See **`web/CONTENT_PROMOTION_RUNBOOK.md`** and **`docs/CLI_PATHS_WINDOWS.md`**.

3. **EmDash MCP-only for schema and content JSON.** Do **not** use `npx emdash schema …` / `npx emdash content …` to inspect or edit stored **`posts` / `pages` `content`** (Portable Text). Use Cursor MCP (`content_get`, `content_update`, …). CLI exceptions: `emdash login`, `emdash media upload` (binary / official OG cards — see §8), `emdash doctor` — auth/upload/diagnostics only. **When writing body content via MCP:** send a **Portable Text array**, never a raw markdown string (see § *EmDash: MCP only* below; sibling **freedomtimes-agents** [AGENTS.md](../freedomtimes-agents/AGENTS.md) §3).

4. **Staging locked — nothing is public.** Never expose anonymous reader or editorial routes on staging. Full policy: **`web/docs/STAGING_ACCESS.md`**.

5. **No production publish without explicit ask — but production edits must go live.** Never run production `content_publish`, `promote-post-staging-to-production.mjs`, or equivalent unless the operator **explicitly asks in that chat**. Asking to **change / fix / update** a production post **is** that ask: after backup + `content_update`, also run **`content_publish`** on the same slug so the live post updates — do **not** stop at a draft revision unless they say draft-only. Warn that publish may notify subscribers; still publish when they asked for a production change. After promote/publish is live, **request Google indexing** for the public URL (GSC MCP `submit_url` / `submit_batch`) — see **`web/CONTENT_PROMOTION_RUNBOOK.md`** §7.

6. **CLI authentication — IF NOT AUTHENTICATED YOU MUST STOP.** When any required CLI reports an auth failure (not logged in, invalid token, permission denied): **STOP immediately.** Name the CLI, give the exact auth command for that tool, tell the operator to authenticate and confirm when ready, then **wait**. **Never** silently fall back to alternate APIs, unauthenticated endpoints, or skip the step unless the operator **explicitly** approves an alternate path in that same session. Applies to **wrangler**, **gh**, **turso**, **emdash login**, **terraform** / provider tokens, **cloudflare**, etc.

7. **Turso CLI — IF TURSO AUTH FAILS WE DO NOT BYPASS.** **Windows:** `wsl bash -lic "turso auth whoami"` (Turso lives in WSL); interactive `turso auth login` when no Platform API token is in env. **Linux** (cloud VMs, no `wsl`): native `turso` on PATH or `$HOME/.turso/turso`. Local deploy / CI set the CLI token from `TURSO_PLATFORM_API_TOKEN` (else `TURSO_API_TOKEN` / `TF_VAR_turso_api_token` / non-JWT `TURSO_TOKEN`) via `turso config set token`, then `turso auth whoami`. **Never** use `TURSO_AUTH_TOKEN` or other database JWTs for CLI auth. Still run `turso db export` / rollback after auth — do not skip backup. If those keys are missing and whoami fails: **STOP immediately.** Tell the operator: *"Turso CLI is not authenticated. Run `wsl bash -lic \"turso auth login\"` (Windows) or `turso auth login` (Linux), or set `TURSO_PLATFORM_API_TOKEN`, then tell me when ready."* Then **wait**. See **`docs/CLI_PATHS_WINDOWS.md`**.

8. **Large media — never MCP `media_upload` base64.** Official OG/social PNGs (typically 200–600KB) **truncate, time out, or become 1×1 placeholders** when sent as MCP `base64`. Ignore the `media_upload` tool’s `base64` hint for those files. Put bytes with **`emdash media upload`** (already a CLI exception for binary — this is the correct path for OG cards) or **`POST /_emdash/api/media`** multipart (or Admin/raw R2 put; then MCP **`media_create`** if there is no library row, else **`media_update`**). Then MCP **`content_update`** with **`seo.image`** set to the same-origin file path **`/_emdash/api/media/file/<storageKey>`** (same as `seoImageFieldValueFromNormalizedRow` in `web/scripts/generate-social-images.ts`). A **bare media id** validates but leaves the admin OG Image widget empty; do **not** store a raw `storageKey` without the prefix. Do **not** JPEG-crush or replace official `generate-social-images.ts` / `draft:push-staging` cards. Procedure: **[docs/CURSOR_EMDASH_MCP.md § Large media uploads](docs/CURSOR_EMDASH_MCP.md#large-media-uploads-avoid-mcp-base64-truncation)**. Schema and content JSON remain MCP-only (guardrail §3).

9. **GitHub PRs — CultPodcasts, not the Cursor App.** New cloud agents authenticate as the `cursor` GitHub App: they can **push** `cursor/*` branches but **cannot** create issues/PRs (`must be a collaborator`, `Resource not accessible by integration`). Repo admin is **`cultpodcasts`** (CultPodcastsBot); that is who opens PRs. **Do not stop** at a compare URL.

   **Prefer the Cursor environment secret `CULTPODCASTS_GH_TOKEN`** (exact name; CultPodcasts PAT with `repo`, `read:org`, `workflow`). **90-day expiry** — the token stored 2026-08-31 lapses ~2026-11-29; rotate the GitHub PAT and update this secret before then. `printf '%s\n' "$CULTPODCASTS_GH_TOKEN" | gh auth login --hostname github.com --with-token --insecure-storage` then `gh auth switch --user cultpodcasts`. **Never** name or export this as `GH_TOKEN` / `GITHUB_TOKEN` (that replaces the App token used for `git push`). If the secret is missing or `gh auth` fails: device-login as **CultPodcasts** (https://github.com/login/device + one-time code), then switch and `gh pr create`. Full steps: **[docs/CLOUD_AGENT_GITHUB_PR.md](docs/CLOUD_AGENT_GITHUB_PR.md)**.

## CLI paths (Windows vs WSL)

**Primary reference:** **[docs/CLI_PATHS_WINDOWS.md](docs/CLI_PATHS_WINDOWS.md)** — Windows-native Terraform vs WSL Turso (Windows) / native Turso (Linux), PATH verification, and repo script patterns.

- Quick check: `where.exe terraform` (Windows). Turso: `wsl bash -lic "turso auth whoami"` then `turso db list` in WSL; on Linux `turso auth whoami` / `$HOME/.turso/turso`.
- Do not run parallel Terraform operations on the same environment (staging/production/auth0-shared); `scripts/terraform-run.ps1` enforces a per-environment file lock.
- Auth failures: **Primary guardrails §6–§7** — STOP; do not bypass.
- Turso backups and rollback branches: **[web/CONTENT_PROMOTION_RUNBOOK.md](web/CONTENT_PROMOTION_RUNBOOK.md)** (Turso backups section).

## EmDash: MCP only for schema and content (hard rule)

**Do not use the EmDash CLI** (`npx emdash schema …`, `npx emdash content …`) **to inspect collection schema or to read/edit/publish content** when you care about the **real stored JSON** (especially **`posts` / `pages` `content`** as Portable Text). The CLI’s JSON output **does not reliably expose** the underlying document shape and has misled debugging repeatedly.

**If MCP can write Portable Text, always do so.** For `content_create` / `content_update`, `data.content` must be a **Portable Text JSON array** — **never** a markdown string. EmDash’s built-in MD→PT leaves reader-visible artefacts (literal `*emphasis*`, image text in `alt` only). Agent drafts convert with sibling **freedomtimes-agents** `scripts/markdown-to-portable-text.mts` / `draft:push-staging` (see that repo’s [AGENTS.md](../freedomtimes-agents/AGENTS.md) §3).

**AI agents — Cursor MCP only:** Use **Cursor** EmDash MCP servers (`freedomtimes-staging`, `freedomtimes-production`) when they appear under **Tools & MCP**. Setup/repair on Windows: **`docs/CURSOR_EMDASH_MCP.md`**; operator skill **`~/.cursor/skills/freedomtimes-emdash-mcp/SKILL.md`**. Call **`content_get`**, **`content_update`**, **`content_publish`**, **`content_create`**, **`schema_list_collections`**, **`schema_get_collection`**, etc. via **`call_mcp_tool`** — not via shell. **If MCP fails, see Primary guardrails §1 — STOP; do not use shell.**

**Operators (humans) — shell MCP helper (optional):** From a terminal, `node web/scripts/emdash-mcp-tools-call.mjs [--url <origin>] <toolName> '<json-args>'` hits the same `POST /_emdash/api/mcp` + JSON-RPC `tools/call` as the IDE. Token: `~/.config/emdash/auth.json` or `EMDASH_STAGING_TOKEN` / `EMDASH_PRODUCTION_TOKEN` / `EMDASH_MCP_TOKEN`. Operators may choose this when Cursor MCP is awkward; **AI agents must not** — see **Primary guardrails §1**.

**Examples:** `content_get` → `{"collection":"posts","id":"<slug>"}`; **`schema_list_collections`** → `{}`; **`schema_get_collection`** → `{"slug":"posts"}` (there is no `schema_get` tool).

Repo scripts **`promote-post-staging-to-production.mjs`** and **`merge-staging-post-from-patch.mjs`** apply this rule: staging reads and production writes use **MCP** (or REST only where noted for `_rev` resolution), not `emdash content` / `emdash schema`.

**CLI exceptions (outside schema + content JSON):** e.g. **`emdash login`**, **`emdash media upload`** (binary / official OG cards — never MCP `media_upload` base64; see **Primary guardrails** §8), **`emdash doctor`** — only when the task is explicitly about auth, binary upload, or local diagnostics, not about inspecting or editing entry JSON.

**Cursor `call_mcp_tool` vs this repo:** Some agent sessions only register built-in MCP servers (e.g. `cursor-ide-browser`) and do **not** see Freedom Times EmDash servers. That is a **Primary guardrails §1 blocker** — enable servers under **Ctrl+Shift+J → Tools & MCP**, restart Cursor, check **Output → MCP Logs**, then **wait** for the operator.

Details: **`web/docs/PLAN_EMDASH_CONTENT_FORMAT_AND_MCP_HANDOFF.md`** (section **CLI vs MCP**) and **`web/docs/PR_CHECKLIST_EMDASH_CONTENT.md`** (§**2.0a**). For **English-ledes, French outlet glosses, hoisting stakes, and the canonical French `blockquote` + English translation `<details>` PT block order**, see **`web/docs/EDITORIAL_ENGLISH_GLOSSES.md`**.

## Databases: backup before any change

See **Primary guardrails §2**. Before **any** mutating operation on a database or CMS-backed store (Turso / libSQL, SQL migrations, seeds, EmDash content writes, MCP updates), create a **recoverable backup** of the **target** database first. Do not skip this for small edits.

Concrete steps and examples (Turso `db export`, rollback branches, scheduler/subscriptions — Turso CLI in **WSL on Windows**, **native on Linux**): see **`web/CONTENT_PROMOTION_RUNBOOK.md`** section *Turso backups before any mutating work*; invoke patterns in **`docs/CLI_PATHS_WINDOWS.md`**.

## Staging access: NOTHING IS PUBLIC (hard rule for AI agents)

See **Primary guardrails §4**. Staging (`SITE_ACCESS_MODE=locked`, `staging.freedomtimes.news`) must **never** expose anonymous reader or editorial routes. The only paths that bypass the outer Auth0 wall are EmDash internal auth (`/_emdash/*`, `/.well-known/*`) plus `/auth/*` and the `/` login wall.

- **Do not** add routes to `AUTH_BYPASS_RULES` in `web/src/middleware.ts` except EmDash/OAuth metadata.
- **Do not** add staging-only public exceptions.
- Production-public reader routes belong in `PUBLIC_READER_PATHS` (`web/src/lib/auth.ts`) and **must** call `authorizeReaderApiRequest` (API) or `requireReaderPageSession` (page) from `web/src/lib/editorial-session.ts`.
- To test reader flows on staging: sign in first, then open the route.

Full policy: **`web/docs/STAGING_ACCESS.md`**.

## Local deploy (AI agents)

**Canonical reference:** **[web/docs/DEPLOY.md](web/docs/DEPLOY.md)** — script decision table, flags, step order, prerequisites, and failure troubleshooting. Read the [For AI agents](web/docs/DEPLOY.md#for-ai-agents) section before running any deploy command.

**Entry points only** (from repo root):

| Script | Purpose |
|--------|---------|
| `scripts/deploy-staging-local.ps1` | Staging deploy (full, `-WorkerOnly`, or `-WorkersOnly`) |
| `scripts/deploy-production-local.ps1` | Local production deploy (full or `-WorkerOnly -AllowProduction`) |
| `scripts/production-release.ps1` | CI release — dispatches GitHub Actions; not a local wrangler deploy |

**Do not invoke:** `Deploy-EnvironmentCommon.ps1` (helpers only); deprecated `*-rebuild-local.ps1` (use `deploy-*-local.ps1`).

**Hard rules for agents:**

- Do **not** run production deploy (`deploy-production-local.ps1`, `production-release.ps1`) unless the operator **explicitly asks in this chat**.
- Full `deploy-production-local.ps1` and `-WorkerOnly` create a Turso rollback checkpoint **before** `emdash migrate` — requires authenticated Turso CLI (**Primary guardrails §7**; WSL on Windows, native on Linux). Staging `turso db export` uses `TF_VAR_TURSO_DATABASE_NAME_STAGING` when set; otherwise the Terraform staging `turso_database_name` default (do not require that env key as a Cursor secret). When `TURSO_PRODUCTION_EMDASH_DB_URL` is set, `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` are the staging EmDash pair — do not treat them as production. Do not pass `-SkipTursoBackup` unless a checkpoint newer than 24h already exists.
- Deploy scripts ship Workers and infra; they do **not** publish EmDash content (**Primary guardrails §5** for `content_publish`).
- On deploy failure, use the canonical doc's [Quick symptom index](web/docs/DEPLOY.md#quick-symptom-index) — do not improvise alternate script names.

Context-specific runbooks (link to canonical doc for script details): [PRODUCTION_RELEASE_RUNBOOK.md](PRODUCTION_RELEASE_RUNBOOK.md) (CI + promotion), [STAGING_RECOVERY.md](STAGING_RECOVERY.md) (recovery checklist).
