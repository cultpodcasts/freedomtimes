# Field run — agent prompt (in-the-field production)

Use this file when starting a **new agent session** for an **in-the-field weekly report** — discover, render, hand off for human review, produce the edition.

**Not for development:** if the operator is iterating on cluster logic, lang files, or regression tests over multiple days, use **development mode** in [WEEKLY_RUN.md](WEEKLY_RUN.md) instead (`DISCOVERY_MAX_AGE_HOURS` = editorial span, **`CULT_NEWS_RENDER_MAX_AGE_HOURS=720`**).

**How to invoke (operator says):**

> Follow `agents/uk-and-europe-cults-columnist/docs/FIELD_RUN_PROMPT.md`

The agent must read this file and **`docs/WEEKLY_RUN.md`**, then **ask for every item in [Operator inputs](#operator-inputs-ask-before-running)** before running discovery.

---

## Agent instructions

You are operating the **UK and Europe Cults Columnist** agent:

```
c:\Users\jonbr\source\repos\freedomtimes\agents\uk-and-europe-cults-columnist
```

### Before any commands

1. Read [WEEKLY_RUN.md](WEEKLY_RUN.md) for the full operator runbook.
2. Collect all [operator inputs](#operator-inputs-ask-before-running) — use `AskQuestion` or plain questions if a value is missing.
3. Compute `EDITORIAL_HOURS` from the date range; set **both** env vars to that value (see [Time window](#time-window)).
4. Confirm `.env` has `AGENT_ENV=staging` and `DRY_RUN=true`.
5. Do **not** commit or push unless the operator explicitly requests it.
6. Do **not** change clustering code, lang files, regression tests, or run `sync:cluster-regression` — this is a **production report run**, not cluster iteration.

### Goals

Run end-to-end for the operator’s time window:

| Step | Output |
|------|--------|
| Optional pre-flight | Fixture regression green (skip if operator is in a hurry) |
| Discovery + pipeline | `reports/last-run-drafts.json`, `reports/drafts-archive.json`, `last-run.log` |
| Render | `reports/cult-news-latest.html`, `reports/cult-news-sources.json` |
| **Automation stop point** | HTML + `feedback:server` running — **operator takes over in browser** |
| Agent final report | Stats, clusters, review queue, article outline + **[Human handoff checklist](#human-in-the-loop-handoff-operator-responsibilities)** |

**Out of scope for this prompt:** live integration tests (unless operator asks), `sync:cluster-regression`, clustering/lang-file fixes, fixture commits.

### Constraints

- No article-specific hardcoding in render code; use config (`data/discovery/lang/*.json`, `data/excluded-source-hosts.json`, `data/subject-aliases.json`).
- `false-positives.json` only after programmatic fixes are exhausted.
- Unchosen (Netflix fiction) and PBCC (real group news) must stay **separate clusters**.
- Figurative genre language (“cult thriller”) about cult subject matter should **remain in digest** (`hasSubstantiveCultSubjectMatter()`).
- Do **not** set `CLUSTER_TEST_USE_FIXTURE=1` for live integration tests.

---

## Operator inputs (ask before running)

Ask for each item. Record answers in your session summary before step 1.

| # | Question | Notes |
|---|----------|--------|
| 1 | **Coverage start** (date + time + timezone) | Editorial lower bound, e.g. `2026-05-31 00:00 UTC` |
| 2 | **Coverage end** (date + time + timezone) | Editorial upper bound, e.g. `2026-06-07 14:00 BST` |
| 3 | **Run “now” time** (if end is “now”) | Used to compute hours; default = time when discovery starts |
| 4 | **`EDITORIAL_HOURS`** | Compute from Q1–Q3. Set **`DISCOVERY_MAX_AGE_HOURS`** and **`CULT_NEWS_RENDER_MAX_AGE_HOURS`** to **the same value**. In-the-field: **do not use 720**. |
| 5 | **Discovery cap** — `--max=N` or unbounded? | Default **`50`**; omit `--max` for full run |
| 6 | **`--concurrency`** | Default **`8`** |
| 7 | **Backup before run?** | Default **yes** if overwriting a good digest |
| 8 | **Tor / SOCKS proxy** | Is Tor running? Is `SOCKS_PROXY` set in `.env`? |
| 9 | **NewsData.io** | `NEWSDATA_ENABLED` true/false? |
| 10 | **Google News locale cap** | `GOOGLE_NEWS_LOCALE_IDS` empty or restricted? |
| 11 | **Run fixture tests first?** | Default **optional** for field runs |
| 12 | **Run live integration tests after render?** | Default **no** — production run, not regression iteration |
| 13 | **May agent start `feedback:server`?** | Default **yes** |
| 14 | **Anything to exclude?** | e.g. render-only, re-pipeline only |

### Example answers (template)

```
Start:  2026-05-31 00:00 UTC
End:    2026-06-07 14:00 BST  (= 2026-06-07 13:00 UTC)
Hours:  181  (same for DISCOVERY_MAX_AGE_HOURS AND CULT_NEWS_RENDER_MAX_AGE_HOURS)
Mode:   in-the-field production (not dev / cluster iteration)
Discovery: --max=50 --concurrency=8
Backup: yes
Tor: no
NewsData: false
Fixture tests: skip
Live tests: skip
Feedback server: yes
```

---

## Time window

Convert start/end to UTC, then:

```text
DISCOVERY_MAX_AGE_HOURS = ceil(hours from start UTC to end UTC)
```

Round **up** by 1–2 hours if discovery starts noticeably after the stated end time, so the start of the window is not clipped.

**Example:** `2026-05-31 00:00 UTC` → `2026-06-07 13:00 UTC` = **181 hours**.

Google News RSS uses `when:Nh` derived from `DISCOVERY_MAX_AGE_HOURS` (unless `GOOGLE_NEWS_WHEN` overrides in `.env`).

### In-the-field: one clock (this prompt)

Both variables = **`EDITORIAL_HOURS`**. Complete discovery → render → browser review in one pass. Human work is **editorial** (false positives, layout, article) — not cluster-engineering.

```text
DISCOVERY_MAX_AGE_HOURS = EDITORIAL_HOURS
CULT_NEWS_RENDER_MAX_AGE_HOURS = EDITORIAL_HOURS
```

### Development mode (not this prompt)

When iterating on cluster logic pre-field, use **`CULT_NEWS_RENDER_MAX_AGE_HOURS=720`** so drafts that age day-by-day stay in the digest while you re-render and fix code. See [WEEKLY_RUN.md — Two modes](WEEKLY_RUN.md#two-modes-development-vs-in-the-field).

**Article scope:** When writing, only cite stories whose **published** dates fall between the operator’s start and end.

### PowerShell env for the run

```powershell
cd c:\Users\jonbr\source\repos\freedomtimes\agents\uk-and-europe-cults-columnist

$HOURS = '<computed>'   # e.g. 181
$env:DISCOVERY_MAX_AGE_HOURS = $HOURS
$env:CULT_NEWS_RENDER_MAX_AGE_HOURS = $HOURS
```

---

## Tor / SOCKS check

If `.env` contains `SOCKS_PROXY` or the operator said Tor is required:

1. Confirm the proxy URL (Tor Browser **9150**, Tor daemon **9050**).
2. Verify the proxy accepts connections before a long discovery run (e.g. brief curl/fetch test or check Tor Browser is open).
3. If Tor is expected but not running, **stop and tell the operator** — do not burn a long failed discovery.

If no SOCKS proxy: ensure fetches use direct HTTP (default).

See [SOAK_TEST_HANDOVER.md](../SOAK_TEST_HANDOVER.md) for cache reset if fetches fail repeatedly.

---

## Execution steps

### 0. Pre-flight (optional)

Skip unless the operator asked for fixture tests.

```powershell
npm run test:digest-exclusion:fixture
npm run test:clusters:fixture
```

Optional backup:

```powershell
npm run backup:before-run
```

### 1. Discovery + pipeline

```powershell
$env:DISCOVERY_MAX_AGE_HOURS = '<computed>'
$env:CULT_NEWS_RENDER_MAX_AGE_HOURS = '<same as discovery>'
npm run dev -- --max=50 --concurrency=8 *>&1 | Tee-Object -FilePath .\last-run.log
```

Adjust `--max` / `--concurrency` per operator input. Omit `--max` when unbounded.

Inspect: `reports/last-run-drafts.json`, `reports/drafts-archive.json`, `reports/pipeline-rejections-latest.json`.

### 2. Render digest

```powershell
$env:CULT_NEWS_RENDER_MAX_AGE_HOURS = '<same as discovery>'
npm run render:html
```

Note console exclusion counts and `[cluster]` labels.

### 3. Start feedback server — **automation stops here**

```powershell
$env:CULT_NEWS_RENDER_MAX_AGE_HOURS = '<same as discovery>'
npm run feedback:server
```

Leave this terminal **running**. The agent’s automated work is **done** after the server is up and the [human handoff checklist](#human-in-the-loop-handoff-operator-responsibilities) has been delivered.

Agent does **not** drive the browser unless the operator explicitly asks and browser tools are available.

---

## Human-in-the-loop handoff (operator responsibilities)

**The agent must print this section in full at the end of every field run** (after discovery, render, and tests). Do not skip it.

---

### ✅ Automated work complete

You now have:

| Deliverable | Location |
|-------------|----------|
| Digest HTML | `reports/cult-news-latest.html` |
| Source citations (JSON) | `reports/cult-news-sources.json` |
| Review UI | **http://localhost:3000** (feedback server must stay running) |

Open the digest via the **server URL**, not `file://` — feedback buttons only work on localhost.

---

### 👤 Your responsibilities (browser review)

Work through these in order. This is **editorial** review (curate the digest, write the article) — **not** cluster-logic engineering. Note patterns in `report-review-notes.md` for a **later** development session if needed; do not change code during this run.

#### Phase 1 — False positives (`review` status)

1. Click **Init Report** (top-right) — creates `data/feedback/active-report.json`.
2. Scroll the digest. For each card that is **not** cult news (figurative cult, wrong site, entertainment, opinion), click **False positive**.
3. Click **Close Report** when done.
   - Merges entries into `data/feedback/false-positives.json`
   - Re-renders the digest (false positives removed, clusters updated)
   - Page reloads automatically

**Prefer fixing systematic mistakes in a later dev session** (`data/discovery/lang/*.json`, excluded hosts, subject aliases, clustering code) — use **False positive** in the UI for this week’s blocklist. Log patterns in **`report-review-notes.md`** for dev mode later.

#### Phase 2 — Clusters (`verification` status)

After Close Report, the cluster editor toolbar appears.

4. **Rename** cluster labels where auto-labels are wrong or vague.
5. **Move** misplaced stories (dropdown on each card) or mark **Wrong cluster** → Independent.
6. **New cluster** / **Dissolve cluster** as needed.
7. Click **Save layout & refresh** — writes `data/feedback/cluster-layout.json` and re-renders with your layout.
8. Repeat 4–7 until clusters match how you will write the article.

Check especially: real group news **not** merged with fiction (e.g. PBCC vs Unchosen); shared subjects grouped across languages.

#### Phase 3 — Lock for writing

9. Click **Finalize** when the digest is stable.
   - Archives the session under `data/feedback/archived/`
   - Writes `reports/approved-layout.json` for the writing phase
   - Exports training lines to `data/training-data.jsonl`

10. **Write the weekly article** (CMS / Freedom Times):
    - One subsection per **cluster** heading
    - Short mentions from **Latest Stories**
    - Use **Copy citations** / `reports/cult-news-sources.json` for sources
    - Only cite stories whose **published dates** fall inside your agreed coverage window

11. **Note code follow-ups** in `report-review-notes.md` for a **future development session** — do not fix clustering in this field run.

---

### ⛔ What the agent did *not* do

- Did not iterate on cluster logic, lang files, or regression tests  
- Did not run `sync:cluster-regression` or live integration tests (unless operator asked)  
- Did not **Init Report**, mark false positives, or **Finalize** for you  
- Did not publish to CMS (`DRY_RUN=true`)  
- Did not commit git changes (unless you asked)

---

### 5. Final report to operator (agent)

Deliver **before** the human handoff checklist:

1. Time window used (`EDITORIAL_HOURS` on both env vars)  
2. Discovery stats (candidates, drafts, top rejections)  
3. Digest summary (clusters + counts, notable independents)  
4. Exclusion breakdown from render  
5. Review queue — cards/clusters to inspect first in the browser  
6. Draft article outline (subsection per cluster + “also this week”)

Do **not** include regression-test failure analysis unless the operator ran live tests.

Then print the full **[Human-in-the-loop handoff](#human-in-the-loop-handoff-operator-responsibilities)** and confirm:

- Feedback server URL and that the terminal is still running  
- Path to `reports/cult-news-latest.html`  
- Reminder: **your turn** — Init Report → Close Report → Save layout → Finalize → write article

---

## Related docs

| File | Purpose |
|------|---------|
| [WEEKLY_RUN.md](WEEKLY_RUN.md) | Full weekly operator runbook |
| [CLUSTER_REGRESSION.md](../tests/CLUSTER_REGRESSION.md) | Issue types A/B/C, test commands |
| [LANGUAGE_FILES.md](LANGUAGE_FILES.md) | Tuning figurative / cult signals |
| [README.md](../README.md) | Discovery policy, env reference |
| [SOAK_TEST_HANDOVER.md](../SOAK_TEST_HANDOVER.md) | Cache, soak diagnostics |
