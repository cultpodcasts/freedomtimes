# Agent and operator notes

## Primary guardrails (AI agents)

These apply to **every** Cursor agent session. When a guardrail blocks progress, **STOP and wait** for the operator — do not work around unless they **explicitly** override in that same chat.

1. **EmDash MCP — IF MCP FAILS WE DO NOT FALL BACK TO SHELL.** When Cursor EmDash MCP (`freedomtimes-staging` / `freedomtimes-production`, or equivalent servers under **Tools & MCP**) is **unavailable**, **errored**, **auth invalid**, or **`call_mcp_tool` is not registered**: **STOP immediately.** Tell the operator: *"EmDash MCP is not available in this session. Enable the EmDash MCP servers under Tools & MCP, restart Cursor if needed, refresh tokens (`emdash login` / PAT), and check Output → MCP Logs. Tell me when ready."* Then **wait**. **Never** fall back to `node web/scripts/emdash-mcp-tools-call.mjs`, `npx emdash content …`, `npx emdash schema …`, REST curl, or other shell/CLI workarounds. **Operators** may run shell helpers manually; **AI agents may not.**

2. **Database backup before any mutate.** Before Turso/libSQL writes, SQL migrations, seeds, or EmDash content writes (`content_update`, `content_publish`, etc.), create a **recoverable backup** of the target database first. See **`web/CONTENT_PROMOTION_RUNBOOK.md`** and **`docs/CLI_PATHS_WINDOWS.md`**.

3. **EmDash MCP-only for schema and content JSON.** Do **not** use `npx emdash schema …` / `npx emdash content …` to inspect or edit stored **`posts` / `pages` `content`** (Portable Text). Use Cursor MCP (`content_get`, `content_update`, …). CLI exceptions: `emdash login`, `emdash media upload`, `emdash doctor` — auth/upload/diagnostics only.

4. **Staging locked — nothing is public.** Never expose anonymous reader or editorial routes on staging. Full policy: **`web/docs/STAGING_ACCESS.md`**.

5. **No production publish without explicit ask.** Never run production `content_publish`, `promote-post-staging-to-production.mjs`, or equivalent unless the operator **explicitly asks in that chat**. Production publish sends **push notifications** — irreversible.

6. **CLI authentication — IF NOT AUTHENTICATED YOU MUST STOP.** When any required CLI reports an auth failure (not logged in, invalid token, permission denied): **STOP immediately.** Name the CLI, give the exact auth command for that tool, tell the operator to authenticate and confirm when ready, then **wait**. **Never** silently fall back to alternate APIs, unauthenticated endpoints, or skip the step unless the operator **explicitly** approves an alternate path in that same session. Applies to **wrangler**, **gh**, **turso**, **emdash login**, **terraform** / provider tokens, **cloudflare**, etc.

7. **Turso CLI (WSL) — IF TURSO AUTH FAILS WE DO NOT BYPASS.** When `wsl bash -lic "turso auth whoami"` fails or reports not logged in: **STOP immediately.** Tell the operator: *"Turso CLI is not authenticated in WSL. Run `wsl bash -lic \"turso auth login\"`, complete login, then tell me when ready."* Then **wait**. **Never** use Platform API or other workarounds for backup/export/import that require an authenticated Turso CLI unless the operator **explicitly** approves an alternate path in that same session. See **`docs/CLI_PATHS_WINDOWS.md`**.

## CLI paths (Windows vs WSL)

**Primary reference:** **[docs/CLI_PATHS_WINDOWS.md](docs/CLI_PATHS_WINDOWS.md)** — Windows-native Terraform vs WSL-only Turso CLI, PATH verification, and repo script patterns.

- Quick check: `where.exe terraform` (Windows); `wsl bash -lic "turso auth whoami"` then `wsl bash -lic "turso db list"` (Turso in WSL).
- Do not run parallel Terraform operations on the same environment (staging/production/auth0-shared); `scripts/terraform-run.ps1` enforces a per-environment file lock.
- Auth failures: **Primary guardrails §6–§7** — STOP; do not bypass.
- Turso backups and rollback branches: **[web/CONTENT_PROMOTION_RUNBOOK.md](web/CONTENT_PROMOTION_RUNBOOK.md)** (Turso backups section).

## EmDash: MCP only for schema and content (hard rule)

**Do not use the EmDash CLI** (`npx emdash schema …`, `npx emdash content …`) **to inspect collection schema or to read/edit/publish content** when you care about the **real stored JSON** (especially **`posts` / `pages` `content`** as Portable Text). The CLI’s JSON output **does not reliably expose** the underlying document shape and has misled debugging repeatedly.

