/// <reference types="node" />
/* @jsxRuntime classic */
/** @jsx h */
/** @jsxFrag Fragment */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { detect as detectLanguage } from 'tinyld';
import { loadGroupStopwordsByLanguageFromDiscoveryLangFiles } from '../src/discoveryLangGroupStopwords.js';
import {
  getReligiousGroupTermsForLanguage,
  getCoerciveHarmTermsForLanguage,
} from '../src/pipelineTerms.js';
import { getCultTermsForLanguage } from '../src/cultTerms.js';
import { hasFigurativeCultUsage } from '../src/pipeline.js';
import {
  Fragment,
  DRAFTS_ARCHIVE_PATH,
  DRAFTS_PATH,
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

type RawDraftShape = {
  title?: unknown;
  source?: { url?: unknown; host?: unknown; publishedAt?: unknown };
};

function mapRawDraft(draft: RawDraftShape): DraftStory | null {
  const title = typeof draft.title === 'string' ? draft.title : '';
  const url = typeof draft.source?.url === 'string' ? draft.source.url : '';
  if (!title || !url) return null;
  return {
    title,
    url,
    host: typeof draft.source?.host === 'string' ? draft.source.host : undefined,
    publishedAt: typeof draft.source?.publishedAt === 'string' ? draft.source.publishedAt : undefined,
  };
}

function loadDraftsFromArchive(): DraftStory[] | undefined {
  if (!existsSync(DRAFTS_ARCHIVE_PATH)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(DRAFTS_ARCHIVE_PATH, 'utf-8')) as {
      entries?: Array<{ draft?: RawDraftShape }>;
    };
    if (!Array.isArray(parsed.entries)) return undefined;
    return parsed.entries
      .map((e) => (e.draft ? mapRawDraft(e.draft) : null))
      .filter((d): d is DraftStory => d !== null);
  } catch {
    return undefined;
  }
}

function loadDraftsFromJson(): DraftStory[] | undefined {
  if (!existsSync(DRAFTS_PATH)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(DRAFTS_PATH, 'utf-8')) as {
      drafts?: Array<RawDraftShape>;
    };
    if (!Array.isArray(parsed.drafts)) return undefined;
    return parsed.drafts
      .map(mapRawDraft)
      .filter((d): d is DraftStory => d !== null);
  } catch {
    return undefined;
  }
}

const RENDER_MAX_AGE_HOURS = (() => {
  const raw = process.env.CULT_NEWS_RENDER_MAX_AGE_HOURS?.trim() || process.env.DISCOVERY_MAX_AGE_HOURS?.trim();
  if (!raw) {
    return undefined;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error('CULT_NEWS_RENDER_MAX_AGE_HOURS or DISCOVERY_MAX_AGE_HOURS must be a positive integer');
  }

  return parsed;
})();

function normalizeHost(host: string): string {
  return host.replace(/^www\./i, '').toLowerCase();
}

