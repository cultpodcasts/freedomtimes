# Next Pass Plan

## Scope

Focus on durable orchestration hardening and pipeline completion for the Cloudflare Agents worker.

## Priority 1: Fiber Recovery Hardening

- Add replay-safe recovery path for in-flight stage transitions keyed by fiber ID.
- Persist stage execution intent and idempotency keys before side effects.
- On recovery, resume from persisted intent instead of re-running side effects blindly.
- Add explicit recovery telemetry (runId, stage, resumedFromFiberId, recoveryOutcome).
- Add tests for eviction/restart scenarios and duplicate approval submissions.

## Priority 2: Remaining Stages

- Implement URL resolution stage.
- Implement article fetch stage with host backoff and fallback policy.
- Implement scoring and dedup/grouping stages.
- Keep human review gates between stages.

## Priority 2A: Node.js Agent Port Track

- Inventory current Node.js pipeline modules in agents/uk-and-europe-cults-columnist and map each to a Cloudflare worker/stage target.
- Port feed discovery and URL normalization logic with behavior parity tests against Node.js fixture inputs.
- Port article retrieval fallback chain (direct, archive fallback, browser-render fallback) with host-level retry/backoff parity.
- Port scoring stack (relevance, cult precision, figurative checks) and validate score deltas against sampled Node.js outputs.
- Port dedup/grouping heuristics and verify cluster membership parity on a fixed historical run sample.
- Port HTML digest rendering path and validate output schema/markup compatibility with downstream publish path.
- Create a parity matrix document: module-by-module status, blockers, and accepted behavior differences.

## Priority 3: Scheduling and Operations

- Add cron/alarm scheduling with defer behavior when no publishable stories exist.
- Improve run diagnostics payloads for editorial review UI.
- Validate staging runbook and rollback notes.

## Exit Criteria for This Pass

- Recovery from a forced restart continues the active run without duplicate side effects.
- Approval/reject flows remain idempotent under retries.
- End-to-end run can progress through at least one newly added stage under local and staging checks.
- Node.js-to-Cloudflare parity matrix is complete for all currently ported modules.
