# Agent npm scripts

Reference for every script in this package (`agents/uk-and-europe-cults-columnist/package.json`).

**Run all commands from this agent folder** (not the monorepo root):

```powershell
cd agents/uk-and-europe-cults-columnist
npm install
```

This agent is designed to be **self-contained** — it has its own `package.json`, `node_modules`, and docs. A few scripts (staging CMS push, EmDash media upload) invoke the EmDash CLI in the parent repo’s `web/` package (`../../web` from here). If this agent is split into its own repository, either vendor `emdash` CLI there or set `EMDASH_WEB_DIR` (future) / keep a sibling `web` checkout.

---

## Environment

| Variable | Used by | Notes |
|----------|---------|--------|
| `EMDASH_STAGING_PAT` | `draft:upload-images`, `draft:push-staging` | User env var; load in shell: `$env:EMDASH_STAGING_PAT = [Environment]::GetEnvironmentVariable('EMDASH_STAGING_PAT', 'User')` |
| `AGENT_ENV` | `start`, `dev`, `e2e:full` | Must be `staging` |
| `DRY_RUN` | pipeline scripts | Default `true` — no CMS writes from main agent |
| `.env` | `dev`, discovery, review | Copy from `.env.example`; see [WEEKLY_RUN.md](WEEKLY_RUN.md) |

---

## Weekly operator flow (summary)

| Step | Scripts / UI |
|------|----------------|
| Discovery + digest | `npm run dev` → `npm run render:html` |
| Review + cluster | `npm run feedback:server` → http://localhost:3000 |
| Article plan | http://localhost:3000/articles → Finalize |
| Draft prose | Agent / skill → `reports/drafts/<slug>.md` |
| Images | `draft:collect-images` → `/draft-images` → `draft:upload-images` → `draft:inject-images` |
| Staging CMS | `draft:push-staging` |

Detail: [WEEKLY_RUN.md](WEEKLY_RUN.md), [WEEKLY_REPORT_WRITING_GUIDE.md](WEEKLY_REPORT_WRITING_GUIDE.md), [CULT_WORDING.md](CULT_WORDING.md), [DRAFT_FROM_ARTICLE_PLAN.md](DRAFT_FROM_ARTICLE_PLAN.md).

---

## Core pipeline

| Script | Purpose |
|--------|---------|
| `npm run start` | Run agent once (`src/index.ts`) with `.env` |
| `npm run dev` | Discovery-first weekly run (`DISCOVERY_MAX_AGE_HOURS=168`, watchlist chunking) |
| `npm run pipeline:only` | Skip discovery; process existing candidates only |
| `npm run build` | Typecheck (`tsc --noEmit`) |
| `npm run typecheck` | Same as `build` |

**Args (dev/start):** `--url=…`, `--max=N` — see [README.md](../README.md).

---

## HTML digest & review UI

| Script | Purpose |
|--------|---------|
| `npm run render:html` | Build `reports/cult-news-latest.html` from pipeline output |
| `npm run render:cult-news` | Alias for `render:html` |
| `npm run feedback:server` | Local server on port 3000 — digest review, article plan, draft images |
| `npm run snapshot:html` | Copy `cult-news-latest.html` → `cult-news-snapshot.html` |
| `npm run diff:html` | Diff latest vs snapshot HTML reports |

**Feedback server routes:**

| URL | Use |
|-----|-----|
| http://localhost:3000 | Digest / false-positive review |
| http://localhost:3000/articles | Article planning |
| http://localhost:3000/draft-images?slug=… | Image approval |

Restart the server after pulling changes to `feedback-server.mts` or UI assets.

---

## Review report & article plan

| Script | Purpose |
|--------|---------|
| `npm run build:review-report` | Build `reports/review-report-latest.json` from active feedback |
| `npm run refetch:review-report` | Re-fetch article text for stories in the review report |

Article plan finalize is via **Articles UI** (`POST /api/article-plan/finalize`) → `reports/article-plan.json`.

---

## Draft → images → staging (roundup)

Slug example: `weekly-summary-8-june-2026`. Pass slug after `--` for all `draft:*` scripts.

| Script | Purpose | Output / requires |
|--------|---------|-------------------|
| `npm run draft:collect-images -- <slug>` | Fetch story pages; rank image candidates; probe quality | `{slug}-image-candidates.json` |
| `npm run draft:probe-images -- <slug>` | Re-probe quality on existing candidates (no HTML re-fetch) | Updates candidates file |
| `npm run draft:upload-images -- <slug>` | Upload **saved selections** to staging EmDash media | `{slug}-image-selections.json` → `{slug}-images-uploaded.json` |
| `npm run draft:inject-images -- <slug>` | Insert `![alt](staging-url)` after each `##` / `###` in draft markdown | `reports/drafts/<slug>.md` |
| `npm run draft:push-staging -- <slug>` [cms-slug] | Push draft to staging CMS as **Portable Text** (draft update, unpublished) | `EMDASH_STAGING_PAT`, uploads file, existing staging post |

