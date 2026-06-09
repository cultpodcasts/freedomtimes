# Europe & UK Cult News — weekly report writing guide

Canonical prose standards for **weekly roundups** (`type: roundup` in `article-plan.json`). Operator workflow (images, staging, citations detail) stays in [DRAFT_FROM_ARTICLE_PLAN.md](DRAFT_FROM_ARTICLE_PLAN.md) and the Cursor skill [`.cursor/skills/draft-from-article-plan/SKILL.md`](../../../.cursor/skills/draft-from-article-plan/SKILL.md).

---

## What you are writing

A **news roundup**, not an essay. Each planned unit becomes a short, sourced summary of one story or cluster. Freedom Times mission and survivor advocacy belong in **standalone** pieces — not in weekly body copy.

| | Roundup | Standalone |
|---|---------|------------|
| Voice | Brisk, factual, attributed | Room for context, expert framing, optional `## Editorial note` |
| Sections | One `##` per plan unit | Narrative arc (timeline, charges, next steps) |
| Commentary | None — report what sources say | May address survivor relevance and policy stakes |

---

## Title, slug, and CMS metadata

| Field | Rule | Example |
|-------|------|---------|
| **Post title** (H1 in draft) | `Europe & UK Cult News: {start}–{end} {Month} {YYYY}` | `Europe & UK Cult News: 1–7 June 2026` |
| **CMS slug** | `weekly-summary-{publish-day}-{month}-{yyyy}` — lowercase, spelled-out month, no zero-padded day | `weekly-summary-8-june-2026` |
| **Draft filename** | `reports/drafts/{slug}.md` — may use coverage end date; CMS slug uses **publish** date | Local `weekly-summary-7-june-2026.md` → CMS `weekly-summary-8-june-2026` |
| **Subject chip** | `Europe & UK Cult News` (plus geography tags as needed) | `{slug}-subjects.json`: `["Europe & UK Cult News", "UK", "Europe"]` |
| **Excerpt** | First substantive paragraph after the preamble (≤ ~300 chars) | Set automatically on push from draft body |

Push when draft slug ≠ CMS slug:

```powershell
$env:EMDASH_STAGING_PAT = [Environment]::GetEnvironmentVariable('EMDASH_STAGING_PAT', 'User')
cd agents/uk-and-europe-cults-columnist
npx tsx scripts/push-draft-to-staging.mts weekly-summary-7-june-2026 weekly-summary-8-june-2026
```

---

## Document structure

```markdown
# Europe & UK Cult News: 1–7 June 2026

One short preamble: what this roundup is, where stories were found, that full links are at the bottom.

## First story (not a week-framing essay)

![alt](staging-media-url)

2–3 paragraphs of sourced news.

## Next story

…

## Beyond Europe

One sentence: reported on European outlets we monitor; events occurred outside UK/EU.

### Story subheading

![alt](url)

Paragraphs…

## Source citations

Publisher (Country): ["Headline"](url), D Mon YYYY.
```

### Section order

Follow **`unitIds`** in `article-plan.json` exactly. Cluster units: synthesise all URLs in the unit into **one** section — do not split each URL into its own heading.

### Preamble (required — executive map of the week)

After the H1, **one paragraph** that hooks readers who follow cult and high-control-group news. Each thread must name the **group, movement, service, or cult-linked dispute** — not vague placeholders (“survivors defend testimony”, “institutions face scrutiny”, “counsellors report demand”). A reader should see immediately *which cults, which courts, which helplines* the week touched.

| Weak (omit) | Strong (use) |
|-------------|--------------|
| “survivors defend testimony in Paris” | “a former Raëlian adherent wins a Paris defamation ruling” |
| “who gains a platform in Brussels” | “the disputed AllatRa movement holds a European Parliament seminar” |
| “specialist counsellors report record demand” | “Switzerland’s infoSekta logs record cult-counselling calls” |

**Geography:** say **Europe and the UK** (Europe first). In our narration use **UK**, not Britain or British, when referring to the United Kingdom.

Close by noting that summaries draw on monitored **European and UK** outlets and that citations follow.

Do **not** open with “this roundup gathers stories…” alone. Do **not** write a Freedom Times essay on cults in general.

Example shape (adapt to the plan):

