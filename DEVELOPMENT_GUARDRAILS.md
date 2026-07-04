# Development Guardrails

These guardrails define how ticket work moves from development to production.

## Primary guardrails (AI agents in Cursor)

Canonical copy: **`AGENTS.md`** § *Primary guardrails*. Summary for agents working in this repo:

1. **EmDash MCP — IF MCP FAILS WE DO NOT FALL BACK TO SHELL.** When Cursor EmDash MCP is unavailable, errored, or auth fails: **STOP**, tell the operator to fix MCP (**Tools & MCP**, restart Cursor, enable `freedomtimes-staging` / `freedomtimes-production`, refresh tokens via `emdash login` / PAT, check **Output → MCP Logs**), then **wait**. **Never** fall back to `emdash-mcp-tools-call.mjs`, `npx emdash content`, REST curl, or CLI. Operators may run shell helpers manually; AI agents may not.
2. **Database backup before any mutate** — Turso rollback branch or export before CMS/DB writes.
3. **EmDash MCP-only for content JSON** — not EmDash CLI for `posts`/`pages` Portable Text shape.
4. **Staging locked** — no anonymous staging reader routes (`web/docs/STAGING_ACCESS.md`).
5. **No production publish without explicit operator ask** — push notifications are irreversible.

## Branch and Main Rules

- No development work is done directly on `main` without explicit approval.
- Normal path to `main`:
  - Work happens on a feature branch.
  - Staging testing passes.
  - If the branch changes EmDash-dependent code or content model assumptions, production schema is checked and synced before the PR is closed.
  - PR is reviewed and merged.
- Exception path for production-only issues:
  - If a post-merge production-only issue is found, a direct `main` fix may be made only with explicit approval.

## Ticket Board Hygiene Before New Work

- Before starting a new ticket, current active tickets must be moved to:
  - `In review` (if they need longer-term testing), or
  - `Done`.
- Do not start a new ticket while prior tickets are still in `In progress` without agreement.

## New Ticket Start Criteria

- A new ticket can only be picked when the project board is up to date.
- Once the board is updated, create a dedicated feature branch for the new ticket.
- Every feature branch must be linked back to its ticket for traceability:
  - Branch name includes the ticket number (for example, `feat/11-editorial-api-cosmos`).
  - Add a comment on the ticket with the branch name and branch URL.

## PR Open Criteria

- After local development testing passes on the feature branch, open a PR.
- PRs are the default vehicle for code review, staging validation, and merge to `main`.
- PR description should reference the ticket (for example, `Closes #11`) so ticket lifecycle stays linked to delivery.

## PR Merge Criteria For EmDash-Dependent Changes

- If the branch changes code that depends on EmDash collections or fields, do not merge until production matches staging for the touched collections in both schema semantics and manifest visibility.
- Use `./scripts/promote-schema-to-production.ps1 -AllowProduction -DryRun` to verify parity and `./scripts/promote-schema-to-production.ps1 -AllowProduction` to apply missing schema changes.
- Before any non-dry-run production schema change, migration, or content promotion, a Turso rollback branch must be created and recorded.
- The script is not the full gate by itself. Manual review must also confirm collection metadata parity and that the production manifest/admin route expose the touched collections.
- Content promotion is not approved if it relies on manual copy/paste or any path that does not preserve UTF-8 payloads end to end.
- For promoted items, manual review must also confirm staging-versus-production parity for rendered text-bearing fields and reject mojibake signatures.
- The production Worker deploy from `main` is allowed only after this full Step 1 gate is confirmed, because the deployed code may reference fields or collection behavior that do not yet exist in production.
