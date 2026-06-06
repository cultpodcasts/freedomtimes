# Cluster regression tests

Tests prove **auto-clustering on your real digest corpus** stays correct as you change clustering logic or the feedback UI.

## What is tested

`npm run test:clusters` runs `loadEnrichedStoriesForClustering()` then `classifyStories()` — the same enriched story set and auto-clustering `render:html` uses **before** manual `cluster-layout.json` overrides. It does **not** apply layout overrides from the feedback UI.

For a fast offline check against a frozen snapshot only: `npm run test:clusters:fixture` (or `CLUSTER_TEST_USE_FIXTURE=1`).

## Workflow

### 1. Refresh the regression corpus

After discovery/pipeline (or when drafts change):

```powershell
# .env should have CULT_NEWS_RENDER_MAX_AGE_HOURS=720
npm run sync:cluster-regression
```

This fetches article text via the HTTP cache (same path as render). Run `npm run render:html` first if the cache is cold.

Commit `tests/fixtures/cluster-stories-regression.json` when the corpus changes intentionally.

### 2. Maintain expectations

`tests/cluster-expectations.json` is the contract:

- **`expectedClusters`** — stories that must appear together with a sensible label
- **`mustNotShareCluster`** — pairs that must not be merged (e.g. Unchosen vs PBCC)
- **`forbiddenMegaClusters`** — bad labels that must not absorb known stories (e.g. `England` mega-cluster)
- **`forbiddenClusterLabels`** — labels that must never appear (e.g. `Detected Cluster`, geo junk)
- **`forbiddenStoryTitlePatterns`** — fetch-quality gates (e.g. Cloudflare `Attention Required`, `Just a moment…`, `Access Denied`)
- **`mustStayIndependent`** — figurative/non-story items that must not cluster
- **`mustBeClustered`** — stories that must land in a named detected cluster (not Latest Stories)

Draft from current auto output:

```powershell
npm run cluster:print-expectations -- --write
# review tests/cluster-expectations.draft.json, then merge into cluster-expectations.json
```

### 3. Run tests

```powershell
npm run test:clusters
```

Debug graph:

```powershell
$env:CLUSTER_TEST_DEBUG = "1"
npm run test:clusters
```

## End-to-end review workflow (human)

1. `npm run render:html` → digest at 720h
2. `npm run feedback:server` → mark false positives → Close Report
3. Verification phase → fix clusters in UI → Save layout & refresh
4. `npm run test:clusters` → clustering code changes must still pass
5. Finalize → `reports/approved-layout.json` for writing phase

Manual layout fixes are **not** replayed in cluster tests. If you accept a manual layout as the new baseline for auto-clustering, update expectations or fix the algorithm so tests pass without layout.
