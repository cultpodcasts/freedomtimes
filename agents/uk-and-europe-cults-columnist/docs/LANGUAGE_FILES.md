# Language Files Documentation

This document explains how the language-specific JSON files work for the cult news clustering system, and how to update them when addressing false positives.

## File Locations

Language files are located in:
```
data/discovery/lang/{lang}.json
```

Where `{lang}` is a two-letter ISO language code (e.g., `en`, `it`, `de`, `fr`).

## Language File Structure

Each language file contains the following fields:

### 1. `cultTerms` (array of strings)
Primary terms that indicate cult-related content in this language.

**Purpose:** These are the main keywords used to identify potentially cult-related stories.

**Examples:**
- English: `["cult", "sect"]`
- Italian: `["cult", "setta"]`
- German: `["kult", "sekte"]`

### 2. `genericCultTerms` (array of strings)
Broader terms that may appear in cult contexts but are not specific to cults.

**Purpose:** Used for broader matching but with lower specificity than `cultTerms`.

**Examples:**
- English: `["cult", "sect"]` (same as primary for English)
- Italian: `["culto", "culti"]` (variants)
- German: `["kult", "sekte"]` (same as primary)

### 3. `religiousGroupTerms` (array of strings)
Terms indicating legitimate religious groups that should NOT be flagged as harmful cults.

**Purpose:** Prevents false positives on mainstream religious organizations.

**Examples:**
- English: `["church of england", "anglican", "catholic church"]`
- Italian: `["chiesa cattolica", "chiesa anglicana"]`

### 4. `coerciveHarmTerms` (array of strings)
Terms indicating actual harm, abuse, or coercion (strong signals of problematic groups).

**Purpose:** When these terms appear, it overrides figurative filtering - the story is likely about actual harmful groups.

**Examples:**
- English: `["abuse", "brainwashing", "coercion", "modern slavery"]`
- Italian: `["abuso", "lavaggio del cervello", "coercizione", "schiavitù moderna"]`

### 5. `groupStopwords` (array of strings)
Common words ignored when extracting cluster phrases and anchor terms (grammar, news chrome, publisher UI).

**Purpose:** Single per-locale stopword list for clustering and phrase extraction. Language-agnostic terms shared by all locales live in `data/cluster-token-stopwords.json` → `base` and are merged at load time.

**Edit here** — not in TypeScript. Do not duplicate lists in `cluster-token-stopwords.json` locale keys (removed).

### 6. `figurativeCultPhrases` (array of strings)
**MOST IMPORTANT FOR FALSE POSITIVES**

Complete phrases that indicate figurative/non-literal usage of "cult" terms.

**Purpose:** Identifies when "cult" is used in entertainment/lifestyle contexts (cult films, cult following, etc.) rather than describing actual religious groups.

**Examples:**
- English: `["cult classic", "cult following", "cult film", "cult hero", "cult legend"]`
- Italian: `["film cult", "serie cult", "cult come", "meme cult"]`
- German: `["kult und ein klischee", "kult-lokal", "kult-kneipe"]`

### 7. `figurativeCultContextTerms` (array of strings)
**MOST IMPORTANT FOR FALSE POSITIVES**

Words that, when appearing near "cult" terms, indicate figurative usage.

**Purpose:** Works with the regex pattern `cult.{0,24}?(contextTerm)` to catch figurative usage even when words appear between "cult" and the context term.

**Examples:**
- English: `["film", "movie", "band", "hero", "following", "legend"]`
- Italian: `["film", "serie", "meme", "cinema", "libro"]`
- German: `["lokal", "restaurant", "sendung", "klischee", "legende"]`

### 8. `figurativeCultRegexPatterns` (array of strings) - Optional
Explicit regex patterns for complex figurative detection cases.

**Purpose:** When simple phrases/context terms aren't sufficient, use explicit regex.

**Examples:**
- German: `["kult.{0,20}klischee", "kult.{0,20}legende"]`

### 9. `stopwords` (array of strings)
Common words to exclude from feature extraction.

**Purpose:** Prevents common words from being used as clustering features.

## Subject Aliases File

**File:** `data/cluster-entity-aliases.json` (should be renamed to `subject-aliases.json`)

**Purpose:** Maps canonical subject names to their aliases in different languages.

**Structure:**
```json
[
  {
    "canonical": "plymouth brethren",
    "aliases": [
      { "text": "exclusive brethren" },
      { "text": "frères de plymouth", "lang": "fr" },
      { "text": "fratelli di plymouth", "lang": "it" }
    ]
  }
]
```

