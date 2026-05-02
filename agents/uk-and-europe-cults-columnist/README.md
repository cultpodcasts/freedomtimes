# UK and Europe Cults Columnist Agent

## Purpose
This local agent discovers cult-related stories from reliable UK/EU news sources and drafts CMS-ready daily summary posts.

## Current Operating Constraints
- Run locally only.
- Integrate with CMS through MCP only.
- Use Staging environment only until approved for wider rollout.
- Do not publish automatically; create drafts for editorial review.

## Source Quality Requirement
The agent must source stories from reliable online sources.

## Discovery Responsibility
- Story discovery is a primary responsibility, not an optional step.
- By default, the agent scans a curated set of reliable RSS/Atom feeds and extracts candidate URLs.
- BBC coverage now includes relevant section feeds (UK, Politics, England, Scotland, Wales, Northern Ireland, Europe, World, Business) in addition to the main BBC News feed.
- Sky News coverage includes static RSS feeds (Home, UK, World, Business, Politics, Technology).
- Feedspot UK news feeds are captured as a static snapshot in code (not fetched at runtime).
- Satire and mixed-quality feeds from that snapshot are explicitly excluded from the curated list.
- Known stale feed endpoints are removed from the curated list to avoid repeated 404 fetches.
- The agent ingests CultNews (`https://cultnews.net/feed/`, `https://cultnews.net/feed/atom`) via explicit feed entries.
- The agent ingests CultNews101 (`https://www.cultnews101.com/feeds/posts/default`, `https://www.cultnews101.com/feeds/posts/default?alt=rss`) via explicit feed entries.
- The agent also uses Google News RSS search queries for UK/EU cult-story discovery.
- Google News discovery includes site-scoped watchlist queries for The Times, Telegraph, Guardian/Observer, Daily Record, Daily Mail, The Sun, and Mirror.
- Optional: the agent can also use NewsData.io for structured country-filtered discovery when `NEWSDATA_ENABLED=true`.
- NewsData.io expects `NEWSIO_API_KEY` in environment and supports optional `NEWSIO_MAX_CREDITS_PER_RUN` to cap credit spend per run.
- If your NewsData plan is delayed by 12 hours, treat NewsData as a backfill source rather than a breaking-news source.
- Candidate URLs are filtered for cult-topic and UK/EU signals before drafting.

### Reliable Source Policy (initial)
- Prefer established national and regional publishers with editorial standards.
- Prefer primary reporting over reposted or anonymous aggregation.
- Require a reachable source URL and publication date.
- Reject sources that fail basic credibility checks.
- Store source attribution in every draft (URL, publisher, retrieved timestamp).

## Minimum Draft Output
Each generated draft should include:
- Title
- Dek/standfirst
- Summary body
- Source attribution
- Region metadata (UK or Europe)
- Suggested tags
- Confidence and review notes

## Next Build Steps
1. Define input/output JSON schemas.
2. Implement ingestion and source credibility checks.
3. Implement UK/Europe and cult-topic relevance filtering.
4. Implement summarization and CMS draft creation via MCP.
5. Add run logs and rejection reasons for QA.

## Initial Scaffold Implemented
- TypeScript local CLI runner in `src/index.ts`.
- Feed-based story discovery in `src/discoverStories.ts`.
- Source reliability checks with allowlisted publishers in `src/sourceReliability.ts`.
- UK/Europe + cult relevance filtering in `src/relevance.ts`.
- End-to-end pipeline and draft payload generation in `src/pipeline.ts`.
- MCP boundary stub in `src/mcpClient.ts` (dry-run mode only for now).

## Quick Start
1. From this folder, install dependencies:
	- `npm install`
2. Copy environment template:
	- copy `.env.example` to `.env`
3. Set required run input:
	- `DISCOVERY_MAX_AGE_HOURS=168` for weekly runs
4. Run discovery-first dry-run (default behavior):
	- `npm run dev`
5. Optionally process one explicit URL:
	- `npm run dev -- --url=https://www.bbc.com/news/example`
6. Optionally limit discovery candidate count:
	- `npm run dev -- --max=5`

The current starter prints either:
- a rejection with reasons, or
- a CMS-ready draft payload (dry-run, no write).

## Safety Guardrails in Code
- `AGENT_ENV` must be `staging` or the agent exits.
- `DRY_RUN=true` by default.
- Source reliability threshold must pass before drafting.
- No auto-publish path exists.

## Runtime Focus Parameters (No Story Hardcoding)
- Keep weekly story focus out of source code; pass it as runtime input.
- `DISCOVERY_MAX_AGE_HOURS` is required runtime input (set `168` for weekly runs).
- Google News discovery runs **generic** queries (no `site:`) against **every** configured European locale (`gl` / `hl` / `ceid`). **Watchlist `site:`** queries use only locales appropriate to that host (country TLD inference plus overrides in `data/google-news-publisher-site-locales.json`; listed wire/international hosts still use the full grid). If **every** edition for that host is German (`hl` de), French (`hl` fr), or Italian (`hl` it), the watchlist uses **one** query per site: `(deAtChTerms OR …) (deEuropeCountryOr OR …)`, the French groups, or `(itTerms OR …) (itEuropeCountryOr OR …)`, instead of many English `cult "<country>"` rows.
- Each locale search **ANDs** the discovery query with a short OR-group of keywords: English **cult** everywhere, plus **secte** (and similar) for French editions, **sect** / **sekt** where those are the natural words, **Sekte** for German, and other local equivalents as appropriate for that `hl`.
- Each search also appends a Google News **`when:`** time qualifier inside `q=` (unless disabled), derived as **`when:Nh`** from **`DISCOVERY_MAX_AGE_HOURS`** (e.g. `168` → `when:168h`) so the RSS window matches the freshness rule; override with **`GOOGLE_NEWS_WHEN`** (e.g. `when:7d`) or disable with `off` / `none`.
- European Google News editions, per-locale cult keyword rules, per-publisher `site:` locale rules, and per-language cluster-expansion stopword lists (`base` plus `en`, `de`, `fr`, …) live in `data/google-news-europe-locales.json`, `data/google-news-locale-cult-keywords.json`, `data/google-news-publisher-site-locales.json`, and `data/cluster-token-stopwords.json` (editable without changing TypeScript). Headline language uses `story.sourceLanguage` when set, otherwise `tinyld` on the title, with fallback to English.
- Optional: `GOOGLE_NEWS_LOCALE_IDS` (comma-separated ids such as `FR-fr,DE-de`) to restrict locales for faster runs; optional `GOOGLE_NEWS_TOTAL_CAP` to bound total RSS discoveries per run.
- Use either `DISCOVERY_FOCUS_JSON` (inline JSON) or `DISCOVERY_FOCUS_FILE` (path to JSON file).
- Focus input can extend discovery and ranking terms without changing code:
  - `focusSignalTerms`
  - `googleNewsGenericQueries`
  - `newsdataQueries`
  - `regionTerms`
  - `regionalHostSuffixes`
  - `priorityWatchlistHosts`
  - `googleNewsWatchlistSites`
- This keeps the agent reusable for future week-ending stories while still allowing focused runs.

## Backlog Notes
- Improve source reliability scoring to better distinguish established reporting from low-credibility and agenda-driven sources.
- Add explicit detection and risk flags for potentially ideological/partisan blogs (including right-wing aligned sources) so they are downgraded or routed for stricter editorial review.
