/// <reference types="node" />
/* @jsxRuntime classic */
/** @jsx h */
/** @jsxFrag Fragment */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { detect as detectLanguage } from 'tinyld';
import { loadGroupStopwordsByLanguageFromDiscoveryLangFiles } from '../src/discoveryLangGroupStopwords.js';
import {
  Fragment,
  LOG_PATH,
  OUTPUT_PATH,
  extractDraftsFromLog,
  extractRunSummary,
  fetchStoryMeta,
  formatPublishedAt,
  h,
  renderDocument,
  type EnrichedStory,
} from './render-cult-news-html.helpers.js';

declare global {
  namespace JSX {
    interface IntrinsicElements {
      [elementName: string]: Record<string, unknown>;
    }
  }
}

type StoryGroup = {
  label: string;
  type: 'detected' | 'independent';
  stories: EnrichedStory[];
};

type DraftStory = ReturnType<typeof extractDraftsFromLog>[number];

function normalizeHost(host: string): string {
  return host.replace(/^www\./i, '').toLowerCase();
}

function canonicalizeStoryUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const host = normalizeHost(parsed.hostname);
    if (host !== 'cultnews.net') {
      parsed.hostname = host;
      return parsed.toString();
    }

    const segments = parsed.pathname
      .split('/')
      .filter(Boolean)
      .map((segment) => segment.trim())
      .filter(Boolean);

    const embeddedHostIndex = segments.findIndex((segment) => /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(segment));
    if (embeddedHostIndex < 0 || embeddedHostIndex >= segments.length - 1) {
      return parsed.toString();
    }

    const embeddedHost = segments[embeddedHostIndex].toLowerCase();
    const embeddedPath = segments.slice(embeddedHostIndex + 1).join('/');
    const canonical = new URL(`https://${embeddedHost}/${embeddedPath}`);
    if (parsed.search) {
      canonical.search = parsed.search;
    }
    if (parsed.hash) {
      canonical.hash = parsed.hash;
    }
    return canonical.toString();
  } catch {
    return rawUrl;
  }
}

function getHostname(rawUrl: string): string | undefined {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return undefined;
  }
}

function getSlug(rawUrl: string): string | undefined {
  try {
    const segments = new URL(rawUrl).pathname.split('/').filter(Boolean);
    const slug = segments.at(-1)?.trim().toLowerCase();
    return slug || undefined;
  } catch {
    return undefined;
  }
}

function normalizeUrl(rawUrl: string): string {
  try {
    return new URL(rawUrl).toString().toLowerCase();
  } catch {
    return rawUrl.trim().toLowerCase();
  }
}

function createDedupeKey(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    parsed.hostname = normalizeHost(parsed.hostname);

    // Remove common tracking params so publisher mirrors collapse correctly.
    const trackingParams = [
      'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
      'gclid', 'fbclid', 'at_medium', 'at_campaign',
    ];
    for (const key of trackingParams) {
      parsed.searchParams.delete(key);
    }

    if (!parsed.searchParams.toString()) {
      parsed.search = '';
    }

    return parsed.toString().replace(/\/$/, '').toLowerCase();
  } catch {
    return rawUrl.trim().replace(/\/$/, '').toLowerCase();
  }
}

const HOST_TOKEN_EXCLUSIONS = new Set(['www', 'com', 'co', 'uk', 'ie', 'org', 'net', 'news', 'the']);

function tokenizeSimilarityText(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((token) => token.replace(/s$/u, ''))
    .filter((token) => token.length >= 4);
}

function uniqueTokens(tokens: string[]): Set<string> {
  return new Set(tokens.filter((token) => !HOST_TOKEN_EXCLUSIONS.has(token)));
}

function jaccardSimilarity(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const value of left) {
    if (right.has(value)) {
      intersection += 1;
    }
  }

  return intersection / (left.size + right.size - intersection);
}

