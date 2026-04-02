# Development Guardrails

These guardrails define how ticket work moves from development to production.

## Branch and Main Rules

- No development work is done directly on `main` without explicit approval.
- Normal path to `main`:
  - Work happens on a feature branch.
  - Staging testing passes.
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