**AI agents — Cursor MCP only:** Use **Cursor** EmDash MCP servers (`freedomtimes-staging`, `freedomtimes-production`) when they appear under **Tools & MCP**. Setup/repair on Windows: **`docs/CURSOR_EMDASH_MCP.md`**; operator skill **`~/.cursor/skills/freedomtimes-emdash-mcp/SKILL.md`**. Call **`content_get`**, **`content_update`**, **`content_publish`**, **`content_create`**, **`schema_list_collections`**, **`schema_get_collection`**, etc. via **`call_mcp_tool`** — not via shell. **If MCP fails, see Primary guardrails §1 — STOP; do not use shell.**

**Operators (humans) — shell MCP helper (optional):** From a terminal, `node web/scripts/emdash-mcp-tools-call.mjs [--url <origin>] <toolName> '<json-args>'` hits the same `POST /_emdash/api/mcp` + JSON-RPC `tools/call` as the IDE. Token: `~/.config/emdash/auth.json` or `EMDASH_STAGING_TOKEN` / `EMDASH_PRODUCTION_TOKEN` / `EMDASH_MCP_TOKEN`. Operators may choose this when Cursor MCP is awkward; **AI agents must not** — see **Primary guardrails §1**.

**Examples:** `content_get` → `{"collection":"posts","id":"<slug>"}`; **`schema_list_collections`** → `{}`; **`schema_get_collection`** → `{"slug":"posts"}` (there is no `schema_get` tool).

Repo scripts **`promote-post-staging-to-production.mjs`** and **`merge-staging-post-from-patch.mjs`** apply this rule: staging reads and production writes use **MCP** (or REST only where noted for `_rev` resolution), not `emdash content` / `emdash schema`.

**CLI exceptions (outside schema + content JSON):** e.g. **`emdash login`**, **`emdash media upload`**, **`emdash doctor`** — only when the task is explicitly about auth, binary upload, or local diagnostics, not about inspecting or editing entry JSON.

**Cursor `call_mcp_tool` vs this repo:** Some agent sessions only register built-in MCP servers (e.g. `cursor-ide-browser`) and do **not** see Freedom Times EmDash servers. That is a **Primary guardrails §1 blocker** — enable servers under **Ctrl+Shift+J → Tools & MCP**, restart Cursor, check **Output → MCP Logs**, then **wait** for the operator.

Details: **`web/docs/PLAN_EMDASH_CONTENT_FORMAT_AND_MCP_HANDOFF.md`** (section **CLI vs MCP**) and **`web/docs/PR_CHECKLIST_EMDASH_CONTENT.md`** (§**2.0a**). For **English-ledes, French outlet glosses, hoisting stakes, and the canonical French `blockquote` + English translation `<details>` PT block order**, see **`web/docs/EDITORIAL_ENGLISH_GLOSSES.md`**.

## Databases: backup before any change

See **Primary guardrails §2**. Before **any** mutating operation on a database or CMS-backed store (Turso / libSQL, SQL migrations, seeds, EmDash content writes, MCP updates), create a **recoverable backup** of the **target** database first. Do not skip this for small edits.

Concrete steps and examples (Turso `db export`, rollback branches, scheduler/subscriptions — Turso CLI in **WSL**): see **`web/CONTENT_PROMOTION_RUNBOOK.md`** section *Turso backups before any mutating work*; invoke patterns in **`docs/CLI_PATHS_WINDOWS.md`**.

## Staging access: NOTHING IS PUBLIC (hard rule for AI agents)

See **Primary guardrails §4**. Staging (`SITE_ACCESS_MODE=locked`, `staging.freedomtimes.news`) must **never** expose anonymous reader or editorial routes. The only paths that bypass the outer Auth0 wall are EmDash internal auth (`/_emdash/*`, `/.well-known/*`) plus `/auth/*` and the `/` login wall.

- **Do not** add routes to `AUTH_BYPASS_RULES` in `web/src/middleware.ts` except EmDash/OAuth metadata.
- **Do not** add staging-only public exceptions.
- Production-public reader routes belong in `PUBLIC_READER_PATHS` (`web/src/lib/auth.ts`) and **must** call `authorizeReaderApiRequest` (API) or `requireReaderPageSession` (page) from `web/src/lib/editorial-session.ts`.
- To test reader flows on staging: sign in first, then open the route.

Full policy: **`web/docs/STAGING_ACCESS.md`**.