function getPublicationHostSignature(rawUrl: string): Set<string> {
  const host = getHostname(rawUrl);
  if (!host) {
    return new Set<string>();
  }

  return uniqueTokens(
    host
      .split('.')
      .flatMap((label) => label.split(/[^a-z0-9]+/i))
      .filter(Boolean),
  );
}

function getNormalizedPath(rawUrl: string): string | undefined {
  try {
    const parsed = new URL(rawUrl);
    return parsed.pathname.replace(/\/+$/u, '').toLowerCase();
  } catch {
    return undefined;
  }
}

function isLikelyAliasHostDuplicate(left: EnrichedStory, right: EnrichedStory): boolean {
  const publicationSimilarity = jaccardSimilarity(
    getPublicationHostSignature(left.url),
    getPublicationHostSignature(right.url),
  );
  if (publicationSimilarity < 1) {
    return false;
  }

  const samePath = getNormalizedPath(left.url) === getNormalizedPath(right.url);
  const sameSlug = getSlug(left.url) === getSlug(right.url);
  const titleSimilarity = jaccardSimilarity(
    uniqueTokens(tokenizeSimilarityText(left.title)),
    uniqueTokens(tokenizeSimilarityText(right.title)),
  );
  const articleSimilarity = jaccardSimilarity(
    uniqueTokens(tokenizeSimilarityText(left.articleText)),
    uniqueTokens(tokenizeSimilarityText(right.articleText)),
  );

  return samePath || sameSlug || titleSimilarity >= 0.88 || articleSimilarity >= 0.9 || (titleSimilarity >= 0.72 && articleSimilarity >= 0.72);
}

function dedupeStories(stories: EnrichedStory[]): { kept: EnrichedStory[]; excluded: Array<{ url: string; reason: string }> } {
  const kept: EnrichedStory[] = [];
  const excluded: Array<{ url: string; reason: string }> = [];
  const seenUrls = new Set<string>();

  for (const story of stories) {
    const normalizedUrl = createDedupeKey(story.url);
    if (seenUrls.has(normalizedUrl)) {
      excluded.push({
        url: story.url,
        reason: 'Duplicate canonical URL in shortlisted drafts.',
      });
      continue;
    }

    const aliasDuplicate = kept.find((existing) => isLikelyAliasHostDuplicate(existing, story));
    if (aliasDuplicate) {
      excluded.push({
        url: story.url,
        reason: 'Likely alias-host duplicate based on URL, title, and article-text similarity.',
      });
      continue;
    }

    kept.push(story);
    seenUrls.add(normalizedUrl);
  }

  return { kept, excluded };
}

const MANUAL_RENDER_EXCLUSIONS: Array<{ url: string; reason: string }> = [
  { url: 'https://www.heraldscotland.com/news/26025413.alan-cummings-new-mission-reinventing-scottish-theatre/?ref=rss', reason: 'Figurative usage ("cult Scottish material"/"cult BBC Scotland sitcom"), not cult-reporting journalism.' },
  { url: 'https://www.mirror.co.uk/news/uk-news/best-paperbacks-read-now-including-37030837', reason: 'Book-list lifestyle content; cult term used figuratively.' },
  { url: 'https://www.cityam.com/the-cult-of-cute-the-strange-drama-of-corporate-mascots/', reason: 'Figurative phrase: cult of cute.' },
  { url: 'https://www.vogue.com/article/casa-milana-beni-rugs-laguna-b-glassware', reason: 'Lifestyle/design piece; cult term used figuratively.' },
  { url: 'https://www.videogameschronicle.com/news/stay-tuned-it-sounds-like-cult-n64-shooter-buck-bumble-is-really-coming-back/', reason: 'Gaming news with figurative cult-classic wording.' },
  { url: 'https://www.loudersound.com/bands-artists/savoy-brown-band-history', reason: 'Music history feature with figurative cult usage.' },
  { url: 'https://www.timeout.com/london/news/this-american-cult-taco-chain-is-opening-its-first-london-restaurant-042126', reason: 'Restaurant opening; cult term used figuratively.' },
  { url: 'https://www.parkrun.org.uk/stratforduponavon/news/2026/04/18/435-dont-do-it-its-a-cult/', reason: 'Community/joke usage, not a cult-reporting story.' },
  { url: 'https://www.krone.at/4113641', reason: 'German Kult-* figurative entertainment/sports context.' },
  { url: 'https://www.nhregister.com/news/world/article/philippine-president-says-key-suspect-in-22210233.php', reason: 'General corruption/politics report; not cult-specific.' },
  { url: 'https://www.wral.com/news/ap/d9d49-philippine-president-says-key-suspect-in-corruption-scandal-has-been-arrested-in-prague/', reason: 'General corruption/politics report; not cult-specific.' },
  { url: 'https://www.hospitalityandcateringnews.com/2026/04/cult-supper-club-concept-all-roads-opens-permanent-site-in-brixton/', reason: 'Hospitality business story with figurative cult branding.' },
];

