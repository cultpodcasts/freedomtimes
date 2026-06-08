---
name: draft-from-article-plan
description: >-
  Draft Freedom Times cult-news posts from reports/article-plan.json for editorial
  review and staging EmDash CMS. Use when article planning is finalized and the
  user wants roundup or standalone articles written from the review report corpus.
---

# Draft from article plan

Turn a finalized `reports/article-plan.json` into a **staging CMS post** ready for human editorial approval.

Reference posts on staging (pull via EmDash MCP `content_get`):

| Slug | Use for |
|------|---------|
| `breton-mayor-treogan-investigation-review` | Single-story structure, French legal context, citation line format with country |
| `ahmadi-religion-of-peace-and-light-crewe-raids-roundup-30-apr-2026` | Multi-source roundup, broadcast embeds, mixed publisher tiers |

Staging MCP: `https://staging.freedomtimes.news/_emdash/api/mcp`  
Token: `EMDASH_STAGING_PAT` (user env var).

---

## Prerequisites

1. **Finalized plan** exists: `agents/uk-and-europe-cults-columnist/reports/article-plan.json`
   - Produced by `/articles` UI → Finalize plan
   - API: `GET /api/article-plan/result`
2. **Review corpus** still matches: `reports/review-report-latest.json` (same `reviewReportId` as plan)
3. **EmDash auth** works:
   ```powershell
   $env:EMDASH_STAGING_PAT = [Environment]::GetEnvironmentVariable('EMDASH_STAGING_PAT', 'User')
   cd web
   npx emdash content list posts -u https://staging.freedomtimes.news -t $env:EMDASH_STAGING_PAT --json
   ```
4. Load user PAT in agent shells (process env may be stale):
   ```powershell
   $env:EMDASH_STAGING_PAT = [Environment]::GetEnvironmentVariable('EMDASH_STAGING_PAT', 'User')
   ```

---

## Inputs

Read `reports/article-plan.json`. For each entry in `articles` where `type` is `standalone` or `roundup` (skip `skip`):

| Field | Use |
|-------|-----|
| `title` | Post title (may refine for CMS) |
| `type` | `roundup` = one narrative covering all `stories`; `standalone` = dedicated piece |
| `unitIds` | **Processing order** — address stories in this sequence |
| `stories[]` | Full payload: `title`, `url`, `host`, `publishedAt`, `description`, `articleText`, `signals`, `sourceCitationMarkdown`, `unitLabel` |

Cluster units arrive with multiple stories sharing `unitLabel`. Independent units have one story each.

---

## Workflow

1. **Load plan** — confirm `articleCount`, list articles to draft.
2. **For each article** (in plan order):
   1. Walk `unitIds` in order; for each unit, process its stories (cluster: all URLs in unit; story: single URL).
   2. Draft markdown (see structure below).
   3. Write draft to `agents/uk-and-europe-cults-columnist/reports/drafts/<slug>.md`.
   4. Human review.
   5. Create/update staging post via EmDash MCP (`content_create` / `content_update`, then `content_publish`).
3. **Do not publish to production** unless explicitly asked.

---

## Source reliability tiers

Use host lists in the agent package:

- **Tier A — report as fact** (watchlist): `agents/uk-and-europe-cults-columnist/watchlist-sites.json`
  - Major UK/EU broadcasters, newspapers, wires (BBC, Guardian, Le Monde, DN.se, etc.)
  - Write in direct voice: “Police arrested…”, “Prosecutors allege…”
- **Tier B — pipeline allowlist** (broader): `agents/uk-and-europe-cults-columnist/allowed-source-hosts.json`
  - Specialist cult press, some tabloids — still usable but attribute clearly
- **Tier C — everything else** (blogs, aggregators, mabumbe.com, YouTube, niche sites)
  - **Do not state as established fact.** Use: “*Publisher* reported…”, “According to *outlet*…”, “In a piece published by…”

When tiers conflict, prefer the **more cautious** wording.

---

## Paywalled sources

UK/EU outlets such as **The Times**, **The Telegraph**, **FT**, and others may block readers without a subscription. Freedom Times still cites them when they are primary reporting — but citations must be honest and links must work for a general reader where possible.

### Always mark paywalled

Every paywalled citation includes **`paywalled`** in the publisher prefix (alongside country when used):

```
The Times (UK, paywalled): ["Headline"](url), D Mon YYYY.
The Telegraph (UK, paywalled): ["Headline"](url), D Mon YYYY.
```

Never omit the paywalled label, even when the markdown link points at an archive mirror.

### Detecting paywall

Treat a story as paywalled when any of:

- `contentMirrorUrl` is set on the story in `article-plan.json` / review report
- `sourceCitationMarkdown` includes `Accessible copy:` or `Original:` lines
- Host is a known subscription outlet (e.g. `thetimes.co.uk`, `telegraph.co.uk`, `ft.com`)
- Article text in the digest was clearly truncated behind a paywall

### Archive mirrors (archive.ph, archive.org)

You **may** link a verified **archive.ph** snapshot or **web.archive.org** Wayback snapshot instead of (or in addition to) the publisher URL.

**Before including any archive URL:**

1. **Fetch it** (HTTP GET). Reject if non-2xx, empty body, captcha interstitial, or “not archived” / “Page not found”.
2. **Confirm it is a real snapshot** — not a search template:
   - Bad: `https://archive.ph/newest/https://…`, `https://web.archive.org/web/*/https://…`
   - Good: `https://archive.ph/Ab3CdE`, `https://web.archive.org/web/20260408120000/https://…`
3. **Spot-check content** — page title or body should match the cited headline (or a close variant), not a generic archive index.
4. Prefer **`contentMirrorUrl`** from the review pipeline when present — that URL was already used to retrieve article text.

If no working archive exists after checking archive.ph and Wayback, cite the **publisher URL** with the paywalled label only. Do not guess or invent snapshot URLs.

Quick verification (PowerShell):

```powershell
curl.exe -sI "https://archive.ph/Ab3CdE" | Select-String "HTTP/"
curl.exe -sL "https://archive.ph/Ab3CdE" | Select-String -Pattern "subscribe|paywall" -Quiet
```

Or open the URL in a browser / MCP browser tool and confirm the article loads.

### Citation formats (CMS)

**Preferred** — verified archive as link target, paywalled label retained:

```
The Times (UK, paywalled): ["Cult leader faces new charges"](https://archive.ph/Ab3CdE), 8 June 2026.
```

**With publisher original** (optional second link when archive is primary):

```
The Telegraph (UK, paywalled): ["Headline"](https://archive.ph/Xy9Zq1), 8 June 2026. [Publisher original (paywalled)](https://www.telegraph.co.uk/...).
```

**No working archive** — publisher URL only, still marked paywalled:

```
Financial Times (UK, paywalled): ["Headline"](https://www.ft.com/...), 8 June 2026.
```

Wayback example:

```
The Times (UK, paywalled): ["Headline"](https://web.archive.org/web/20260408120000/https://www.thetimes.co.uk/...), 8 June 2026.
```

Reformat from digest `sourceCitationMarkdown` (`Original:` / `Accessible copy:` lines) into the Freedom Times citation line above — do not paste the digest bullet format into CMS.

---

## Editorial tone and voice

Freedom Times exists to **tell the stories of cult survivors** and to support a safer public conversation across the UK and Europe. Every draft should sound like our published work — see staging posts such as `introducing-freedom-times-uk-europe-survivor-advocacy`, `building-the-cult-what-katie-simpsons-murder-reveals-about-coercive-control-group-dynamics-and-the-laws-that-should-have-saved-her`, `pbcc-plymouth-brethren-cult-in-plain-sight-what-unchosen-shows-us-about-hidden-c-1`, and `norway-supreme-court-rules-in-jehovahs-witnesses-case-what-happened-what-it-mean`.

### Mission (what we are for)

- **Survivor-centred reporting** — people harmed by coercive groups are the reason we publish, not a sidebar to the news.
- **Space for truth without intimidation** — we take seriously harassment, shunning, and pressure to stay silent.
- **Evidence-led journalism** — sympathetic does not mean credulous; claims are sourced and legal standards are respected.
- **Policy clarity** — we want legislators to enact **coercive-control legislation** so abusive high-control groups can be recognised and prosecuted where the law allows. Frame this as a public-safety and survivor-justice issue, not party politics.
- **Understanding + accountability** — explain how coercive groups work *and* name institutional failures (police, courts, regulators) when reporting supports it.

### Survivors who speak out

When someone discloses abuse, leaves a group, or gives on-the-record testimony:

- Treat disclosure as **brave and consequential** — without performative flattery or turning them into a mascot.
- Recognise **moral injury** (harm to conscience, betrayal by trusted leaders or community) and **epistemic injury** (distorted beliefs, lost trust in one’s own judgment, difficulty knowing what is true after high-control socialisation). Name these when they illuminate the story; do not psychologise every paragraph.
- **Centre survivor voice** where sources allow — first-person accounts, named ex-members, family members (see Lance Christie in the PBCC / *Unchosen* piece).
- Acknowledge that speaking out **helps others still inside**, especially **adult-children** who grew up in high-control groups and may have no other model for life outside. Leaving is harder when every relationship and identity was built inside the group.

