# Weekly run: discovery → digest → review → article

Operator guide for producing a **time-bounded Cult News Digest**, reviewing it in the browser (false positives and clusters), then writing a summary article from the cleaned result.

All commands assume PowerShell and this working directory:

```powershell
cd c:\Users\jonbr\source\repos\freedomtimes\agents\uk-and-europe-cults-columnist
```

Related docs:

- [FIELD_RUN_PROMPT.md](FIELD_RUN_PROMPT.md) — **paste into a new agent session**; agent asks for date range, Tor, caps, then runs this workflow
- [README.md](../README.md) — agent purpose, discovery policy, env reference
- [SOAK_TEST_HANDOVER.md](../SOAK_TEST_HANDOVER.md) — cache reset, soak-test cadence, diagnostics
- [tests/CLUSTER_REGRESSION.md](../tests/CLUSTER_REGRESSION.md) — clustering / digest exclusion tests and issue types A/B/C
- [docs/LANGUAGE_FILES.md](LANGUAGE_FILES.md) — figurative phrases, cult terms, when to edit lang JSON
- `report-review-notes.md` (repo root of this agent) — manual notes on recurring false positives / misses (create on first review if missing)

---

## What you are building

| Stage | Output | Used for |
|-------|--------|----------|
| Discovery + pipeline | `reports/last-run-drafts.json`, `reports/drafts-archive.json`, `last-run.log` | Candidate stories that passed the cult filter |
| HTML render | `reports/cult-news-latest.html`, `reports/cult-news-sources.json` | Clustered digest for review |
| Feedback review | `data/feedback/active-report.json` → `data/feedback/false-positives.json` | Remove noise; improve clustering |
| Your article | (CMS / Freedom Times) | One section per **cluster** + picks from **Latest Stories** |

**Content extraction:** `src/articleContent.ts` isolates headline (og:title), dek (meta description), and article body from publisher chrome before classification and clustering. Re-render after code changes to pick up cleaner text.

MCP draft creation is still dry-run only (`DRY_RUN=true`). The digest + review loop is the editorial source of truth until CMS wiring is done.

---

## First field run: past week (168 hours)

Use this sequence for the **first production-style weekly run** (stories published in the last 7 days).

### Pre-flight (once per machine / after pulling code)

```powershell
npm install
# Ensure .env exists — copy from .env.example if needed
npm run test:digest-exclusion:fixture
npm run test:clusters:fixture
```

Recommended `.env` for weekly discovery + multi-day review:

```dotenv
AGENT_ENV=staging
DRY_RUN=true
DISCOVERY_MAX_AGE_HOURS=168
CULT_NEWS_RENDER_MAX_AGE_HOURS=720
```

`720` on render keeps stories visible while you review over several days; discovery still only searches the last `168` hours.

**Do not** set `CLUSTER_TEST_USE_FIXTURE=1` in `.env` — that limits cluster tests to the frozen snapshot only.

### Run the week

```powershell
npm run backup:before-run

$env:DISCOVERY_MAX_AGE_HOURS = '168'
$env:CULT_NEWS_RENDER_MAX_AGE_HOURS = '720'

npm run dev -- --max=50 --concurrency=8 *>&1 | Tee-Object -FilePath .\last-run.log

npm run render:html
npm run feedback:server
```

Open **http://localhost:3000**, **Init Report**, review, **Close Report**, fix clusters in verification, **Finalize**.

After the first digest looks reasonable:

```powershell
npm run sync:cluster-regression   # refresh tests/fixtures/cluster-stories-regression.json
npm run test:clusters
npm run test:digest-exclusion
```

Commit fixture + expectation updates when you intentionally change filtering or clustering behavior.

---

## Refining the code during the first few weekly runs

Expect to tune config and tests for **2–4 weekly cycles** before the digest is mostly clean without heavy manual layout. Use this order — **config and signals first**, human blocklist last.

### 1. Capture issues while reviewing

During feedback review, note each problem in `report-review-notes.md`:

- URL or title pattern
- **Issue type** (see below)
- Whether it should be **excluded from digest**, **clustered differently**, or **discovered but missing**

Do not jump straight to `false-positives.json` for systematic mistakes; fix the pipeline or lang files so the next render is better for everyone.

### 2. Classify the issue