const MANUAL_RENDER_EXCLUSION_REASON_BY_URL = new Map(
  MANUAL_RENDER_EXCLUSIONS.map((entry) => [normalizeUrl(entry.url), entry.reason]),
);

function getManualRenderExclusionReason(draft: DraftStory): string | undefined {
  const byUrl = MANUAL_RENDER_EXCLUSION_REASON_BY_URL.get(normalizeUrl(draft.url));
  if (byUrl) {
    return byUrl;
  }

  const normalizedTitle = draft.title.toLowerCase();
  const normalizedHost = (draft.host ?? getHostname(draft.url) ?? '').toLowerCase();
  if (
    normalizedHost.includes('heraldscotland.com') &&
    normalizedTitle.includes("alan cumming’s new mission: reinventing scottish theatre")
  ) {
    return 'Figurative usage ("cult Scottish material"/"cult BBC Scotland sitcom"), not cult-reporting journalism.';
  }

  return undefined;
}

const FIGURATIVE_CULT_MARKERS = [
  'cult classic',
  'cult favourite',
  'cult favorite',
  'cult following',
  'cult status',
  'cult hit',
  'cult bbc scotland sitcom',
  'cult sitcom',
  'cult film',
  'cult movie',
  'cult tv',
  'cult show',
  'cult game',
  'cult shooter',
  'cult band',
  'cult album',
  'cult brand',
  'cult beauty',
  'cult fashion',
  'cult grocery',
  'cult restaurant',
  'cult taco',
];

const CULT_HARM_OR_RELIGIOUS_SIGNAL_TERMS = [
  'sect',
  'religious group',
  'religious sect',
  'church',
  'jehovah',
  'witness',
  'slavery',
  'modern slavery',
  'human trafficking',
  'forced marriage',
  'coercive control',
  'abuse',
  'sexual abuse',
  'rape',
  'assault',
  'arrest',
  'raided',
  'raid',
  'charged',
  'criminal',
  'prosecut',
  'court',
  'tribunal',
  'ruling',
  'investigation',
  'victim',
];

function getFigurativeCultExclusionReason(story: EnrichedStory): string | undefined {
  const haystack = `${story.title} ${story.description} ${story.articleText}`.toLowerCase();
  if (!/\bcults?\b/u.test(haystack)) {
    return undefined;
  }

  if (CULT_HARM_OR_RELIGIOUS_SIGNAL_TERMS.some((term) => haystack.includes(term))) {
    return undefined;
  }

  if (!FIGURATIVE_CULT_MARKERS.some((term) => haystack.includes(term))) {
    return undefined;
  }

  return 'Figurative usage of "cult" in benign entertainment/lifestyle context.';
}