Do not blame survivors for delay, partial memory, or continued contact with family still in the group. Do not demand they “prove” trauma to earn sympathy.

### Explaining the phenomenon

We are sympathetic to the **psychology of cults and high-control groups**. Readers may never have lived inside one; our job is to make the interior intelligible without sensationalism.

- Use precise terms when they earn their place: **coercive control**, **high-control group**, **thought reform**, **shunning / disfellowshipping**, **second-generation survivor**, **abus de faiblesse**, etc. — with brief plain-English glosses.
- Describe **mechanisms** (isolation, dependency, fear of leaving, loyalty tests, financial extraction, sexual coercion) rather than mocking beliefs or treating members as foolish.
- Distinguish **belief** from **coercion** — critique harmful practices and leadership conduct; do not sneer at ordinary religious devotion.
- When court or police language says “sect” or “cult”, attribute it; our voice can say “high-control group” or “coercive organisation” when reporting supports that framing.

### Experts and specialist work

Highlight **credible experts** when the story involves them — researchers, clinicians, independent reviewers, specialist journalists, legal commentators. Name them and their contribution (see Dr Jan Melia’s Katie Simpson Review; Nicola Tallant’s reporting; researchers cited in the PBCC piece).

- Prefer primary expert sources (court-appointed reviewers, peer-reviewed work, established cult-education specialists) over anonymous social-media commentary.
- YouTube reaction videos may be cited (Tier C) but rarely drive the narrative unless summarised with clear attribution.

### Tone on the page

| Do | Avoid |
|----|--------|
| Calm, precise, trauma-aware prose | Tabloid shock, gawking, “true crime” relish |
| Short paragraphs; clear `##` sections | Walls of text, jargon without explanation |
| “For survivors and former members…” when legal news is painful (Norway JW model) | Implying courts “endorsed” abuse when they ruled on a narrow legal test |
| Presumption of innocence for criminal defendants | Victim-blaming, guilt by association for all members |
| Plain sympathy: “this will feel familiar if you have been inside…” (Katie Simpson model) | Irony at survivors’ expense, dunking on people still in groups |

### Legal and criminal stories

- Attribute **allegations** to prosecutors, police, or complainants until conviction.
- Include **presumption of innocence** and editorial notes where charges are live.
- For survivors reading painful outcomes (e.g. a state subsidy ruling), explain **what the judgment did and did not decide** — legal clarity is not moral endorsement of harm.

### Roundup vs standalone tone

- **Roundup:** brisk but not glib; each unit deserves dignity — no punchline summaries of abuse.
- **Standalone:** room for context, survivor relevance, expert framing, and optional `## Editorial note` for legal or psychological nuance.

---

## Article structure (markdown)

Match existing Freedom Times posts. Body is **markdown** (stored in EmDash `content`).

```markdown
# Post title

Opening paragraph: what happened, where, why readers care. Name the group/story plainly.

## Section heading (cluster theme or story beat)

Narrative paragraphs. Short paragraphs. UK/EU reader in mind.

## Next section

…

## Editorial note

(Optional) Legal terms, “sect” vs court findings, presumption of innocence, translation notes.

## Source citations

…
```

### Roundup (`type: roundup`)

- Follow **`unitIds` order** — each unit becomes at least one `##` section (or a clearly labelled subsection).
- Cluster units: synthesise all stories in the unit; do not treat each URL as a separate article.
- Independent units: shorter sections (2–4 paragraphs) unless the story warrants more.
- **No opening intro paragraph** — after the post title, go straight to the first story `##` section. Do not write a thematic week-ahead essay.
- Opening `##` should name the first story, not frame the whole week.

**Geography — `## Beyond Europe` (end of article, before citations):**

Stories **reported on European outlets we monitor** but whose events occur **outside the UK and EU** go in a final section titled **`## Beyond Europe`**, not mixed into the main body. Use `###` subheadings per story. Open the section with one sentence explaining that these items were reported in Europe but occurred elsewhere.

Keep in the **main body** when the European institution or process *is* the news — e.g. EU Parliament hosting an event, EU diplomacy in Brussels, Swedish prosecution of a domestic cell — even if the group or harm has foreign origins.

Place **Beyond Europe** units after all UK/Europe `unitIds`, still before `## Source citations`.

### Standalone (`type: standalone`)

- Deeper narrative arc (see Treogan post): context → timeline → charges/next steps → editorial note.

Apply **Editorial tone and voice** throughout; distinguish prosecution allegations, police statements, and court findings; explain non-English legal terms briefly when needed.