| Type | Symptom | Primary fix surface |
|------|---------|---------------------|
| **A — Mis-clustering** | Wrong cluster (weak bridge, e.g. MTG vs Ahmadi raid) | Clustering logic in `render-cult-news-html.tsx`, `subject-aliases.json`, `tests/cluster-expectations.json` |
| **B — Digest false positive** | Should not appear in HTML at all (figurative cult, homograph host, entertainment) | `data/excluded-source-hosts.json`, `data/discovery/lang/*.json`, `tests/digest-exclusion-expectations.json` |
| **C — Missing cluster** | Same real-world subject, multiple languages, not grouped | `data/subject-aliases.json`, `expectedClusters` in `tests/cluster-expectations.json` |

See [tests/CLUSTER_REGRESSION.md](../tests/CLUSTER_REGRESSION.md) for the full scenario map.

### 3. Fix priority (signal-based, not article-specific)

**False positives in digest (type B)**

1. **Homograph / wrong site** — add host to `data/excluded-source-hosts.json` (e.g. `fotocult.it` photography, not cult news).
2. **Figurative “cult”** — add phrase to `figurativeCultPhrases` in the right `data/discovery/lang/<code>.json` (see [LANGUAGE_FILES.md](LANGUAGE_FILES.md)).
3. **Figurative genre language but story *is* about cults** — do **not** remove phrases like `cult thriller` globally. The pipeline keeps these via `hasSubstantiveCultSubjectMatter()` when the body has repeated cult coverage, coercive-harm terms near cult language, or news-style preposition patterns (e.g. Unchosen Netflix reviews, real cult documentaries). Add a **`mustIncludeFromDigest`** case in `tests/digest-exclusion-expectations.json` if regressions are likely.
4. **Avoid** broad context terms that suppress real coverage (e.g. do not add `netflix` / `binge` as figurative context terms — Netflix publishes cult documentaries and syndicated reviews).
5. **Media/entertainment profile** — `mediaSignals` in lang files (soap opera, radio drama, etc.), not publisher names alone.

**Missing or wrong clusters (types A / C)**

1. Add or extend **`data/subject-aliases.json`** (`matchMode: "aliasOnly"` when a generic alias appears in unrelated bodies).
2. Adjust clustering only when alias + title grounding is insufficient; keep Unchosen (fiction) **separate** from PBCC (real group news) — tests enforce this.
3. Update **`tests/cluster-expectations.json`** (`expectedClusters`, `mustNotShareCluster`, `forbiddenMegaClusters`).

**Discovery misses (story never in drafts)**

1. Check `reports/pipeline-rejections-latest.json` and classification audit on the card (if it reached render once).
2. Tune discovery via `DISCOVERY_FOCUS_JSON`, watchlist hosts, or locale caps — not hardcoded URLs in TypeScript.

### 4. Lock in with regression tests

After each code/config fix:

```powershell
npm run test:digest-exclusion:fixture    # fast — exclusion + inclusion snippets
npm run test:clusters:fixture              # fast — frozen corpus

# After changing drafts corpus or render window intentionally:
npm run sync:cluster-regression
npm run test:clusters                      # live — same story set as render:html
npm run test:digest-exclusion              # live — false positives absent from corpus
```

Add scenarios to:

- `tests/digest-exclusion-expectations.json` — `mustExcludeFromDigest` / `mustIncludeFromDigest`
- `tests/fixtures/digest-exclusion-snippets.json` — minimal snippets (no HTTP) for new cases
- `tests/cluster-expectations.json` — cluster and separation contracts

Draft new cluster expectations from current output:

```powershell
npm run cluster:print-expectations -- --write
# merge tests/cluster-expectations.draft.json into cluster-expectations.json
```

### 5. When to use `false-positives.json`

Use the feedback UI (**False positive** → **Close Report**) or manual JSON **only** for one-off edge cases after programmatic fixes are exhausted. Persistent patterns belong in lang files, excluded hosts, or subject aliases so the next weekly run starts clean.

### 6. Known live-test caveat

`npm run test:clusters` may fail on **`konstantin-rudnev`** when `europeantimes.news` is on the excluded-hosts list — one story is digest-excluded, so the pair cannot auto-cluster in the **live** corpus. The **fixture** test still passes (both stories in the snapshot). This is expected unless you remove that host from the blocklist deliberately.