function summarizeExclusions(excluded: Array<{ url: string; reason: string }>): void {
  if (excluded.length === 0) {
    return;
  }

  const counts = new Map<string, number>();
  for (const item of excluded) {
    counts.set(item.reason, (counts.get(item.reason) ?? 0) + 1);
  }

  console.log(`[agent] excluded ${excluded.length} stories from digest`);
  for (const [reason, count] of counts.entries()) {
    console.log(`[agent]   - ${reason}: ${count}`);
  }
}

function renderCard(story: EnrichedStory) {
  const hostname = story.host || new URL(story.url).hostname.replace(/^www\./, '');
  const logo = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostname)}&sz=64`;
  return (
    <article className="card">
      {story.image ? (
        <img src={story.image} alt={story.title} className="story-image" loading="lazy" />
      ) : (
        <div className="story-image fallback">No image found</div>
      )}
      <div className="card-body">
        <div className="publisher-row">
          <img src={logo} alt={`${hostname} logo`} className="logo" loading="lazy" />
          <span className="publisher">{hostname}</span>
          <span className="dot">•</span>
          <span className="published">{formatPublishedAt(story.publishedAt)}</span>
        </div>
        <h2>
          <a href={story.url} target="_blank" rel="noopener noreferrer">
            {story.title}
          </a>
        </h2>
        <p>{story.description || 'No abstract available.'}</p>
        <a className="read" href={story.url} target="_blank" rel="noopener noreferrer">
          Read full story
        </a>
      </div>
    </article>
  );
}

function buildPage(groups: StoryGroup[], totalCount: number, generatedAt: string) {
  const hasStories = totalCount > 0;

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Cult News Digest</title>
        <style>{`
          :root {
            --bg: #f4f2ea;
            --ink: #222018;
            --accent: #b22d20;
            --card: #fffdfa;
            --line: #ded6c4;
          }
          * { box-sizing: border-box; }
          body {
            margin: 0;
            font-family: Georgia, "Times New Roman", serif;
            color: var(--ink);
            background: radial-gradient(circle at top right, #fff7df 0%, var(--bg) 45%);
          }
          .wrap {
            max-width: 1040px;
            margin: 0 auto;
            padding: 28px 18px 44px;
          }
          header h1 {
            margin: 0;
            font-size: clamp(1.8rem, 2.4vw, 2.6rem);
            letter-spacing: 0.02em;
          }
          header p {
            margin: 8px 0 18px;
            color: #4a463d;
          }
          .story-group {
            margin-bottom: 36px;
          }
          .group-header {
            display: flex;
            align-items: baseline;
            gap: 10px;
            margin: 0 0 12px;
            padding-bottom: 8px;
            border-bottom: 2px solid var(--line);
          }
          .group-label {
            margin: 0;
            font-size: 1.1rem;
            font-weight: 700;
            letter-spacing: 0.01em;
          }
          .group-badge {
            font-size: 0.75rem;
            font-family: system-ui, sans-serif;
            font-weight: 600;
            letter-spacing: 0.05em;
            text-transform: uppercase;
            padding: 2px 7px;
            border-radius: 4px;
          }
          .group-badge.detected {
            background: #e8e0f4;
            color: #4a2e8a;
          }
          .group-badge.independent {
            background: #dff0e8;
            color: #1a5c38;
          }
          .group-count {
            font-size: 0.85rem;
            color: #756f63;
            font-family: system-ui, sans-serif;
          }
          .grid {
            display: grid;
            gap: 14px;
            grid-template-columns: repeat(auto-fit, minmax(290px, 1fr));
          }
          .empty-state {
            grid-column: 1 / -1;
            background: var(--card);
            border: 1px solid var(--line);
            border-radius: 14px;
            padding: 24px;
            box-shadow: 0 8px 24px rgba(0,0,0,0.07);
          }
          .empty-state h2 { margin-top: 0; }
          .card {
            background: var(--card);
            border: 1px solid var(--line);
            border-radius: 14px;
            overflow: hidden;
            box-shadow: 0 8px 24px rgba(0,0,0,0.07);
            display: flex;
            flex-direction: column;
            min-height: 420px;
          }
          .story-image {
            width: 100%;
            aspect-ratio: 16 / 9;
            object-fit: cover;
            background: #e9e2d6;
          }
          .story-image.fallback {
            display: grid;
            place-items: center;
            color: #756f63;
            font-size: 0.95rem;
          }
          .card-body { padding: 14px 14px 16px; }
          .publisher-row {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 0.84rem;
            color: #5c5548;
            flex-wrap: wrap;
          }
          .logo {
            width: 18px;
            height: 18px;
            border-radius: 3px;
          }
          h2 {
            margin: 10px 0 8px;
            font-size: 1.15rem;
            line-height: 1.28;
          }
          h2 a {
            color: var(--ink);
            text-decoration: none;
          }
          h2 a:hover { color: var(--accent); }
          p {
            margin: 0;
            line-height: 1.45;
            color: #39352d;
          }
          .read {
            margin-top: 12px;
            display: inline-block;
            color: var(--accent);
            font-weight: 600;
            text-decoration: none;
          }
        `}</style>
      </head>
      <body>
        <main className="wrap">
          <header>
            <h1>Cult News Digest</h1>
            <p>Generated from latest agent run. {totalCount} shortlisted stories. Generated at {generatedAt}.</p>
          </header>
          {hasStories ? (
            groups.map((group) => (
              <div className="story-group">
                <div className="group-header">
                  <h3 className="group-label">{group.label}</h3>
                  <span className={`group-badge ${group.type}`}>
                    {group.type === 'detected' ? 'Detected Cluster' : 'Independent'}
                  </span>
                  <span className="group-count">{group.stories.length} {group.stories.length === 1 ? 'article' : 'articles'}</span>
                </div>
                <div className="grid">
                  {group.stories.map((story) => renderCard(story))}
                </div>
              </div>
            ))
          ) : (
            <div className="story-group">
              <div className="grid">
                <article className="empty-state">
                  <h2>No stories passed the cult precision filter</h2>
                  <p>
                    The latest run completed successfully, but every candidate was rejected or failed fetch-level
                    validation.
                  </p>
                </article>
              </div>
            </div>
          )}
        </main>
      </body>
    </html>
  );
}

type DetectedGroup = {
  label: string;
  storyIndexes: Set<number>;
};

type StopwordsByLanguage = Record<string, string[]>;

type StoryFeatures = {
  index: number;
  language: string;
  anchorTerms: Set<string>;
  termCounts: Map<string, number>;
};

const CLUSTER_LABEL_EXCLUDED_TERMS = new Set([
  'cult', 'cults', 'sect', 'sects', 'news', 'review', 'drama', 'thriller',
  'story', 'stories', 'series', 'episode', 'episodes',
]);

const GROUP_STOPWORDS_BY_LANGUAGE: StopwordsByLanguage = (() => {
  const byLang = loadGroupStopwordsByLanguageFromDiscoveryLangFiles();
  return Object.fromEntries(
    Object.entries(byLang).map(([lang, terms]) => [lang, terms.map((value) => value.toLowerCase())]),
  );
})();

function tokenize(value: string, stopwords: Set<string>): string[] {
  function normalizeToken(token: string): string {
    // Collapse common possessive/plural headline variants: "unchosens" -> "unchosen".
    if (token.length > 5 && token.endsWith('s') && !token.endsWith('ss')) {
      return token.slice(0, -1);
    }
    return token;
  }

  return value
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 3)
    .map((token) => normalizeToken(token))
    .filter((token) => token.length >= 3)
    .filter((token) => !stopwords.has(token));
}

function toTitleCase(value: string): string {
  return value
    .split(' ')
    .map((word) => (word ? word[0]!.toUpperCase() + word.slice(1) : word))
    .join(' ');
}

function buildStopwordSet(language: string): Set<string> {
  const english = GROUP_STOPWORDS_BY_LANGUAGE.en ?? [];
  const local = GROUP_STOPWORDS_BY_LANGUAGE[language] ?? [];
  return new Set([...english, ...local]);
}

function detectStoryLanguage(story: EnrichedStory): string {
  const sample = `${story.title} ${story.description ?? ''}`.slice(0, 1000);
  const detected = detectLanguage(sample);
  return detected || 'en';
}

function addTokens(termCounts: Map<string, number>, tokens: string[], weight: number): void {
  for (const token of tokens) {
    termCounts.set(token, (termCounts.get(token) ?? 0) + weight);
  }
}

function addNgrams(termCounts: Map<string, number>, tokens: string[], n: number, weight: number): void {
  for (let i = 0; i <= tokens.length - n; i += 1) {
    const gram = tokens.slice(i, i + n).join(' ');
    termCounts.set(gram, (termCounts.get(gram) ?? 0) + weight);
  }
}

function buildStoryFeatures(stories: EnrichedStory[]): StoryFeatures[] {
  return stories.map((story, index) => {
    const language = detectStoryLanguage(story);
    const stopwords = buildStopwordSet(language);
    const termCounts = new Map<string, number>();

    const titleTokens = tokenize(story.title, stopwords);
    const descriptionTokens = tokenize(story.description ?? '', stopwords);
    const slugTokens = tokenize(getSlug(story.url) ?? '', stopwords);
    const articleTokens = tokenize(story.articleText ?? '', stopwords).slice(0, 500);

    addTokens(termCounts, titleTokens, 3);
    addTokens(termCounts, slugTokens, 2);
    addTokens(termCounts, descriptionTokens, 1);
    addTokens(termCounts, articleTokens, 0.4);

    addNgrams(termCounts, titleTokens, 2, 2);
    addNgrams(termCounts, titleTokens, 3, 1);
    addNgrams(termCounts, descriptionTokens, 2, 1.3);
    addNgrams(termCounts, descriptionTokens, 3, 0.9);
    addNgrams(termCounts, articleTokens, 2, 0.3);

    const anchorTerms = new Set<string>([
      ...titleTokens,
      ...slugTokens,
      ...descriptionTokens,
      ...titleTokens.flatMap((_, i, list) => (i < list.length - 1 ? [list.slice(i, i + 2).join(' ')] : [])),
      ...descriptionTokens.flatMap((_, i, list) => (i < list.length - 1 ? [list.slice(i, i + 2).join(' ')] : [])),
    ]);

    return { index, language, anchorTerms, termCounts };
  });
}

function buildIdf(features: StoryFeatures[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const feature of features) {
    for (const term of feature.termCounts.keys()) {
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  }

  const idf = new Map<string, number>();
  const total = features.length;
  for (const [term, frequency] of df.entries()) {
    idf.set(term, Math.log((total + 1) / (frequency + 1)) + 1);
  }

  return idf;
}

function cosineSimilarity(a: StoryFeatures, b: StoryFeatures, idf: Map<string, number>): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (const [term, countA] of a.termCounts.entries()) {
    const weight = idf.get(term) ?? 1;
    const wa = countA * weight;
    normA += wa * wa;

    const countB = b.termCounts.get(term);
    if (countB) {
      dot += wa * (countB * weight);
    }
  }

  for (const [term, countB] of b.termCounts.entries()) {
    const weight = idf.get(term) ?? 1;
    const wb = countB * weight;
    normB += wb * wb;
  }

  if (normA === 0 || normB === 0) {
    return 0;
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function countSharedRareAnchorTerms(a: StoryFeatures, b: StoryFeatures, idf: Map<string, number>): number {
  let shared = 0;
  for (const term of a.anchorTerms) {
    if (!b.anchorTerms.has(term)) {
      continue;
    }
    if ((idf.get(term) ?? 0) < 1.45) {
      continue;
    }
    if (term.length < 5) {
      continue;
    }
    shared += 1;
  }

  return shared;
}

function buildAdjacency(features: StoryFeatures[], idf: Map<string, number>): Map<number, Set<number>> {
  const edges = new Map<number, Set<number>>();
  const strictThreshold = 0.24;
  const relaxedThreshold = 0.10;

  for (let i = 0; i < features.length; i += 1) {
    for (let j = i + 1; j < features.length; j += 1) {
      const similarity = cosineSimilarity(features[i], features[j], idf);
      const sharedRareAnchorTerms = countSharedRareAnchorTerms(features[i], features[j], idf);
      const shouldLink =
        similarity >= strictThreshold ||
        sharedRareAnchorTerms >= 2 ||
        (similarity >= relaxedThreshold && sharedRareAnchorTerms >= 1);

      if (!shouldLink) {
        continue;
      }

      const left = edges.get(i) ?? new Set<number>();
      const right = edges.get(j) ?? new Set<number>();
      left.add(j);
      right.add(i);
      edges.set(i, left);
      edges.set(j, right);
    }
  }

  return edges;
}

function selectGroupLabel(features: StoryFeatures[], storyIndexes: number[], idf: Map<string, number>): string {
  const scoreByTerm = new Map<string, number>();
  const seenByTerm = new Map<string, number>();

  for (const idx of storyIndexes) {
    const feature = features[idx];
    if (!feature) continue;

    const seenInStory = new Set<string>();
    for (const [term, score] of feature.termCounts.entries()) {
      if (term.length < 4) continue;
      if (/^\d+$/u.test(term)) continue;
      if (CLUSTER_LABEL_EXCLUDED_TERMS.has(term)) continue;

      const weighted = score * (idf.get(term) ?? 1);
      scoreByTerm.set(term, (scoreByTerm.get(term) ?? 0) + weighted);
      seenInStory.add(term);
    }

    for (const term of seenInStory) {
      seenByTerm.set(term, (seenByTerm.get(term) ?? 0) + 1);
    }
  }

  const minimumCoverage = Math.max(2, Math.ceil(storyIndexes.length * 0.5));
  const candidates = Array.from(scoreByTerm.entries())
    .filter(([term]) => (seenByTerm.get(term) ?? 0) >= minimumCoverage)
    .sort((a, b) => b[1] - a[1])
    .map(([term]) => term);

  const top = candidates.slice(0, 2);
  if (top.length === 0) {
    return 'Detected Cluster';
  }

  return toTitleCase(top.join(' '));
}

function detectStoryClusters(stories: EnrichedStory[]): DetectedGroup[] {
  const features = buildStoryFeatures(stories);
  const idf = buildIdf(features);
  const edges = buildAdjacency(features, idf);
  const visited = new Set<number>();
  const groups: DetectedGroup[] = [];

  for (let i = 0; i < features.length; i += 1) {
    if (visited.has(i)) continue;

    const queue: number[] = [i];
    const component: number[] = [];
    visited.add(i);

    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) continue;
      component.push(current);

      const neighbors = edges.get(current) ?? new Set<number>();
      for (const next of neighbors) {
        if (visited.has(next)) continue;
        visited.add(next);
        queue.push(next);
      }
    }

    if (component.length < 2) {
      continue;
    }

    groups.push({
      label: selectGroupLabel(features, component, idf),
      storyIndexes: new Set(component),
    });
  }

  groups.sort((a, b) => b.storyIndexes.size - a.storyIndexes.size);
  return groups;
}

function classifyStories(stories: EnrichedStory[]): StoryGroup[] {
  const detectedGroups = detectStoryClusters(stories);
  const groupedIndexes = new Set<number>();
  const result: StoryGroup[] = [];

  for (const group of detectedGroups) {
    const groupedStories = Array.from(group.storyIndexes)
      .map((idx) => stories[idx])
      .filter((story): story is EnrichedStory => Boolean(story));

    if (groupedStories.length < 2) {
      continue;
    }

    result.push({
      label: group.label,
      type: 'detected',
      stories: groupedStories,
    });

    for (const idx of group.storyIndexes) {
      groupedIndexes.add(idx);
    }
  }

  const ungrouped = stories.filter((_, idx) => !groupedIndexes.has(idx));
  if (ungrouped.length > 0) {
    result.push({ label: 'Independent Journalism', type: 'independent', stories: ungrouped });
  }

  return result;
}

async function main(): Promise<void> {
  const logText = readFileSync(LOG_PATH, 'utf-8');
  const rawDrafts = extractDraftsFromLog(logText);
  const summary = extractRunSummary(logText);

  // Canonicalize known mirror URLs so dedupe collapses wrapped-source duplicates.
  const canonicalDrafts = rawDrafts.map((draft) => {
    const canonicalUrl = canonicalizeStoryUrl(draft.url);
    const canonicalHost = (() => {
      try {
        return new URL(canonicalUrl).hostname.replace(/^www\./, '');
      } catch {
        return draft.host;
      }
    })();

    return {
      ...draft,
      url: canonicalUrl,
      host: canonicalHost,
    };
  });

  const excluded: Array<{ url: string; reason: string }> = [];
  const eligibleDrafts = canonicalDrafts.filter((draft) => {
    const reason = getManualRenderExclusionReason(draft);
    if (!reason) {
      return true;
    }

    excluded.push({ url: draft.url, reason });
    return false;
  });

  const nonCultnewsSlugs = new Set<string>(
    eligibleDrafts
      .filter((draft) => getHostname(draft.url) !== 'cultnews.net')
      .map((draft) => getSlug(draft.url))
      .filter((slug): slug is string => Boolean(slug))
  );

  const drafts = eligibleDrafts.filter((draft) => {

    const draftHost = getHostname(draft.url);
    const draftSlug = getSlug(draft.url);
    if (draftHost === 'cultnews.net' && draftSlug && nonCultnewsSlugs.has(draftSlug)) {
      excluded.push({
        url: draft.url,
        reason: 'Cultnews mirror duplicate of a non-cultnews story slug.',
      });
      return false;
    }

    return true;
  });

  const fetchedStories: EnrichedStory[] = [];
  for (const draft of drafts) {
    const meta = await fetchStoryMeta(draft.url);
    fetchedStories.push({
      ...draft,
      title: meta.title?.trim() || draft.title,
      description: meta.description?.trim() || '',
      image: meta.image,
      publishedAt: meta.publishedAt || draft.publishedAt,
      articleText: meta.articleText?.trim() || '',
    });
  }

  const figurativeFilteredStories = fetchedStories.filter((story) => {
    const reason = getFigurativeCultExclusionReason(story);
    if (!reason) {
      return true;
    }

    excluded.push({ url: story.url, reason });
    return false;
  });

  const dedupeResult = dedupeStories(figurativeFilteredStories);
  excluded.push(...dedupeResult.excluded);
  summarizeExclusions(excluded);

  const stories = dedupeResult.kept;

  const groups = classifyStories(stories);

  const html = renderDocument(buildPage(groups, stories.length, new Date().toISOString()));
  mkdirSync(new URL('../reports/', import.meta.url), { recursive: true });
  writeFileSync(OUTPUT_PATH, html, 'utf-8');

  if (summary) {
    console.log(`[agent] wrote ${stories.length} stories to ${OUTPUT_PATH.pathname} from ${summary.processed ?? 0} processed candidates`);
  } else {
    console.log(`[agent] wrote ${stories.length} stories to ${OUTPUT_PATH.pathname}`);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error('[agent] failed to render html digest', { message });
  process.exitCode = 1;
});