> The week of 1–7 June carried cult and high-control-group stories across Europe and the UK: Sweden’s first Maniac Murder Cult terror prosecution; a Paris court backs a former Raëlian adherent’s testimony against the movement; HBO premieres a documentary on a male supermodel’s exit from an alleged Manhattan modelling cult; Switzerland’s infoSekta reports record cult-counselling demand; the disputed AllatRa movement draws protest after a European Parliament seminar in Brussels; and UK campaigners challenge Andrew Tate’s extradition delay after a Moscow appearance. Summaries draw on monitored European and UK outlets; full source links follow.

### `## Beyond Europe`

Place **after** all UK/Europe units, **before** `## Source citations`.

| Goes in main body | Goes in Beyond Europe |
|-------------------|----------------------|
| EU Parliament hosting an event | US ordination reported by a European wire |
| Swedish prosecution of a domestic cell | Vatican summit in Abuja covered by *Vatican News* |
| Brussels diplomacy as the news | Kansas SSPX story in a US regional paper |

Use `###` subheadings per story inside Beyond Europe.

### Images

- One image per section, on the line **immediately after** each `##` / `###` heading.
- **Exception:** the first main-body story uses the post `featured_image` only — no duplicate inline hero under that heading.
- Workflow: [DRAFT_FROM_ARTICLE_PLAN.md § Images](DRAFT_FROM_ARTICLE_PLAN.md#images-approval-workflow).

### Video embeds (optional)

After the paragraph where the clip is relevant:

```html
<!--ec:block {"_type":"video","url":"https://www.youtube.com/watch?v=…"} -->
```

Cite the same URL in `## Source citations` as `Channel (YouTube): … [duration]`.

---

## Translation blocks (foreign-language quotes)

Freedom Times does **not** present English paraphrases as direct quotes when the cited outlet published them in another language. Use the **translation block** — the same pattern as flagship posts such as `norway-supreme-court-rules-in-jehovahs-witnesses-case-what-happened-what-it-mean` and French context pieces on staging.

Full renderer contract: `web/docs/EDITORIAL_ENGLISH_GLOSSES.md` § **PT pattern: French `blockquote` + English translation expander (canonical)**. The pattern applies to **all** source languages in roundups (Swedish, French, Norwegian, Dutch, German, etc.) — not French only.

### When to use

| Use translation block | Keep inline English quote |
|-----------------------|---------------------------|
| Quote appears in a **foreign-language** article you are citing | Source article is already in **English** |
| **Direct speech** from interrogation, court, leader, survivor in original language | Paraphrase or summary in your own words (no quote marks) |
| Distinctive line worth showing **verbatim** in the source tongue | Short English quote from an English outlet |

### Structure (strict order)

1. **English prose** introduces who spoke and in what context (interrogation, press conference, book, etc.).
2. **`blockquote`** — original wording from the cited outlet (`>` line in draft markdown).
3. **Translation fold** — English rendering behind “Show English translation”.
4. **English prose** continues the section.

### Draft markdown (authoring format)

```markdown
*Expressen* links the case to "The Com". In interrogation the boy said the group forced him to film the arson:

> – Jag begick inte brottet för att det var kul eller någonting. Jag begick det för att jag blev tvingad. Om jag inte gör det, då skulle de ringa polisen och berätta. Alltså, jag är med i en sekt, fortsätter han i förhör.

<details class="translate">
<summary>Show English translation</summary>

I did not commit the offence because it was fun or anything. I did it because I was forced. If I do not do it, they would call the police and report it. That is, I am in a sect, he continues in interrogation.

</details>

He has been detained since February; trial opens 9 June.
```

`scripts/markdown-to-portable-text.mts` converts this to the Portable Text block sequence the site expects on push. Inline images must use **`asset: { url: '/_emdash/api/media/file/…' }`** (not a bare `url` field) so the EmDash admin editor can render them.

### Portable Text block order (what the renderer needs)

After conversion, the CMS `content` array must contain **five blocks** in this order:

| # | PT `style` | Content |
|---|------------|---------|
| 1 | `blockquote` | Original-language quote only |
| 2 | `normal` | `<details class="translate">` (literal — class must be **`translate`**, not `translation`) |
| 3 | `normal` | `<summary>Show English translation</summary>` (literal) |
| 4 | `normal` | English rendering (plain prose) |
| 5 | `normal` | `</details>` (literal — **required** closing block) |

If the closing `</details>` block is missing, the fold breaks and tags render as visible paragraphs.

### English inside the fold

- Prepare the English line with **Google Translate** or a close manual edit for readability — same approach as the Norway Supreme Court post.
- Do **not** prefix with `English:` inside the fold unless editorially necessary.
- Keep legal or colloquial terms faithful; note in prose if the source idiom is awkward in English.
- See [CULT_WORDING.md § Source language → English](CULT_WORDING.md#source-language--english-translation-folds) for blockquote vs translation-fold rules.

### Do not

- Put the foreign line **inside** `<details>` — it belongs in the **blockquote first**.
- Inline an English “quote” that is your translation of Swedish/French/etc. (e.g. ~~`the boy said: "If I don't do it, they would call the police…"`~~ when *Expressen* published Swedish).
- Omit `</details>` or merge open/summary/body into one paragraph.
- Use `class="translation"` on new posts — use **`class="translate"`** only.
- Use translation blocks for **English-source** quotes (Guardian, BBC, etc.) — quote in English directly.

### Reference posts on staging

- `norway-supreme-court-rules-in-jehovahs-witnesses-case-what-happened-what-it-mean` — Norwegian blockquote + translation folds
- `weekly-summary-8-june-2026` — Swedish *Expressen* interrogation quote (Com/764 section)

---

## Journalism first — each section

Lead with **who, what, where, when** from Tier A/B sources. Add **why / how** only when sources state motive, method, or alleged conduct.

| Include in opening paragraph(s) | Examples |
|-----------------------------------|----------|
| **Who** | Named defendant, survivor, MEP, organisation, leader |
| **What** | Charge filed, documentary aired, stickers removed, book published |
| **Where** | City, court, institution, country |
| **When** | Date of hearing, broadcast, arrest, publication |

### Length

- **2–3 short paragraphs per unit** — facts and attributed quotes/summaries.
- **One closing context sentence** is fine if sourced (e.g. “*Le Figaro* notes this is the first MKY prosecution in Sweden”).
- **One strong attributed quote** per section when the source provides one worth keeping.

### Criminal and court stories

- Name people when **sources name them** — accused, charged, survivor, judge, prosecutor.
- Include **charge(s), court, date, place**.
- Attribute **allegations** to prosecutors, police, or complainants until conviction.
- One brief **presumption of innocence** clause where charges are live — not a lecture.
- If law limits naming (e.g. Sweden), say so explicitly.

### Filling gaps

Answer journalistic gaps using **text from stories in the article plan only** — not ad-hoc web search. If the plan corpus does not contain a fact, omit it or note the limit in editor review; do not invent or infer.

---

## Voice, wording, and formatting

### No editorial commentary in body

Do **not** state Freedom Times’s position inside a story summary:

| Avoid | Instead |
|-------|---------|
| “Freedom Times distinguishes coercive groups from ordinary faith…” | Report what the expert or outlet said |
| “This is not a cult story in the narrow sense, but…” | Omit — if it is in the plan, report the facts |
| “Legislators still underfund…” / policy essays | Omit in roundups |
| “Survivors of high-control groups will recognise…” | Omit generic reader address |
| Generic paragraphs on bravery, epistemic injury, systems failure | Keep sympathy **brief and tied to a named person** in that section |

### Cult vs sect (Freedom Times voice)

**Full guide:** [CULT_WORDING.md](CULT_WORDING.md) — when to use *cult*, when *sect*/*sekt*/*secte* may stay, source-language → English mapping, translation folds, checklist, and June 2026 examples.

**Summary:** Default to **cult** in our English narration and translation folds. Keep *sect* / *sekt* / *secte* only in original blockquotes, proper names, citation headlines, or when noting how a source *labels* a group (italic source term; our word still *cult*). Exceptions: schism/denomination stories (SSPX), broad sociology without harm — see [CULT_WORDING.md § When cult is wrong](CULT_WORDING.md#when-cult-is-wrong-or-needs-care).

### Source tiers

| Tier | List | Body voice |
|------|------|------------|
| A | `watchlist-sites.json` | Direct reporting: “Police arrested…”, “Prosecutors allege…” |
| B | `allowed-source-hosts.json` | Direct, clear attribution |
| C | Everything else | “*Publisher* reported…”, “According to…” |

When tiers conflict, prefer the **more cautious** wording.

### Formatting rules

- **No bold** in body text — do not use `**…**` for emphasis.
- *Italics* for outlet names and programme/book titles where needed.
- Short paragraphs; clear `##` headings.
- Opening `##` names the **first story**, not the whole week.

### No AI artefacts

Roundups must read like edited wire copy from a broadsheet foreign desk, not model-generated summary prose. After the executive editor pass, scan for and remove:

| Avoid | Use instead |
|-------|-------------|
| **Em dashes** (`—`) in body copy | Commas, colons, parentheses, semicolons, or a second sentence |
| Vague demographic jargon (“users skew thirty-plus”, “the demographic landscape”) | Plain ages (“in their thirties or older”, “teenagers and young adults”) |
| Filler connectives (“it's worth noting”, “underscores”, “highlights”, “serves as a reminder”, “in a landscape where”) | Cut, or state the fact directly |
| Empty intensifiers (“robust”, “pivotal”, “comprehensive”, “delve”, “navigate”) | Concrete verbs and nouns from the source |
| Symmetrical list padding (“from X to Y; from A to B”) when one example suffices | One sourced detail |
| Meta openers (“This section explores…”, “The story centres on…”) | Lead on who / what / where / when |

**Allowed dashes:** en dashes in **post titles and date ranges** (`1–7 June 2026`); hyphens in compound modifiers; em/en dashes inside **quoted source headlines** in `## Source citations` and in **foreign-language blockquotes** where the outlet used them. Do not carry em-dash rhythm into our English narration.

**Orphan names:** if an organisation, court, or programme appears without context, add one clause on first mention (Fier, infoSekta, Mouv’Enfants) before the week’s news peg — not a sidebar essay.

---

## Executive editor pass

Treat every roundup as an **executive intelligence brief** — the kind of summary a world-renowned broadsheet foreign desk would file after researchers have assembled the most important cult and high-control-group reports from European outlets. The reader should finish informed about the **variety** of issues in the coverage week, not just a list of headlines.

### Role

You are a seasoned editor, not a summariser. Your job is to **relay discrete stories** with enough detail and texture that each stands on its own, while the preamble and occasional closing clauses convey the **shape of the week**.

### Per section

1. **Lead on the news peg** — charge, premiere, ruling, record, invitation, removal of stickers.
2. **Second sentence** — contrast, scale, or mechanism (what makes this story distinctive).
3. **Third paragraph** (if needed) — quote, context, or linked development in the same unit only.
4. **Close** (optional) — one sourced clause placing the story in the week’s wider picture (institutional friction, influencer culture, hospitality rules) without merging adjacent units.

### Prose discipline

- Active verbs; short sentences; calm authority.
- Cut repeated outlet attributions — cite once per fact cluster.
- One memorable sourced detail per section where available (legal article numbers, target lists, a single telling quote).
- Read aloud: if a paragraph only repeats the heading, delete or rewrite.
- No bold; no em dashes in body copy; no tabloid relish; no invented connective tissue; no AI filler (see § No AI artefacts).

### After the first draft

Always run this pass before images and staging. First draft = assemble facts from the plan; editor pass = structure, tighten, map the week.

---

## Cut redundancy — what to remove

After the first draft, edit for density. These patterns were removed from the June 2026 edition and should stay out unless a source makes them central to the story.

### 1. Orphan names (who is this?)

Drop or introduce on first mention — reader should not need prior knowledge:

- Organisations quoted without a role (e.g. Mouv’Enfants with no “childhood sexual violence victims’ association”)
- Movements or leaders without one clause of context (e.g. Raël / Raëlian movement before Vorilhon is named as founder)
- Agencies, courts, or programmes named once in passing

**Fix:** one appositive or subordinate clause from the cited source — not a sidebar essay. If the **section subject** is an organisation, service, or court (e.g. infoSekta, Mouv’Enfants), the **opening sentence** should say what it is and what it does before the week’s news peg (record figures, ruling, report).

### 2. Orphan procedural detail

Facts that name an agency, sentence, or process **without prior context**:

- “Säpo led the investigation” when Säpo was never introduced
- Minimum sentence / sentencing range
- Which court confirmed anonymous social accounts
- “Home Office declined to comment”
- “The outlet does not report a response from the church”

**Keep** procedural detail only when it answers a reader question (e.g. why extradition is delayed, which court hears the case).

### 3. Repeated facts across paragraphs

Do not restate the same charge, date, or outlet attribution in consecutive paragraphs. Merge cluster siblings into one narrative.

### 4. Meta journalism

Lines about what sources **did not** report:

- “The paper does not report…”
- “No response was given”
- Boilerplate spokesperson quotes that add no new fact

### 5. Sidebar context

Detachable colour that does not advance the lead:

- Career backstory already implied by the headline
- Duplicate lists (supermodel roster twice, filming detail twice)
- Policy subplots unrelated to the charge or event
- Statistics dumps when one figure suffices

### 6. Stacked attributions

Three outlets saying the same thing in one paragraph — collapse to the strongest attribution or one representative quote.

### 7. Generic padding

- Survivor-psychology essays unrelated to a named person in the section
- Freedom Times policy or faith-tradition lectures
- “Systems failure” paragraphs unless the **source story** is about that system

---

## What to keep

- Charges, dates, courts, and named people sources publish
- One attributed quote that carries emotional or legal weight
- Sourced context that answers “why does this matter this week?” (e.g. first prosecution of its kind, EU institution hosting a controversial group)
- Distinction between allegation, police statement, and court finding

---

## Source citations

End every roundup with `## Source citations`. One line per source, blank line between entries.

```
Publisher (Country): ["Headline"](url), D Mon YYYY.
```

YouTube:

```
Channel Name (YouTube): ["Video title"](url), D Mon YYYY [MM:SS].
```

Paywalled: `Publisher (UK, paywalled):` — archive link only if verified. Full rules: skill § Paywalled sources and [DRAFT_FROM_ARTICLE_PLAN.md § Paywalled](DRAFT_FROM_ARTICLE_PLAN.md#paywalled-sources).

Include **every source** relied on in the narrative, in story order where possible. Reformat from `sourceCitationMarkdown` in the plan — do not paste digest bullet format into CMS.

---

## Staging delivery

Body markdown is converted to **Portable Text** before CMS push (`markdown-to-portable-text.mts`). Raw markdown strings break public rendering (headings, images, and video blocks appear as plain text).

```powershell
$env:EMDASH_STAGING_PAT = [Environment]::GetEnvironmentVariable('EMDASH_STAGING_PAT', 'User')
cd agents/uk-and-europe-cults-columnist
npm run draft:push-staging -- weekly-summary-8-june-2026
cd ../../web
npx emdash content publish posts weekly-summary-8-june-2026 -u https://staging.freedomtimes.news -t $env:EMDASH_STAGING_PAT
```

Do **not** publish to production unless explicitly asked.

---

## Pre-handoff checklist

- [ ] Every `unitId` addressed in plan order
- [ ] Title: `Europe & UK Cult News: {dates}`; slug `weekly-summary-{d}-{month}-{yyyy}`
- [ ] Subject chip: `Europe & UK Cult News` in `{slug}-subjects.json`
- [ ] Executive editor pass complete
- [ ] Preamble maps the week’s threads; first `##` is the first story
- [ ] **2–3 paragraphs** per unit; who / what / where / when in leads
- [ ] No Freedom Times commentary; no bold; no em dashes or AI filler in body copy; [CULT_WORDING.md](CULT_WORDING.md) checklist passed
- [ ] Foreign quotes: original in blockquote + English in `<details class="translate">` (not inline paraphrase)
- [ ] Redundancy pass: no orphan procedural lines, no meta “paper does not report”, no duplicate facts
- [ ] Tier A/B/C wording consistent
- [ ] Criminal allegations attributed; presumption of innocence where needed
- [ ] Images collected, approved, uploaded, injected
- [ ] `## Source citations` complete; paywalled labels and verified archive links
- [ ] Beyond Europe units in closing section with `###` subheads
- [ ] Pushed as Portable Text; verified on staging (headings, images, video iframe)

---

## Related docs

| Doc | Use |
|-----|-----|
| [WEEKLY_RUN.md](WEEKLY_RUN.md) | Discovery → digest → browser review |
| [FIELD_RUN_PROMPT.md](FIELD_RUN_PROMPT.md) | New agent session for in-the-field runs |
| [DRAFT_FROM_ARTICLE_PLAN.md](DRAFT_FROM_ARTICLE_PLAN.md) | Article plan → draft → images → staging |
| [CULT_WORDING.md](CULT_WORDING.md) | Using *cult* vs *sect* in weekly reports |
| [AGENT_NPM_SCRIPTS.md](AGENT_NPM_SCRIPTS.md) | All `npm run` commands |
| `.cursor/skills/draft-from-article-plan/SKILL.md` | Full agent skill (tiers, paywall, images, slugs) |