**When to add:** When a known subject has different names in different languages or contexts.

## How to Address False Positives

When a story is incorrectly flagged as cult-related (false positive), follow this process:

### Step 1: Identify the Root Cause

Run the render script with debug output to see why the story passed:
```bash
CULT_NEWS_RENDER_MAX_AGE_HOURS=240 npx tsx scripts/render-cult-news-html.tsx 2>&1 | grep -i "story_title"
```

Check:
1. **Does the story actually contain a cult term?** (e.g., "cult", "secte", "kult")
2. **Is the cult term being used figuratively?** (entertainment, lifestyle, pop culture)
3. **What language was detected?**

### Step 2: Determine the Fix Type

#### Case A: Word Boundary Issue
**Problem:** "cult" matches inside "cultural", "cultura", "agriculture"

**Fix:** The code now uses `\bcult\b` word boundary matching automatically for short terms. If this still fails, the story likely contains an actual standalone "cult" term.

#### Case B: Figurative Usage Not Caught
**Problem:** Story uses "cult" in entertainment/lifestyle context but wasn't filtered

**Solution:** Add appropriate figurative signals to the language file.

**Decision Tree:**

1. **Is there a specific phrase?** (e.g., "cult classic", "film cult", "kult und ein klischee")
   - **YES** → Add to `figurativeCultPhrases`

2. **Is there a context word near "cult"?** (e.g., "cult ... film", "cult ... band", "kult ... legende")
   - **YES** → Add the context word to `figurativeCultContextTerms`
   - The pattern `cult.{0,24}?(contextTerm)` will match even with words between them

3. **Is the pattern complex or word-order dependent?**
   - **YES** → Add explicit `figurativeCultRegexPatterns`

### Step 3: Apply the Fix

**Example 1:** Story about "Aston Villa has a cult following" (English)
- Cult term: "cult" ✓
- Context: "following" (already in `figurativeCultContextTerms`)
- **Action:** The existing pattern should catch this. If not, verify the regex pattern fix is deployed.

**Example 2:** Story about "film cult italiani" (Italian)
- Cult term: "cult" ✓
- Context: "film" (in `figurativeCultContextTerms`)
- Pattern direction: Italian uses "film cult" not "cult film"
- **Action:** Already handled by bidirectional patterns in `pipeline.ts`

**Example 3:** Story about "Luigi Montefiori in cult come Baba Yaga" (Italian)
- Cult term: "cult" ✓
- Phrase: "cult come"
- **Action:** Add "cult come" to `figurativeCultPhrases` in `it.json`

**Example 4:** Story about "Kult und ein Klischee" (German)
- Cult term: "kult" ✓
- Pattern: words between "kult" and "klischee"
- **Action:** Add "klischee" to `figurativeCultContextTerms` in `de.json`

### Step 4: Test the Fix

1. Run the render script
2. Verify the false positive no longer appears in clusters
3. Check that legitimate cult stories still appear correctly

### Key Principles

1. **Prefer context terms over specific phrases** - Adding "show" to context terms catches "cult show", "show that skewed cult", etc.

2. **Use phrases only when context terms can't work** - When the pattern is idiomatic and doesn't fit the `cult + context` pattern.

3. **Avoid hardcoding article-specific phrases** - Don't add "skewed more cult than mainstream"; instead add "following" or "mainstream" to context terms.

4. **Cross-language consistency** - If Italian needs "film cult", German probably needs "kultfilm" or similar.

5. **Always check for coercive harm terms first** - If a story contains "abuse" or "brainwashing", it should NOT be filtered regardless of figurative phrases.

## Pattern Matching Details

The figurative detection uses these regex patterns (from `src/pipeline.ts`):

```javascript
// English/shared patterns:
/cult.{0,24}?(contextTerm)/i  // cult followed by context term (with up to 24 chars between)
/(figurativePhrase)/i          // exact phrase match
/(contextTerm).{0,24}?cult/i   // context term before cult (bidirectional)

// Per-language patterns (built from JSON terms):
/${prefix}.{0,24}?(${contextTerm})/i  // e.g., kult.{0,24}?(lokal|legende)
/(${contextTerm}).{0,24}?${prefix}/i  // bidirectional
```

The `.{0,24}?` allows up to 24 characters (about 3-4 words) between "cult" and the context term, catching patterns like:
- "cult classic film" → "cult" + "film"
- "skewed more cult than mainstream following" → "cult" + "following"
- "kult und ein klischee" → "kult" + "klischee"