**Image workflow (UI):** `feedback:server` → `/draft-images` → Collect → pick images → **Beyond Europe** flags → Save selections.

**Flags:**

- Collect: `--skip-probe` on `collect-roundup-image-candidates.mts` (CLI only)
- Upload: `--use-suggestions` (skip editor approval; not for publish)
- Upload: `--force` (re-upload all units; default skips already-uploaded unitIds)

**Files** (`reports/drafts/`):

- `<slug>.md` — prose draft
- `<slug>-subjects.json` — CMS subject chips (roundup: include `Europe & UK Cult News`)
- `<slug>-image-candidates.json`
- `<slug>-image-selections.json`
- `<slug>-images-uploaded.json`
- `_custom/<slug>/` — pasted images from draft-images UI

Writing guide: [WEEKLY_REPORT_WRITING_GUIDE.md](WEEKLY_REPORT_WRITING_GUIDE.md). Operator guide: [DRAFT_FROM_ARTICLE_PLAN.md](DRAFT_FROM_ARTICLE_PLAN.md). Cursor skill: `.cursor/skills/draft-from-article-plan/SKILL.md` (in monorepo today).

---

## Discovery tuning & probes

| Script | Purpose |
|--------|---------|
| `npm run probe:locale` | Test Google News locale query behaviour |
| `npm run probe:publisher-langs` | Fetch publisher homepages; optional `--apply-host-config` |
| `npm run analyze:google-news-query-plan` | Summarize `reports/google-news-query-plan-latest.json` |
| `npm run split:discovery-groups` | Split discovery query group JSON for maintenance |
| `npm run export:candidates` | Export candidate URLs from a run |

---

## Clustering & regression

| Script | Purpose |
|--------|---------|
| `npm run build:cluster-modifiers` | Build cluster modifier terms from data files |
| `npm run build:cluster-modifiers:seeds` | Seeds-only variant (`--seeds-only --strip-lang-fields`) |
| `npm run sync:cluster-regression` | Sync cluster regression fixture from live run |
| `npm run cluster:print-expectations` | Print expected clusters for integration tests |

---

## HTML / pipeline diagnostics

| Script | Purpose |
|--------|---------|
| `npm run render:rejection-review-html` | HTML view of pipeline rejections |
| `npm run replay:rejection-review-html` | Replay rejection review from log |
| `npm run backup:before-run` | Backup reports before a long run |
| `npm run recover:failed-urls` | Retry failed URL fetches from last run |

---

## Tests

| Script | Purpose |
|--------|---------|
| `npm run test:clusters` | Live cluster integration test |
| `npm run test:clusters:fixture` | Cluster test against fixture (`CLUSTER_TEST_USE_FIXTURE=1`) |
| `npm run test:digest-exclusion` | Digest exclusion rules (live) |
| `npm run test:digest-exclusion:fixture` | Digest exclusion with fixture skip live |
| `npm run test:article-extraction` | Article HTML extraction snippets |
| `npm run test:report-proper-nouns` | Proper-noun handling in reports |
| `npm run test:image-quality` | Image dimension / tier heuristics |
| `npm run e2e:smoke` | Short smoke run (`run-e2e-smoke.cmd`) |
| `npm run e2e:full` | Full pipeline dry-run (`DRY_RUN=true`) |

---

## Splitting this agent from the monorepo

When this folder becomes its own repo:

1. Copy `agents/uk-and-europe-cults-columnist/` as the repo root (keep `package.json`, `docs/`, `src/`, `scripts/`, `data/`).
2. **EmDash CLI:** `draft:upload-images` and `draft:push-staging` expect `web/` with `npx emdash` at `../../web` today — adjust `push-draft-to-staging.mts` / `upload-roundup-images.mts` paths or install `@emdash/cli` in the split repo.
3. **Cursor skill** lives at `.cursor/skills/draft-from-article-plan/` in the monorepo; copy or publish separately for editor guidance.
4. **Secrets:** `EMDASH_STAGING_PAT` remains a user/machine env var, not committed.
5. **Reports** (`reports/`) are runtime output — gitignore or use artifact storage; document backup in [WEEKLY_RUN.md](WEEKLY_RUN.md).

This file is the canonical script index for the agent package.