function isWithinRenderFreshnessWindow(publishedAt: string | undefined): boolean {
  if (RENDER_MAX_AGE_HOURS === undefined || !publishedAt) {
    return true;
  }

  const publishedAtEpochMs = Date.parse(publishedAt);
  if (!Number.isFinite(publishedAtEpochMs)) {
    return false;
  }

  const ageMs = Date.now() - publishedAtEpochMs;
  if (ageMs < 0) {
    return true;
  }

  return ageMs <= RENDER_MAX_AGE_HOURS * 60 * 60 * 1000;
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

function getFigurativeCultExclusionReason(story: EnrichedStory, language: string): string | undefined {
  const haystack = `${story.title} ${story.description} ${story.articleText}`.toLowerCase();
  const cultTerms = getCultTermsForLanguage(language);
  const hasCultTerm = cultTerms.some((term) => haystack.includes(term.toLowerCase()));
  if (!hasCultTerm) {
    return undefined;
  }

  const religiousGroupTerms = getReligiousGroupTermsForLanguage(language);
  const coerciveHarmTerms = getCoerciveHarmTermsForLanguage(language);
  if (
    religiousGroupTerms.some((term) => haystack.includes(term.toLowerCase())) ||
    coerciveHarmTerms.some((term) => haystack.includes(term.toLowerCase()))
  ) {
    return undefined;
  }

  if (!hasFigurativeCultUsage(haystack, language)) {
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

function renderCard(story: EnrichedStory, language?: string) {
  const hostname = story.host || new URL(story.url).hostname.replace(/^www\./, '');
  const logo = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostname)}&sz=64`;
  const isNonEnglish = language && language !== 'en';
  const escapedUrl = story.url.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const escapedTitle = story.title.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  return (
    <article className="card" data-url={story.url}>
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
          {isNonEnglish ? <span className="lang-tag">{language}</span> : null}
        </div>
        <h2 {...(isNonEnglish ? { lang: language } : {})}>
          <a href={story.url} target="_blank" rel="noopener noreferrer">
            {story.title}
          </a>
        </h2>
        <p {...(isNonEnglish ? { lang: language } : {})}>{story.description || 'No abstract available.'}</p>
        <div className="feedback-row">
          <a className="read" href={story.url} target="_blank" rel="noopener noreferrer">Read full story</a>
          <button
            className="fb-btn"
            data-fb-url={escapedUrl}
            data-fb-title={escapedTitle}
            data-fb-reason="false-positive"
            onclick="window._fbClick(this)"
          >🚫 False positive</button>
          <button
            className="fb-btn"
            data-fb-url={escapedUrl}
            data-fb-title={escapedTitle}
            data-fb-reason="wrong-cluster"
            onclick="window._fbClick(this)"
          >⚠️ Wrong cluster</button>
        </div>
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
          .lang-tag {
            font-size: 0.72rem;
            font-family: system-ui, sans-serif;
            font-weight: 600;
            letter-spacing: 0.06em;
            text-transform: uppercase;
            padding: 1px 5px;
            border-radius: 3px;
            background: #e8e4d8;
            color: #6b6355;
          }
          .latest-heading {
            margin: 28px 0 14px;
            font-size: 1rem;
            font-weight: 700;
            letter-spacing: 0.04em;
            text-transform: uppercase;
            color: #756f63;
            font-family: system-ui, sans-serif;
            border-top: 2px solid var(--line);
            padding-top: 18px;
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
          .feedback-row {
            display: flex;
            gap: 6px;
            margin-top: 10px;
            flex-wrap: wrap;
          }
          .fb-btn {
            font-size: 0.72rem;
            font-family: system-ui, sans-serif;
            font-weight: 600;
            padding: 3px 9px;
            border-radius: 5px;
            border: 1px solid var(--line);
            background: #f4f2ea;
            color: #5c5548;
            cursor: pointer;
            transition: background 0.15s, color 0.15s;
          }
          .fb-btn:hover { background: #e8e0d0; }
          .fb-btn.copied { background: #d4edda; color: #1a5c38; border-color: #a3d3b0; }
          .card.flagged-fp { opacity: 0.45; border-color: #e57373; }
          .card.flagged-wc { opacity: 0.55; border-color: #f9a825; }
          #fb-toast {
            position: fixed; bottom: 22px; right: 22px;
            background: #222; color: #fff;
            font-family: system-ui, sans-serif; font-size: 0.82rem;
            padding: 8px 16px; border-radius: 8px;
            opacity: 0; pointer-events: none;
            transition: opacity 0.2s;
            z-index: 9999;
          }
          #fb-toast.show { opacity: 1; }
        `}</style>
      </head>
      <body>
        <main className="wrap">
          <header>
            <h1>Cult News Digest</h1>
            <p>Generated from latest agent run. {totalCount} shortlisted stories. Generated at {generatedAt}.</p>
            <button id="export-fb-btn" onclick="window._fbExport()" style="font-family:system-ui,sans-serif;font-size:0.8rem;font-weight:600;padding:5px 12px;border-radius:6px;border:1px solid #ded6c4;background:#f4f2ea;color:#5c5548;cursor:pointer;margin-bottom:8px;">📋 Export all feedback to clipboard</button>
            <span id="export-fb-status" style="font-family:system-ui,sans-serif;font-size:0.8rem;color:#1a5c38;margin-left:8px;display:none;">✓ Copied! Paste into data/feedback/false-positives.json → entries array</span>
          </header>
          {hasStories ? (
            groups.map((group) => (
              group.type === 'independent' ? (
                <div className="story-group">
                  <p className="latest-heading">Latest Stories</p>
                  <div className="grid">
                    {group.stories.map((story) => renderCard(story, detectStoryLanguage(story)))}
                  </div>
                </div>
              ) : (
                <div className="story-group">
                  <div className="group-header">
                    <h3 className="group-label">{group.label}</h3>
                    <span className={`group-badge ${group.type}`}>Cluster</span>
                    <span className="group-count">{group.stories.length} {group.stories.length === 1 ? 'article' : 'articles'}</span>
                  </div>
                  <div className="grid">
                    {group.stories.map((story) => renderCard(story, detectStoryLanguage(story)))}
                  </div>
                </div>
              )
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
      <div id="fb-toast">Copied to clipboard — paste into data/feedback/false-positives.json</div>
      <script dangerouslySetInnerHTML={{ __html: `
var FB_KEY = 'cult-news-feedback';

function _fbLoad() {
  var stored = {};
  try { stored = JSON.parse(localStorage.getItem(FB_KEY) || '{}'); } catch(e) {}
  document.querySelectorAll('.card[data-url]').forEach(function(card) {
    var url = card.getAttribute('data-url');
    var entry = stored[url];
    if (!entry) return;
    card.classList.add(entry.reason === 'false-positive' ? 'flagged-fp' : 'flagged-wc');
    card.querySelectorAll('.fb-btn').forEach(function(btn) {
      if (btn.getAttribute('data-fb-reason') === entry.reason) {
        btn.classList.add('copied');
        btn.textContent = entry.reason === 'false-positive' ? '🚫 Flagged' : '⚠️ Flagged';
      }
    });
  });
}

window._fbClick = function(btn) {
  var url = btn.getAttribute('data-fb-url');
  var title = btn.getAttribute('data-fb-title');
  var reason = btn.getAttribute('data-fb-reason');
  var entry = {url: url, title: title, reason: reason, flaggedAt: new Date().toISOString()};
  var stored = {};
  try { stored = JSON.parse(localStorage.getItem(FB_KEY) || '{}'); } catch(e) {}
  stored[url] = entry;
  localStorage.setItem(FB_KEY, JSON.stringify(stored));
  navigator.clipboard.writeText(JSON.stringify(entry, null, 2)).then(function() {
    btn.classList.add('copied');
    btn.textContent = reason === 'false-positive' ? '🚫 Flagged' : '⚠️ Flagged';
    var card = btn.closest('.card');
    if (card) {
      card.classList.remove('flagged-fp', 'flagged-wc');
      card.classList.add(reason === 'false-positive' ? 'flagged-fp' : 'flagged-wc');
    }
    var toast = document.getElementById('fb-toast');
    toast.classList.add('show');
    setTimeout(function() { toast.classList.remove('show'); }, 2800);
  });
};

window._fbExport = function() {
  var stored = {};
  try { stored = JSON.parse(localStorage.getItem(FB_KEY) || '{}'); } catch(e) {}
  var entries = Object.values(stored);
  if (entries.length === 0) {
    alert('No feedback flagged yet.');
    return;
  }
  navigator.clipboard.writeText(JSON.stringify(entries, null, 2)).then(function() {
    var status = document.getElementById('export-fb-status');
    status.style.display = 'inline';
    setTimeout(function() { status.style.display = 'none'; }, 4000);
  });
};

document.addEventListener('DOMContentLoaded', _fbLoad);
` }} />
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

/**
 * Returns lowercased tokens that appear capitalised mid-sentence in the original text —
 * a cheap proper-noun signal. The first word of a sentence is excluded (it's always
 * capitalised) by requiring the preceding character to be a non-sentence-opening context
 * (i.e. the token must not be the very first word and must follow a space, not a period).
 */
function extractProperNounTokens(original: string, tokens: string[], stopwords: Set<string>): Set<string> {
  const result = new Set<string>();
  for (const token of tokens) {
    if (stopwords.has(token)) continue;
    if (token.length < 3) continue;
    const capitalized = token[0]!.toUpperCase() + token.slice(1);
    // Match the token when preceded by a space (not sentence-start after . or start-of-string)
    const pattern = new RegExp(`(?<=[^.!?\n])\\s+${capitalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[^a-z]|$)`, 'u');
    if (pattern.test(original)) {
      result.add(token);
    }
  }
  return result;
}

function buildStoryFeatures(stories: EnrichedStory[]): StoryFeatures[] {
  return stories.map((story, index) => {
    const language = detectStoryLanguage(story);
    const stopwords = buildStopwordSet(language);
    const termCounts = new Map<string, number>();

    const titleTokens = tokenize(story.title, stopwords);
    const descriptionTokens = tokenize(story.description ?? '', stopwords);
    const articleTokens = tokenize(story.articleText ?? '', stopwords).slice(0, 500);

    addTokens(termCounts, titleTokens, 3);
    addTokens(termCounts, descriptionTokens, 1);
    addTokens(termCounts, articleTokens, 0.4);

    addNgrams(termCounts, titleTokens, 2, 2);
    addNgrams(termCounts, titleTokens, 3, 1);
    addNgrams(termCounts, descriptionTokens, 2, 1.3);
    addNgrams(termCounts, descriptionTokens, 3, 0.9);
    addNgrams(termCounts, articleTokens, 2, 0.3);

    const titleProperNouns = extractProperNounTokens(story.title, titleTokens, stopwords);
    const descProperNouns = extractProperNounTokens(story.description ?? '', descriptionTokens, stopwords);
    const articleProperNouns = extractProperNounTokens(story.articleText ?? '', articleTokens, stopwords);
    const properNounBigrams = [
      ...Array.from(titleProperNouns).flatMap((t, _, arr) => {
        const idx = titleTokens.indexOf(t);
        if (idx < titleTokens.length - 1 && titleProperNouns.has(titleTokens[idx + 1]!)) {
          return [`${t} ${titleTokens[idx + 1]}`];
        }
        return [];
      }),
    ];

    const anchorTerms = new Set<string>([
      ...titleProperNouns,
      ...descProperNouns,
      ...articleProperNouns,
      ...properNounBigrams,
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
    if ((idf.get(term) ?? 0) < 1.8) {
      continue;
    }
    if (term.length < 4) {
      continue;
    }
    shared += 1;
  }

  return shared;
}

function buildAdjacency(features: StoryFeatures[], idf: Map<string, number>): Map<number, Set<number>> {
  const edges = new Map<number, Set<number>>();
  const strictThreshold = 0.42;
  const relaxedThreshold = 0.18;
  const anchorMinSimilarity = 0.10;

  for (let i = 0; i < features.length; i += 1) {
    for (let j = i + 1; j < features.length; j += 1) {
      const similarity = cosineSimilarity(features[i], features[j], idf);
      const sharedRareAnchorTerms = countSharedRareAnchorTerms(features[i], features[j], idf);
      const shouldLink =
        similarity >= strictThreshold ||
        (similarity >= relaxedThreshold && sharedRareAnchorTerms >= 1) ||
        (similarity >= anchorMinSimilarity && sharedRareAnchorTerms >= 2);

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

const MAX_CLUSTER_SIZE = 12;
const MIN_CLUSTER_COHERENCE = 0.20;

function isClusterCoherent(component: number[], features: StoryFeatures[], idf: Map<string, number>): boolean {
  if (component.length <= 2) return true;
  if (component.length > MAX_CLUSTER_SIZE) return false;
  let totalSim = 0;
  let pairs = 0;
  for (let i = 0; i < component.length; i += 1) {
    for (let j = i + 1; j < component.length; j += 1) {
      totalSim += cosineSimilarity(features[component[i]!], features[component[j]!], idf);
      pairs += 1;
    }
  }
  return pairs === 0 || totalSim / pairs >= MIN_CLUSTER_COHERENCE;
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

    if (!isClusterCoherent(component, features, idf)) {
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
  const archiveDrafts = loadDraftsFromArchive();
  const structuredDrafts = archiveDrafts ?? loadDraftsFromJson();
  const rawDrafts = structuredDrafts ?? extractDraftsFromLog(logText);
  if (rawDrafts.length === 0) {
    throw new Error(
      `No draft stories found. Run npm run dev first and confirm ${DRAFTS_ARCHIVE_PATH.pathname} or ${DRAFTS_PATH.pathname} exists with count > 0.`,
    );
  }
  console.log(`[render] loaded ${rawDrafts.length} drafts from ${archiveDrafts ? 'archive' : structuredDrafts ? 'last-run-drafts' : 'log'}`);
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

  const feedbackBlocklist = (() => {
    const feedbackPath = new URL('../data/feedback/false-positives.json', import.meta.url);
    try {
      const parsed = JSON.parse(readFileSync(feedbackPath, 'utf-8')) as { entries?: Array<{ url?: string; reason?: string }> };
      return new Set(
        (parsed.entries ?? [])
          .filter((e) => e.reason === 'false-positive' && typeof e.url === 'string')
          .map((e) => createDedupeKey(e.url!))
      );
    } catch {
      return new Set<string>();
    }
  })();

  const eligibleDrafts = feedbackBlocklist.size > 0
    ? canonicalDrafts.filter((draft) => {
        if (!feedbackBlocklist.has(createDedupeKey(draft.url))) return true;
        excluded.push({ url: draft.url, reason: 'Marked as false positive in feedback file.' });
        return false;
      })
    : canonicalDrafts;

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

  const freshnessFilteredStories = fetchedStories.filter((story) => {
    if (isWithinRenderFreshnessWindow(story.publishedAt)) {
      return true;
    }

    excluded.push({
      url: story.url,
      reason: `Publication time ${formatPublishedAt(story.publishedAt)} is older than ${RENDER_MAX_AGE_HOURS} hours.`,
    });
    return false;
  });

  const figurativeFilteredStories = freshnessFilteredStories.filter((story) => {
    const language = detectStoryLanguage(story);
    const reason = getFigurativeCultExclusionReason(story, language);
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