---

## One-time setup

```powershell
npm install
Copy-Item .env.example .env   # if you do not already have .env
```

Required in `.env`:

```dotenv
AGENT_ENV=staging
DRY_RUN=true
DISCOVERY_MAX_AGE_HOURS=168
CULT_NEWS_RENDER_MAX_AGE_HOURS=720
```

`DISCOVERY_MAX_AGE_HOURS` is the **time window** for discovery (Google News `when:Nh`, feed freshness, etc.). Use `168` for a week, or another positive integer (e.g. `240` for ~10 days).

---

## Set the timeframe (important)

Use the **same** window for discovery and render when writing about a single week **on the day you publish**. When reviewing over several days, set a **wider render window** so Close Report does not drop older drafts:

| Variable | Role |
|----------|------|
| `DISCOVERY_MAX_AGE_HOURS` | How far back discovery searches (required for `npm run dev`) |
| `CULT_NEWS_RENDER_MAX_AGE_HOURS` | Drops stories older than this at render time (defaults to `DISCOVERY_MAX_AGE_HOURS` if unset). **Close Report re-render uses this** — use `720` (30 days) for multi-day review. |

**Weekly example (7 days, same-day render and publish):**

```powershell
$env:DISCOVERY_MAX_AGE_HOURS = '168'
$env:CULT_NEWS_RENDER_MAX_AGE_HOURS = '168'
```

**Multi-day review (recommended for first field runs):**

```powershell
$env:DISCOVERY_MAX_AGE_HOURS = '168'
$env:CULT_NEWS_RENDER_MAX_AGE_HOURS = '720'
npm run render:html
$env:CULT_NEWS_RENDER_MAX_AGE_HOURS = '720'   # same value before starting server
npm run feedback:server
```

Put `CULT_NEWS_RENDER_MAX_AGE_HOURS=720` in `.env` so `npm run render:html` and the feedback server share the same window.

**Custom window (e.g. 10 days):**

```powershell
$env:DISCOVERY_MAX_AGE_HOURS = '240'
$env:CULT_NEWS_RENDER_MAX_AGE_HOURS = '240'
```

---

## End-to-end workflow

```mermaid
flowchart LR
  A[Discovery + pipeline] --> B[Render HTML]
  B --> C[Feedback server]
  C --> D[Init report]
  D --> E[Mark false positives]
  E --> F[Close report]
  F --> G[Re-render clusters]
  G --> H[Finalize]
  H --> I[Write article from clusters]
```

### 0. Optional backup

Before overwriting a good digest:

```powershell
npm run backup:before-run
# or
npm run snapshot:html
```

### 1. Discovery and pipeline

Full run (discover URLs, fetch, classify, write drafts):

```powershell
$env:DISCOVERY_MAX_AGE_HOURS = '168'
npm run dev -- --max=50 --concurrency=8 *>&1 | Tee-Object -FilePath .\last-run.log
```

- `--max=N` — cap how many stories get pipeline approval (omit for unbounded; use a cap on first runs to control runtime).
- `--concurrency=N` — parallel fetches (default 6 from env).
- `Tee-Object` keeps a full `last-run.log` for the renderer fallback.

**Re-run pipeline only** (no new discovery; uses `reports/last-run-candidates.json`):

```powershell
npm run pipeline:only
```

**Single URL smoke test:**

```powershell
npm run dev -- --url=https://www.example.com/path/to/story *>&1 | Tee-Object -FilePath .\last-run.log
```

Check outputs:

- `reports/last-run-drafts.json` — structured drafts from the latest run
- `reports/drafts-archive.json` — rolling archive (renderer prefers this when present)
- `reports/last-run-candidates.json` — discovered URLs
- `reports/pipeline-rejections-latest.json` — why candidates failed

### 2. Render the digest

```powershell
$env:CULT_NEWS_RENDER_MAX_AGE_HOURS = '720'   # or '168' for same-day publish
npm run render:html
```

Opens logically as `reports/cult-news-latest.html`. The script:

1. Loads drafts (archive → `last-run-drafts.json` → `last-run.log`)
2. Fetches titles/descriptions/article text (HTTP cache)
3. Applies freshness filter, dedupe, figurative-cult filter (with substantive-cult override), excluded hosts
4. **Clusters** related stories and writes HTML

