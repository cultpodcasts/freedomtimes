# UK and Europe Cults Columnist Soak-Test Handover

## Purpose

This runbook is for operating the current local agent over the next few days to:

- find candidate stories
- reset cached fetch state when needed
- generate the Cult News Digest HTML file from the latest dry-run output

This is an operator handover for the code as it exists now. It is not a production runbook.

## Current State

- The agent is local-only and must stay on `AGENT_ENV=staging`.
- MCP draft creation is not implemented yet.
- `DRY_RUN=true` is required for normal operation.
- The HTML digest is generated from dry-run entries written into `last-run.log`.
- If no stories pass the current cult precision filter, the HTML file is still generated but shows an empty-state message.

## Important Files

- Agent README: [agents/uk-and-europe-cults-columnist/README.md](/c:/Users/jonbr/source/repos/freedomtimes/agents/uk-and-europe-cults-columnist/README.md)
- Example env file: [agents/uk-and-europe-cults-columnist/.env.example](/c:/Users/jonbr/source/repos/freedomtimes/agents/uk-and-europe-cults-columnist/.env.example)
- Agent entrypoint: [agents/uk-and-europe-cults-columnist/src/index.ts](/c:/Users/jonbr/source/repos/freedomtimes/agents/uk-and-europe-cults-columnist/src/index.ts)
- Cache implementation: [agents/uk-and-europe-cults-columnist/src/httpCache.ts](/c:/Users/jonbr/source/repos/freedomtimes/agents/uk-and-europe-cults-columnist/src/httpCache.ts)
- HTTP cache defaults: [agents/uk-and-europe-cults-columnist/src/http-cache/config.ts](/c:/Users/jonbr/source/repos/freedomtimes/agents/uk-and-europe-cults-columnist/src/http-cache/config.ts)
- News discovery and NewsData cache logic: [agents/uk-and-europe-cults-columnist/src/discoverStories.ts](/c:/Users/jonbr/source/repos/freedomtimes/agents/uk-and-europe-cults-columnist/src/discoverStories.ts)
- Digest render script: [agents/uk-and-europe-cults-columnist/scripts/render-cult-news-html.tsx](/c:/Users/jonbr/source/repos/freedomtimes/agents/uk-and-europe-cults-columnist/scripts/render-cult-news-html.tsx)
- Digest render helpers and file paths: [agents/uk-and-europe-cults-columnist/scripts/render-cult-news-html.helpers.ts](/c:/Users/jonbr/source/repos/freedomtimes/agents/uk-and-europe-cults-columnist/scripts/render-cult-news-html.helpers.ts)
- MCP placeholder boundary: [agents/uk-and-europe-cults-columnist/src/mcpClient.ts](/c:/Users/jonbr/source/repos/freedomtimes/agents/uk-and-europe-cults-columnist/src/mcpClient.ts)
- Latest run log: [agents/uk-and-europe-cults-columnist/last-run.log](/c:/Users/jonbr/source/repos/freedomtimes/agents/uk-and-europe-cults-columnist/last-run.log)
- Generated digest: [agents/uk-and-europe-cults-columnist/reports/cult-news-latest.html](/c:/Users/jonbr/source/repos/freedomtimes/agents/uk-and-europe-cults-columnist/reports/cult-news-latest.html)

## Prerequisites

1. Use Node.js 20 or newer.
2. Work from `c:\Users\jonbr\source\repos\freedomtimes\agents\uk-and-europe-cults-columnist`.
3. Install dependencies once:

```powershell
npm install
```

4. Create a local env file if one does not already exist:

```powershell
Copy-Item .env.example .env
```

5. Keep these values in `.env` unless you are deliberately testing a specific variation:

```dotenv
AGENT_ENV=staging
DRY_RUN=true
NEWSDATA_ENABLED=false
```

## What Gets Written Where

- Discovery and pipeline output should be captured into `last-run.log`.
- The HTML digest renderer reads `last-run.log` and writes `reports/cult-news-latest.html`.
- HTTP responses are cached under `.cache/http-cache/`.
- A legacy HTTP cache file may exist at `.cache/http-cache.json`.
- If NewsData is enabled, query results are cached in `.cache/newsdata-cache.json`.

Default cache behavior in code today:

- HTTP cache enabled by default
- HTTP cache TTL: 180 minutes
- HTTP cache max entries: 5000
- HTTP fetch timeout: 15000 ms
- NewsData cache enabled by default when NewsData is in use
- NewsData cache TTL: 360 minutes

## Standard Soak-Test Loop

Run this from the agent folder.

### 1. Capture a discovery run into `last-run.log`

This is the main command to use during the soak test:

```powershell
npm run dev -- --max=10 --concurrency=8 *>&1 | Tee-Object -FilePath .\last-run.log
```

What it does:

