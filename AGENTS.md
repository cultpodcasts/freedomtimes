# Agent and operator notes

## Databases: backup before any change

Before **any** mutating operation on a database or CMS-backed store (Turso / libSQL, SQL migrations, seeds, EmDash content writes, MCP updates), create a **recoverable backup** of the **target** database first. Do not skip this for small edits.

Concrete steps and examples (Turso `db export`, rollback branches, scheduler/subscriptions): see **`web/CONTENT_PROMOTION_RUNBOOK.md`** section *Turso backups before any mutating work*.