Console prints cluster labels, e.g. `[cluster] "Scientology" (detected) — 3 stories`, and exclusion counts by reason.

If you see `No draft stories found`, run step 1 again and confirm `reports/last-run-drafts.json` or the archive has entries.

### 3. Start the feedback server

In a **second terminal** (leave it running):

```powershell
npm run feedback:server
```

Then open **http://localhost:3000** (port override: `$env:FEEDBACK_SERVER_PORT = '3001'`).

The server serves `reports/cult-news-latest.html` and exposes the feedback API. Buttons in the page talk to `window.location.origin`, so you must use the server URL, not `file://`.

### 4. Review: false positives

1. Click **Init Report** (top-right). This creates `data/feedback/active-report.json` in `review` status.
2. For each **non-cult** card, click **False positive**. Entries are stored in the active report (with URL, title, article text, classification audit when available).
3. When finished, click **Close Report**.
   - Merges false positives into `data/feedback/false-positives.json`
   - Re-runs `render-cult-news-html.tsx` using the feedback server’s environment (`CULT_NEWS_RENDER_MAX_AGE_HOURS` — set before starting the server, e.g. `720`)
   - Reloads the page with **updated clusters** (false positives excluded)

### 5. Review: clusters (verification phase)

After close, status becomes **verification**. A cluster editor toolbar appears at the bottom of the page.

- **Rename clusters** — edit the label field in each cluster header.
- **Move stories** — use the “Move to…” dropdown on each card.
- **Wrong cluster** — moves the story to Independent (unsaved until you save).
- **New cluster** / **Dissolve cluster** — toolbar buttons.
- **Save layout & refresh** — writes `data/feedback/cluster-layout.json`, re-renders, and reloads with your layout applied on top of auto-clustering.
- When satisfied, click **Finalize** — archives the report, exports training data, and writes `reports/approved-layout.json` for the writing phase.

To start a new review cycle on the same HTML, click **Init Report** again after finalize.

### 6. Optional: compare before/after render

```powershell
npm run snapshot:html          # copies cult-news-latest.html → cult-news-snapshot.html
# ... review + close report (re-render) ...
npm run diff:html              # compares latest vs snapshot
```

### 7. Write your article

Use the **final** `reports/cult-news-latest.html` (after close report / optional second render):

| Digest section | Article use |
|----------------|-------------|
| **Cluster** blocks (label + multiple articles) | One subsection per theme, e.g. “Scientology in Germany”, “NXIVM follow-up” |
| **Latest Stories** (ungrouped / independent) | Short mentions or “also this week” bullets |
| Card links | Primary sources for attribution |
| Published dates on cards | Confirm they fall inside your `DISCOVERY_MAX_AGE_HOURS` window |
| **Copy citations** (header / per cluster / per card) | Markdown source list with publisher URL + archive mirrors for paywalled pieces |
| `reports/cult-news-sources.json` | Same citation data as JSON (`markdown` field is ready to paste) |

Practical approach:

1. List cluster headings from the console `[cluster]` lines or the HTML group headers.
2. For each cluster, click **Copy citations** on the group header (or use **Copy all source citations** in the digest header).
3. For paywalled outlets, use **Accessible copy for citing** or the `Accessible copy:` line in the pasted markdown — not the publisher URL alone.
4. Write a short narrative per cluster (what happened, who, jurisdiction UK/EU).
5. Add 1–2 sentences on notable independent stories.
6. Keep `report-review-notes.md` updated with systematic false positives to fix in code before the next weekly run.

---

## Feedback files

| File | Purpose |
|------|---------|
| `data/feedback/active-report.json` | In-progress review session (created by **Init Report**) |
| `data/feedback/false-positives.json` | Persistent blocklist; `reason: "false-positive"` excluded on render; `reason: "wrong-cluster"` detached from clusters |
| `data/feedback/cluster-layout.json` | Manual cluster overrides from verification **Save layout & refresh** |
| `data/feedback/archived/<reportId>.json` | Closed review sessions after **Finalize** |
| `data/training-data.jsonl` | One JSON line per finalized entry |
| `reports/approved-layout.json` | Final cluster layout after **Finalize** (writing phase input) |