- runs the TypeScript agent entrypoint
- processes up to 10 approved stories
- uses worker concurrency of 8
- writes the full console output to `last-run.log`

### 2. Generate the digest HTML from the latest log

```powershell
npm run render:cult-news
```

That reads `last-run.log` and writes `reports/cult-news-latest.html`.

### 3. Review the generated HTML file

Open [agents/uk-and-europe-cults-columnist/reports/cult-news-latest.html](/c:/Users/jonbr/source/repos/freedomtimes/agents/uk-and-europe-cults-columnist/reports/cult-news-latest.html) in the editor or browser.

## Recommended Soak-Test Cadence

Use this pattern for the next few days:

1. Run the discovery command several times per day.
2. Regenerate the digest after each run.
3. Keep timestamped copies of interesting logs before the next run overwrites `last-run.log`.
4. Clear caches when results look suspiciously stale or a source starts misbehaving.

Suggested archival pattern:

```powershell
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
New-Item -ItemType Directory -Force .\reports\run-logs | Out-Null
npm run dev -- --max=10 --concurrency=8 *>&1 | Tee-Object -FilePath .\last-run.log
Copy-Item .\last-run.log ".\reports\run-logs\cult-agent-$stamp.log"
npm run render:cult-news
```

## Clearing Cache

There is no dedicated cache-clear npm script in the repository right now. Clear cache manually from the agent folder when needed.

### Full cache reset

```powershell
Remove-Item -Recurse -Force .\.cache\http-cache -ErrorAction SilentlyContinue
Remove-Item -Force .\.cache\http-cache.json -ErrorAction SilentlyContinue
Remove-Item -Force .\.cache\newsdata-cache.json -ErrorAction SilentlyContinue
```

### Reset only HTTP fetch cache

```powershell
Remove-Item -Recurse -Force .\.cache\http-cache -ErrorAction SilentlyContinue
Remove-Item -Force .\.cache\http-cache.json -ErrorAction SilentlyContinue
```

### Reset only NewsData cache

```powershell
Remove-Item -Force .\.cache\newsdata-cache.json -ErrorAction SilentlyContinue
```

Use a cache reset when:

- feed content looks frozen across multiple runs
- a previously failing source becomes reachable again
- you change environment values related to cache or freshness
- you want a cleaner comparison between runs

## Useful Variants

### Process fewer stories quickly

```powershell
npm run dev -- --max=5 --concurrency=4 *>&1 | Tee-Object -FilePath .\last-run.log
```

### Test one explicit article URL

```powershell
npm run dev -- --url=https://www.bbc.com/news/example *>&1 | Tee-Object -FilePath .\last-run.log
```

### Disable HTTP cache for one run

```powershell
$env:HTTP_CACHE_ENABLED = "false"
npm run dev -- --max=10 --concurrency=8 *>&1 | Tee-Object -FilePath .\last-run.log
Remove-Item Env:HTTP_CACHE_ENABLED
```

### Use NewsData intentionally

Only do this if you mean to spend API credits.

```powershell
$env:NEWSDATA_ENABLED = "true"
$env:NEWSIO_API_KEY = "<your-key>"
npm run dev -- --max=10 --concurrency=8 *>&1 | Tee-Object -FilePath .\last-run.log
Remove-Item Env:NEWSDATA_ENABLED
Remove-Item Env:NEWSIO_API_KEY
```

## What to Look For During Soak Testing

Check the log for these sections on every run:

- `[agent][progress]` discovery start, running, and complete markers
- `[agent] discovered candidate stories`
- `[agent][progress]` pipeline processing markers
- `[agent] draft (dry-run)` entries
- `[agent] run summary`

Signals worth noting:

- candidate pool size unexpectedly collapsing
- repeated 403s or fetch failures from the same publisher
- no dry-run draft entries being emitted for several consecutive runs
- digest HTML staying empty across multiple cache-cleared runs
- sharp changes in accepted, rejected, or errored counts

## Known Limitation Right Now

- `DRY_RUN=false` is not usable yet because the MCP boundary still throws `MCP integration is not implemented yet. Run in DRY_RUN=true mode.`
- The digest renderer only builds cards from dry-run draft entries found in `last-run.log`.
- If the latest run contains no dry-run draft entries, the generated HTML will show an empty state.

## Validation Done While Preparing This Handover

I validated the current render command from the agent folder:

```powershell
npm run render:cult-news
```

Current observed result:

- the command completed successfully
- it wrote `reports/cult-news-latest.html`
- the current `last-run.log` produced `0` stories, which means the renderer is working but the latest captured run did not contain draft entries that survived into the digest

## Minimal Daily Checklist

1. Run discovery into `last-run.log`.
2. Regenerate the digest HTML.
3. Review acceptance, rejection, and error counts.
4. Archive notable logs.
5. Clear cache if results appear stale or suspicious.
6. Record recurring failures by publisher or feed.