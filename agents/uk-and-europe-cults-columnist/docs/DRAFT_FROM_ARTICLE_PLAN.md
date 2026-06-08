# Draft from article plan

Operator guide for the agent skill at [`.cursor/skills/draft-from-article-plan/SKILL.md`](../../.cursor/skills/draft-from-article-plan/SKILL.md).

## When to use

After **article planning** is finalized (`/articles` → Finalize plan → `reports/article-plan.json`).

## Roundup structure

- **No intro paragraph** — first `##` is the first story.
- **Image per section** — `![alt](staging-media-url)` immediately after each `##` / `###` heading.
- **Beyond Europe** — last section before citations for stories reported in Europe but occurring outside UK/EU.

## Tone (summary)

Freedom Times tells **survivors’ stories** with sympathy and rigour. Speaking out is **brave** and helps others leave — especially **adult-children** raised in high-control groups. Acknowledge **moral and epistemic injury** where relevant. Explain cult **psychology** plainly; cite **experts**. Advocate for **coercive-control legislation** as a survivor-justice issue. Full guidance: skill § Editorial tone and voice.

## Citation format (from staging)

Pulled from live staging posts via EmDash CLI/MCP.

**Standard:**

```
Publisher (Country): ["Headline"](url), D Mon YYYY.
```

**Examples (Treogan post):**

```
Radio France / France Bleu — ICI Breizh Izel (France): ["On est sous le choc : dans les Côtes-d'Armor, le maire de Tréogan en garde à vue pour des soupçons de viols"](https://www.radiofrance.fr/francebleu/podcasts/l-info-d-ici-ici-breizh-izel/on-est-sous-le-choc-dans-les-cotes-d-armor-le-maire-de-treogan-en-garde-a-vue-pour-des-soupcons-de-viols-1461062), 1 May 2026.

Le Figaro / AFP (France): ["Il aurait exigé de certaines femmes une « dévotion totale » : soupçonné de dérives sectaires, un maire des Côtes-d'Armor placé en détention provisoire"](https://www.lefigaro.fr/actualite-france/il-aurait-exige-de-certaines-femmes-une-devotion-totale-soupconne-de-derives-sectaires-un-maire-des-cotes-d-armor-place-en-detention-provisoire-20260430), 30 Apr 2026.
```

**Roundup (Ahmadi Crewe post):**

```
BBC News: ["Nine held in religious group modern slavery raid"](https://www.bbc.co.uk/news/articles/c759n2lnxz0o), 29 Apr 2026.

The Guardian: ["Crewe religious group raided by police investigating allegations of serious sexual offences"](https://www.theguardian.com/uk-news/2026/apr/29/crewe-police-raid-ahmadi-religion-peace-light), 29 Apr 2026.
```

### YouTube (different from print)

```
Channel Name (YouTube): ["Video title"](https://www.youtube.com/watch?v=…), D Mon YYYY [duration].
```

- Use **channel title**, not `youtube.com`
- Suffix `(YouTube)` — no country
- **Duration required** after date: `[22:07]`, `[30:08]`, `[01:14:11]`
- Group after news/official sources; treat as Tier C in body unless summarising commentary with attribution

Examples (Norway JW post):

```
Lloyd Evans (YouTube): ["Jehovah's Witnesses have won in Norway"](https://www.youtube.com/watch?v=AyJfaGJtCAo), 30 Apr 2026 [22:07].

JW Thoughts (YouTube): ["The Norway Decision is Awful!"](https://www.youtube.com/watch?v=oYT75rEk2tw), 30 Apr 2026 [30:08].
```

Broadcast on publisher site (not YouTube) — duration but no `(YouTube)`:

```
Channel 4 News: ["Police raid religious group…"](https://www.channel4.com/news/...), 29 Apr 2026 [02:14].
```

## Paywalled sources

- Always label: `The Times (UK, paywalled):` — never drop the paywalled marker.
- **archive.ph** or **web.archive.org** snapshot URLs are OK as the citation link when they **exist and load** (verify with fetch/browser before publishing).
- Do **not** use template URLs (`archive.ph/newest/…`, `web.archive.org/web/*/…`).
- Prefer `contentMirrorUrl` from the story payload when the pipeline already fetched via archive.
- No working mirror → publisher URL + paywalled label only.

```
The Times (UK, paywalled): ["Headline"](https://archive.ph/Ab3CdE), 8 June 2026.
```

## Slugs

| Article type | Pattern | Example |
|--------------|---------|---------|
| Roundup | `weekly-summary-{d}-{month}-{yyyy}` | `weekly-summary-8-june-2026` |
| Standalone | `{seo-keywords}-{dd-mm-yyyy}` | `breton-mayor-treogan-sect-investigation-29-04-2026` |

**Geography:** UK/Europe events in main body. Reported in Europe but occurring outside → `## Beyond Europe` section at bottom (before citations), same article.

Roundup date: spelled-out month, no zero-padded day. Standalone: SEO terms first, numeric `dd-mm-yyyy` suffix. Draft file matches slug: `reports/drafts/<slug>.md`.

## Source tiers

| Tier | List | Body voice |
|------|------|------------|
| A | `watchlist-sites.json` | Direct reporting |
| B | `allowed-source-hosts.json` | Direct, clear attribution |
| C | Other | “*Outlet* reported…”, “According to…” |

## Files

| Path | Role |
|------|------|
| `reports/article-plan.json` | What to write (finalized) |
| `reports/review-report-latest.json` | Full story text + signals |
| `reports/drafts/<slug>.md` | Agent output for review |

## Auth

```powershell
$env:EMDASH_STAGING_PAT = [Environment]::GetEnvironmentVariable('EMDASH_STAGING_PAT', 'User')
cd web
npx emdash content get posts breton-mayor-treogan-investigation-review --published -u https://staging.freedomtimes.news -t $env:EMDASH_STAGING_PAT --json
```