---

## Citation style (from staging posts)

End every article with `## Source citations`. One citation per line, blank line between entries.

### Standard line

```
Publisher (Country): ["Article headline in quotes"](https://publisher.url/path), D Mon YYYY.
```

Examples (from `breton-mayor-treogan-investigation-review`):

```
Radio France / France Bleu — ICI Breizh Izel (France): ["On est sous le choc : dans les Côtes-d'Armor, le maire de Tréogan en garde à vue pour des soupçons de viols"](https://www.radiofrance.fr/...), 1 May 2026.

Le Figaro / AFP (France): ["Il aurait exigé de certaines femmes une « dévotion totale » : soupçonné de dérives sectaires…"](https://www.lefigaro.fr/...), 30 Apr 2026.

Ouest-France (France): ["INFO OUEST-FRANCE. Le maire de Tréogan…"](https://www.ouest-france.fr/...), 29 Apr 2026.
```

### Variant without country

```
BBC News: ["Nine held in religious group modern slavery raid"](https://www.bbc.co.uk/news/...), 29 Apr 2026.
```

### Wire / co-byline

Use `Publisher / Wire (Country):` when the story is an AFP (or similar) pickup.

### YouTube (distinct from print)

YouTube is **not** cited like a newspaper. Use the **channel display name** plus `(YouTube)`, and append **video duration** in square brackets after the date.

```
Channel Name (YouTube): ["Video title"](https://www.youtube.com/watch?v=…), D Mon YYYY [duration].
```

Examples from staging:

```
Lloyd Evans (YouTube): ["Jehovah's Witnesses have won in Norway"](https://www.youtube.com/watch?v=AyJfaGJtCAo), 30 Apr 2026 [22:07].

JW Thoughts (YouTube): ["The Norway Decision is Awful!"](https://www.youtube.com/watch?v=oYT75rEk2tw), 30 Apr 2026 [30:08].

The Ahmadi Religion of Peace and Light | AROPL (YouTube): ["The Anti Cult Movement Is at War With Itself"](https://www.youtube.com/watch?v=CswyeDeKKqc), 26 Aug 2025 [44:23].

The Mahdi Has Appeared (YouTube): ["AROPL, Cult Accusations & the Fight for Religious Freedom | ft. Holly Folk"](https://www.youtube.com/watch?v=6XaNg7f54-k), 07 Jul 2025 [01:14:11].

ITV News In Full (YouTube): ["Police raid religious group in Cheshire | ITV News Granada Reports"](https://www.youtube.com/watch?v=KhKuR8tll-U), 29 Apr 2026 [24:59].
```

YouTube citation rules:

| Print / web article | YouTube video |
|---------------------|---------------|
| `Publisher (Country):` or `Publisher:` | `Channel (YouTube):` — **never** `(Country)` |
| No duration suffix | **Required** `[MM:SS]` or `[HH:MM:SS]` after date |
| Publisher hostname / outlet name | **YouTube channel title** (e.g. `EXJW Analyzer`, not `youtube.com`) |
| Often drives narrative | Usually **Tier C** — list in citations; body only if you summarise commentary, with clear attribution |

Placement: group YouTube entries **after** primary news and official documents, before or among other background/blog sources (see `norway-supreme-court-rules-in-jehovahs-witnesses-case-what-happened-what-it-mean` and `ahmadi-religion-of-peace-and-light-crewe-raids-roundup-30-apr-2026`).

Duration: use upload/runtime from metadata — `[02:14]` for short clips, `[24:59]` for ~25 min, `[01:14:11]` when over an hour.

### Broadcast video on publisher site (not YouTube)

Clips hosted on the outlet’s own player still get a duration suffix but **no** `(YouTube)` label:

```
Channel 4 News: ["Police raid religious group over allegations of sexual offences and modern slavery"](https://www.channel4.com/news/...), 29 Apr 2026 [02:14].
```

### In-body video embed (optional)

For a key broadcast clip, embed via EmDash block (Ahmadi roundup). Cite the YouTube or publisher URL separately in `## Source citations`:

```html
<!--ec:block {"alt":"ITV Granada report on the Crewe operation","aspectRatio":"16 / 9","_type":"video","_key":"qg0p34zq1","id":"https://www.youtube-nocookie.com/embed/PHEVjCZE47s"} -->
```

### Citation rules

- Use the **publisher display name** when known (`data/publisher-display-names.json`), else hostname.
- Headline in **curly quotes** inside markdown link text: `["Headline"](url)`.
- Date format: `D Mon YYYY` (e.g. `30 Apr 2026`) from `publishedAt` UTC.
- Include **every source** you relied on in the narrative, in citation order matching story order where possible.
- Tier C sources remain in citations even when body text uses “reported” framing.
- Paywalled outlets: `(paywalled)` in prefix; archive link only if **verified** (see Paywalled sources).