Manual edit (emergency): add an entry to `false-positives.json`, then re-run `npm run render:html`.

---

## npm scripts (quick reference)

| Command | What it does |
|---------|----------------|
| `npm run dev` | Discovery + pipeline (env from `.env` / shell; set `DISCOVERY_MAX_AGE_HOURS` for window) |
| `npm run pipeline:only` | Pipeline only from `last-run-candidates.json` |
| `npm run render:html` | Build `reports/cult-news-latest.html` and `reports/cult-news-sources.json` |
| `npm run feedback:server` | Review UI at http://localhost:3000 |
| `npm run snapshot:html` | Backup current digest HTML |
| `npm run diff:html` | Diff latest vs snapshot digest |
| `npm run backup:before-run` | Timestamped backup of log, drafts, digest, feedback |
| `npm run sync:cluster-regression` | Snapshot enriched stories (720h window) into `tests/fixtures/cluster-stories-regression.json` |
| `npm run test:clusters` | Live regression — auto-clustering on current render corpus |
| `npm run test:clusters:fixture` | Offline regression — frozen fixture only |
| `npm run test:digest-exclusion` | Live — exclusion + inclusion checks on render corpus |
| `npm run test:digest-exclusion:fixture` | Offline — snippet/fixture checks only |
| `npm run cluster:print-expectations -- --write` | Draft `cluster-expectations.draft.json` from current clusters |

Config/data paths worth knowing:

| Path | Purpose |
|------|---------|
| `data/excluded-source-hosts.json` | Hosts never shown in digest |
| `data/subject-aliases.json` | Named groups for clustering |
| `data/discovery/lang/*.json` | Figurative phrases, cult terms, media signals |
| `tests/cluster-expectations.json` | Cluster regression contract |
| `tests/digest-exclusion-expectations.json` | Digest exclusion / inclusion contract |

---

## Troubleshooting

| Problem | What to do |
|---------|------------|
| Server shows “Report not found” | Run `npm run render:html` first |
| Feedback buttons do nothing | Open via **http://localhost:3000**, not the file path; ensure server is running |
| “Please initialize a report first” | Click **Init Report** |
| Empty digest after a long run | Check `reports/pipeline-rejections-latest.json`; try smaller `--max` first; see SOAK_TEST_HANDOVER for cache issues |
| Stories missing from window | Align `CULT_NEWS_RENDER_MAX_AGE_HOURS` with review span; check `publishedAt` on cards |
| Stale clusters after feedback | **Close Report** triggers re-render; or run `npm run render:html` manually |
| Real cult doc excluded as “figurative” | Body may need more cult-subject signal; check substantive override; add `mustIncludeFromDigest` test |
| Same subject not clustering | Add `subject-aliases.json` entry; run `test:clusters:fixture` |
| `test:clusters` fails only on Rudnev live | Expected if `europeantimes.news` is excluded — see **Known live-test caveat** above |

---

## Suggested weekly checklist

**Before discovery**

- [ ] Set `DISCOVERY_MAX_AGE_HOURS=168` (or your window) and `CULT_NEWS_RENDER_MAX_AGE_HOURS=720` for review  
- [ ] `npm run test:digest-exclusion:fixture` and `npm run test:clusters:fixture` green  
- [ ] `npm run backup:before-run` or `snapshot:html` if keeping last week’s digest  

**Discovery and review**

- [ ] `npm run dev` with `Tee-Object` → `last-run.log`  
- [ ] `npm run render:html` — note console exclusion summary and cluster labels  
- [ ] `npm run feedback:server` → **Init Report** → mark false positives → **Close Report**  
- [ ] Verification → fix clusters → **Save layout & refresh** → **Finalize**  
- [ ] Draft article from cluster headings + **Copy citations**  

**After first few weekly runs (code refinement)**

- [ ] Log patterns in `report-review-notes.md` (type A / B / C)  
- [ ] Fix via lang files / excluded hosts / subject aliases — not one-off render hacks  
- [ ] Add or update regression expectations + snippets  
- [ ] `npm run sync:cluster-regression` when corpus changed intentionally  
- [ ] `npm run test:clusters` and `npm run test:digest-exclusion` before calling the week “done”  
- [ ] Commit fixture + expectation updates with the code change  
