# Agent and operator notes

## EmDash: MCP only for schema and content (hard rule)

**Do not use the EmDash CLI** (`npx emdash schema …`, `npx emdash content …`) **to inspect collection schema or to read/edit/publish content** when you care about the **real stored JSON** (especially **`posts` / `pages` `content`** as Portable Text). The CLI’s JSON output **does not reliably expose** the underlying document shape and has misled debugging repeatedly.

**Allowed instead:**

- **Cursor** EmDash MCP servers from `.cursor/mcp.json` (`freedomtimes-staging`, `freedomtimes-production`), when they appear under **Tools & MCP**, **or**
- **HTTP MCP** from the shell: `node web/scripts/emdash-mcp-tools-call.mjs [--url <origin>] <toolName> '<json-args>'` — same `POST /_emdash/api/mcp` + JSON-RPC `tools/call` as the IDE.

**Examples:** `content_get` → `{"collection":"posts","id":"<slug>"}`; **`schema_list_collections`** → `{}`; **`schema_get_collection`** → `{"slug":"posts"}` (there is no `schema_get` tool); **`content_update`** / **`content_publish`** / **`content_create`** with arguments from `tools/list` on the instance. Token: `~/.config/emdash/auth.json` or `EMDASH_STAGING_TOKEN` / `EMDASH_PRODUCTION_TOKEN` / `EMDASH_MCP_TOKEN`.

Repo scripts **`promote-post-staging-to-production.mjs`** and **`merge-staging-post-from-patch.mjs`** apply this rule: staging reads and production writes use **MCP** (or REST only where noted for `_rev` resolution), not `emdash content` / `emdash schema`.

**CLI exceptions (outside schema + content JSON):** e.g. **`emdash login`**, **`emdash media upload`**, **`emdash doctor`** — only when the task is explicitly about auth, binary upload, or local diagnostics, not about inspecting or editing entry JSON.

**Cursor `call_mcp_tool` vs this repo:** Some agent sessions only register built-in MCP servers (e.g. `cursor-ide-browser`) and do **not** see Freedom Times EmDash servers. Use **Ctrl+Shift+J → Tools & MCP** (enable servers, restart Cursor, **Output → MCP Logs**). Until then, use **`emdash-mcp-tools-call.mjs`** so behavior stays MCP-equivalent.

Details: **`web/docs/PLAN_EMDASH_CONTENT_FORMAT_AND_MCP_HANDOFF.md`** (section **CLI vs MCP**) and **`web/docs/PR_CHECKLIST_EMDASH_CONTENT.md`** (§**2.0a**). For **English-ledes, French outlet glosses, hoisting stakes, and the canonical French `blockquote` + English translation `<details>` PT block order**, see **`web/docs/EDITORIAL_ENGLISH_GLOSSES.md`**.

## Databases: backup before any change

Before **any** mutating operation on a database or CMS-backed store (Turso / libSQL, SQL migrations, seeds, EmDash content writes, MCP updates), create a **recoverable backup** of the **target** database first. Do not skip this for small edits.

Concrete steps and examples (Turso `db export`, rollback branches, scheduler/subscriptions — run Turso CLI in **WSL**): see **`web/CONTENT_PROMOTION_RUNBOOK.md`** section *Turso backups before any mutating work*.

## Staging access: NOTHING IS PUBLIC (hard rule for AI agents)

Staging (`SITE_ACCESS_MODE=locked`, `staging.freedomtimes.news`) must **never** expose anonymous reader or editorial routes. The only paths that bypass the outer Auth0 wall are EmDash internal auth (`/_emdash/*`, `/.well-known/*`) plus `/auth/*` and the `/` login wall.

- **Do not** add routes to `AUTH_BYPASS_RULES` in `web/src/middleware.ts` except EmDash/OAuth metadata.
- **Do not** add staging-only public exceptions.
- Production-public reader routes belong in `PUBLIC_READER_PATHS` (`web/src/lib/auth.ts`) and **must** call `authorizeReaderApiRequest` (API) or `requireReaderPageSession` (page) from `web/src/lib/editorial-session.ts`.
- To test reader flows on staging: sign in first, then open the route.

Full policy: **`web/docs/STAGING_ACCESS.md`**.