`sourceCitationMarkdown` on each story is a starting point; **reformat** to match the style above (do not paste the digest `- **Title** — host` format into CMS).

---

## Images

**Roundups:** one image per story section, placed on the line **immediately after** each `##` or `###` heading:

```markdown
## Story heading

![Short alt text](https://staging.freedomtimes.news/_emdash/api/media/file/MEDIA_ID)

Opening paragraph…
```

1. Prefer `og:image` from a **Tier A** source in the unit; else best available sibling URL.
2. Download, upload to staging (`scripts/upload-roundup-images.mjs`), inject via `scripts/inject-roundup-images.mjs`.
3. Alt text: who/what/where — keep short; avoid `|` in alt (breaks Windows CLI upload).
4. Set post `featured_image` to the lead story’s uploaded media (usually first section).
5. Markdown `![alt](url)` renders on the public site (legacy content parser).

---

## Slug conventions

All slugs: **lowercase kebab-case**, ASCII only (transliterate accents: `Tréogan` → `treogan`).

### Roundup / weekly summary (`type: roundup`)

Date-led label for the edition, **day + spelled-out month + year** (no zero-padding on day):

```
weekly-summary-{d}-{month}-{yyyy}
```

Examples:

- `weekly-summary-8-june-2026`
- `weekly-summary-1-july-2026`

Use the **editorial publish date** (or the Friday/end-of-week date the roundup covers). Match the same date in the draft filename: `reports/drafts/weekly-summary-8-june-2026.md`.

### Standalone (`type: standalone`)

**SEO-first** slug: who/what/where/event in plain English, then **date suffix `dd-mm-yyyy`**:

```
{descriptive-keywords}-{dd-mm-yyyy}
```

Examples:

- `breton-mayor-treogan-sect-investigation-29-04-2026`
- `norway-jehovahs-witnesses-supreme-court-ruling-30-04-2026`
- `ahmadi-religion-peace-light-crewe-police-raids-30-04-2026`

Rules:

- Lead with search terms readers would use (group name, place, legal event).
- Keep under ~80 characters where possible; drop filler words (`the`, `a`) before dropping names.
- Date = **Freedom Times publish date** (or planned publish date), not necessarily the source article date.
- One hyphen between words; date always **three numeric segments** at the end.

Do **not** mix formats (no `weekly-summary-2026-06-08` for roundups; no `8-june-2026` on standalone).

---

## CMS delivery (staging)

After editorial approval of the markdown draft:

1. Choose `slug` per conventions above (roundup vs standalone).
2. Set `title`, `excerpt` (first substantive paragraph, ≤ ~300 chars), `subjects` (tags/geography).
3. `content` = full markdown body including `## Source citations`.
4. MCP tools: `content_create` or `content_update` → `content_publish`.
5. Verify: `content get posts <slug> --published`.

Repo scripts for reference:

- `scripts/promote-staging-post-to-production.mjs` — MCP HTTP pattern
- `tmp/mcp-update-treogan.mjs` — portable-text citation blocks (legacy); **prefer markdown** if API accepts it (current staging posts use markdown string in `data.content`).

---

## Output checklist

Before handing to editor:

- [ ] Every `unitId` in the plan article addressed in order
- [ ] Tone: survivor-centred, trauma-aware, evidence-led; experts credited where relevant
- [ ] Tier A/B vs C wording applied consistently
- [ ] `## Source citations` complete, Freedom Times format
- [ ] Paywalled sources labelled `(paywalled)`; archive.ph / archive.org links verified (no `/newest/` or `/web/*/` templates)
- [ ] Criminal allegations attributed; presumption of innocence where needed
- [ ] Featured image set (or explicit note why none)
- [ ] Slug matches type: `weekly-summary-8-june-2026` (roundup) or `{topic}-{dd-mm-yyyy}` (standalone)
- [ ] Draft saved under `reports/drafts/<slug>.md`
- [ ] Staging post created as **draft/unpublished** until editor approves publish

---

## Current run (2026-06-08)

Plan: `reports/article-plan.json` — **1 roundup**, 24 stories, 14 units:

1. Hoyt Richards (cluster, 5)
2. Maniac Murder (cluster, 4)
3. Marys (cluster, 2)
4. Andrew Tate (cluster, 2)
5. Allatra EU Parliament (cluster, 2)
6. + 9 independent stories

Suggested staging slug: `weekly-summary-8-june-2026`.
