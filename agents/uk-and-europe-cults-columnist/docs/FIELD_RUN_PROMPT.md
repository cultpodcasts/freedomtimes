# Field run — agent prompt

Use this file when starting a **new agent session** for a weekly (or custom) discovery → digest → review run.

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
3. Compute `DISCOVERY_MAX_AGE_HOURS` from the date range (see [Time window](#time-window)).
4. Confirm `.env` has `AGENT_ENV=staging` and `DRY_RUN=true`.
5. Do **not** commit or push unless the operator explicitly requests it.

### Goals

Run end-to-end for the operator’s time window:

| Step | Output |
|------|--------|
| Pre-flight tests | Fixture regression green |
| Discovery + pipeline | `reports/last-run-drafts.json`, `reports/drafts-archive.json`, `last-run.log` |
| Render | `reports/cult-news-latest.html`, `reports/cult-news-sources.json` |
| Live tests | `test:digest-exclusion`, `test:clusters` |
| **Automation stop point** | `reports/cult-news-latest.html` + `feedback:server` running — **operator takes over in browser** |
| Agent final report | Stats, clusters, test failures, review queue, article outline — **then print [Human handoff checklist](#human-in-the-loop-handoff-operator-responsibilities)** |

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
| 4 | **`CULT_NEWS_RENDER_MAX_AGE_HOURS`** | Default **`720`** (30 days) for multi-day review; use **`168`** only for same-day publish |
| 5 | **Discovery cap** — `--max=N` or unbounded? | Default **`50`** on first field runs; omit `--max` for full run |
| 6 | **`--concurrency`** | Default **`8`** |
| 7 | **Backup before run?** | `npm run backup:before-run` — default **yes** if overwriting a good digest |
| 8 | **Tor / SOCKS proxy** | Is Tor (or other SOCKS) running? Is `SOCKS_PROXY` set in `.env`? (e.g. `socks5://127.0.0.1:9150`) |
| 9 | **NewsData.io** | `NEWSDATA_ENABLED` true/false? (default from `.env`) |
| 10 | **Google News locale cap** | `GOOGLE_NEWS_LOCALE_IDS` empty (all locales) or restricted list? |
| 11 | **Skip live integration tests?** | Default **no** — run after render |
| 12 | **Refresh regression fixture after run?** | `npm run sync:cluster-regression` — default **only if** operator wants to update tests |
| 13 | **May agent start `feedback:server`?** | Default **yes** — operator does browser review manually |
| 14 | **Anything to exclude from this run?** | e.g. re-pipeline only, render-only, no discovery |

### Example answers (template)

```
Start:  2026-05-31 00:00 UTC
End:    2026-06-07 14:00 BST  (= 2026-06-07 13:00 UTC)
Render: CULT_NEWS_RENDER_MAX_AGE_HOURS=720
Discovery: --max=50 --concurrency=8
Backup: yes
Tor: no / yes on 9150
NewsData: false
Locales: all
Live tests: yes
Sync fixture: no
Feedback server: yes
```

---

## Time window

Convert start/end to UTC, then:

```text
DISCOVERY_MAX_AGE_HOURS = ceil(hours from start UTC to end UTC)
```

Round **up** by 1–2 hours if discovery starts noticeably after the stated end time, so the start of the window is not clipped.

**Example:** `2026-05-31 00:00 UTC` → `2026-06-07 13:00 UTC` = **181 hours** → set `DISCOVERY_MAX_AGE_HOURS=181`.

Google News RSS uses `when:Nh` derived from this value (unless `GOOGLE_NEWS_WHEN` overrides in `.env`).

**Article scope:** When drafting the weekly summary, only treat stories whose **published** timestamps fall between the operator’s start and end as in-scope for that edition (even if render window is wider).

### PowerShell env for the run

```powershell
cd c:\Users\jonbr\source\repos\freedomtimes\agents\uk-and-europe-cults-columnist

$env:DISCOVERY_MAX_AGE_HOURS = '<computed>'
$env:CULT_NEWS_RENDER_MAX_AGE_HOURS = '<from operator, default 720>'
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

### 0. Pre-flight

```powershell
npm install   # if needed
npm run test:digest-exclusion:fixture
npm run test:clusters:fixture
```

Stop if either fails unless the operator directs otherwise.

Optional (if operator said yes):

```powershell
npm run backup:before-run
```

### 1. Discovery + pipeline

```powershell
$env:DISCOVERY_MAX_AGE_HOURS = '<computed>'
npm run dev -- --max=50 --concurrency=8 *>&1 | Tee-Object -FilePath .\last-run.log
```

Adjust `--max` / `--concurrency` per operator input. Omit `--max` when unbounded.

Inspect: `reports/last-run-drafts.json`, `reports/drafts-archive.json`, `reports/pipeline-rejections-latest.json`.

### 2. Render digest

```powershell
$env:CULT_NEWS_RENDER_MAX_AGE_HOURS = '<operator value>'
npm run render:html
```

Note console exclusion counts and `[cluster]` labels.

### 3. Live regression (unless operator skipped)

```powershell
Remove-Item Env:CLUSTER_TEST_USE_FIXTURE -ErrorAction SilentlyContinue
npm run test:digest-exclusion
npm run test:clusters
```

Report failures. **Known acceptable live failure:** `konstantin-rudnev` when `europeantimes.news` is on excluded hosts.

Optional (operator opt-in):

```powershell
npm run sync:cluster-regression
```

### 4. Start feedback server — **automation stops here**

```powershell
$env:CULT_NEWS_RENDER_MAX_AGE_HOURS = '<same as render>'
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

Work through these in order. Nothing is published until you write the article separately.

#### Phase 1 — False positives (`review` status)

1. Click **Init Report** (top-right) — creates `data/feedback/active-report.json`.
2. Scroll the digest. For each card that is **not** cult news (figurative cult, wrong site, entertainment, opinion), click **False positive**.
3. Click **Close Report** when done.
   - Merges entries into `data/feedback/false-positives.json`
   - Re-renders the digest (false positives removed, clusters updated)
   - Page reloads automatically

**Prefer fixing systematic mistakes in code/config later** (`data/discovery/lang/*.json`, `data/excluded-source-hosts.json`, `data/subject-aliases.json`) — use **False positive** in the UI for this week’s blocklist and for one-offs. Log patterns in **`report-review-notes.md`** (type **A** / **B** / **C**).

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

11. **Note code follow-ups** in `report-review-notes.md` for the next weekly run (see [WEEKLY_RUN.md — Refining the code](WEEKLY_RUN.md#refining-the-code-during-the-first-few-weekly-runs)).

---

### ⛔ What the agent did *not* do

- Did not **Init Report**, mark false positives, or **Finalize** for you
- Did not publish to CMS (`DRY_RUN=true`)
- Did not commit git changes (unless you asked)

---

### 5. Final report to operator (agent)

Deliver **before** the human handoff checklist:

1. Time window used and computed hours  
2. Discovery stats (candidates, drafts, top rejections)  
3. Digest summary (clusters + counts, notable independents)  
4. Exclusion breakdown from render  
5. Test results (fixture + live)  
6. Review queue — cards/clusters to inspect first in the browser  
7. Config/test refinement suggestions (not one-off hacks)  
8. Draft article outline (subsection per cluster + “also this week”)

Then print the full **[Human-in-the-loop handoff](#human-in-the-loop-handoff-operator-responsibilities)** section above and confirm:

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
