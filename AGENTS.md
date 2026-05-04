# Agent and operator notes

## EmDash: use MCP for `posts.content` / Portable Text shape

When the task is to **inspect, migrate, or reason about** `posts` (or `pages`) **`content`** for **Portable Text vs markdown string**, **do not rely only on** `npx emdash content get … --json`. That output often shows **`data.content` as a markdown string** even when **MCP `content_get`** returns **`item.data.content`** as a **PT array** and Turso stores JSON arrays—CLI-first checks have misled sessions and wasted tokens.

**Default:** use the **EmDash MCP** `content_get` tool (or the same API over HTTP with correct `Accept` headers) and read **`item.data.content`**. Use the CLI for metadata or when the user explicitly wants CLI output.

Details: **`web/docs/PLAN_EMDASH_CONTENT_FORMAT_AND_MCP_HANDOFF.md`** (section **CLI vs MCP**) and **`web/docs/PR_CHECKLIST_EMDASH_CONTENT.md`** (§**2.0a**). For **English-ledes, French outlet glosses, hoisting stakes, and the canonical French `blockquote` + English translation `<details>` PT block order**, see **`web/docs/EDITORIAL_ENGLISH_GLOSSES.md`** (same file — do not duplicate elsewhere).

## Databases: backup before any change

Before **any** mutating operation on a database or CMS-backed store (Turso / libSQL, SQL migrations, seeds, EmDash content writes, MCP updates), create a **recoverable backup** of the **target** database first. Do not skip this for small edits.

Concrete steps and examples (Turso `db export`, rollback branches, scheduler/subscriptions): see **`web/CONTENT_PROMOTION_RUNBOOK.md`** section *Turso backups before any mutating work*.
