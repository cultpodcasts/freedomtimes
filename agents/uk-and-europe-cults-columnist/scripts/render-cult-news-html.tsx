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

type DraftStory = {
  title: string;
  url: string;
  host?: string;
  publishedAt?: string;
  classificationAudit?: CultClassificationAudit;
};

type CultClassificationAudit = {
  matchedTerms: string[];
  matchLocations: string[];
  matchContexts: string[];
  classificationSource: string;
  filtersChecked: string[];
  filterResults: Record<string, { passed: boolean; reason?: string }>;
  classifiedAt: string;
};

type RawDraftShape = {
  title?: unknown;
  source?: { url?: unknown; host?: unknown; publishedAt?: unknown };
  classificationAudit?: CultClassificationAudit;
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
    classificationAudit: draft.classificationAudit,
  };
}

function loadDraftsFromArchive(): DraftStory[] | undefined {
  if (!existsSync(DRAFTS_ARCHIVE_PATH)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(DRAFTS_ARCHIVE_PATH, 'utf-8')) as
      | Array<{ draft?: RawDraftShape }>
      | { entries?: Array<{ draft?: RawDraftShape }> };
    // Handle both direct array and { entries: array } formats
    const entries = Array.isArray(parsed) ? parsed : parsed.entries;
    if (!Array.isArray(entries)) return undefined;
    const drafts = entries
      .map((e) => (e.draft ? mapRawDraft(e.draft) : null))
      .filter((d): d is DraftStory => d !== null);
    return drafts;
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
    .replace(/[""''«»„“‹›]/g, ' ') // Normalize quotes to spaces
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
  // Check for cult terms with word boundaries to avoid matching inside words like "cultural"
  const hasCultTerm = cultTerms.some((term) => {
    const t = term.toLowerCase();
    // For short terms like "cult", require word boundaries AND not followed by letters
    // This prevents matching when text is split across lines (e.g., "cult\nura" in "cultura")
    if (t.length <= 5) {
      const regex = new RegExp(`\\b${t}\\b(?![a-z])`, 'i');
      return regex.test(haystack);
    }
    return haystack.includes(t);
  });
  
  if (!hasCultTerm) {
    return undefined;
  }

  const religiousGroupTerms = getReligiousGroupTermsForLanguage(language);
  const coerciveHarmTerms = getCoerciveHarmTermsForLanguage(language);
  const hasReligiousOrCoercive = 
    religiousGroupTerms.some((term) => haystack.includes(term.toLowerCase())) ||
    coerciveHarmTerms.some((term) => haystack.includes(term.toLowerCase()));
  
  if (hasReligiousOrCoercive) {
    return undefined;
  }

  const isFigurative = hasFigurativeCultUsage(haystack, language);
  if (!isFigurative) {
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
  const escapedUrl = story.url;
  const escapedTitle = story.title;
  // Serialize classification audit for data attribute
  const hasAudit = !!story.classificationAudit;
  const auditData = hasAudit
    ? JSON.stringify(story.classificationAudit)
    : '';
  // Serialize article text for training data
  const articleTextData = story.articleText || '';
  return (
    <article className="card" data-url={story.url} data-classification-audit={auditData} data-article-text={articleTextData}>
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
          .fb-btn[data-fb-reason="wrong-cluster"] { display: none; }
          .fb-btn[data-fb-reason="false-positive"] { display: none; }
          body.review-phase .fb-btn[data-fb-reason="false-positive"] { display: inline-block; }
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
            groups.map((group) =>
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
            )
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
      <div id="fb-toast">Feedback saved</div>
      <div id="report-status" style="position: fixed; top: 10px; right: 10px; background: white; padding: 10px 15px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); font-size: 0.85rem; z-index: 1000;">
        <span id="status-text">Loading...</span>
        <button id="init-report-btn" style="margin-left: 10px; padding: 4px 8px; cursor: pointer;">Init Report</button>
        <button id="close-report-btn" style="margin-left: 5px; padding: 4px 8px; cursor: pointer; display: none;">Close Report</button>
        <button id="finalize-report-btn" style="margin-left: 5px; padding: 4px 8px; cursor: pointer; display: none;">Finalize</button>
      </div>
      <script dangerouslySetInnerHTML={{ __html: `
var FB_GENERATED_AT = '${generatedAt}';
var API_BASE = window.location.origin;
var currentReport = null;

function _fbLoad() {
  _checkReportStatus();
  _loadFeedback();
  _updateButtonVisibility();
}

async function _checkReportStatus() {
  try {
    const res = await fetch(API_BASE + '/api/report/status');
    const data = await res.json();
    currentReport = data;
    _updateStatusUI(data);
  } catch(e) {
    console.error('Failed to check report status:', e);
    document.getElementById('status-text').textContent = 'Error checking status';
  }
}

function _updateStatusUI(data) {
  const statusText = document.getElementById('status-text');
  const initBtn = document.getElementById('init-report-btn');
  const closeBtn = document.getElementById('close-report-btn');
  const finalizeBtn = document.getElementById('finalize-report-btn');

  document.body.classList.remove('review-phase', 'verification-phase');

  if (data.status === 'none') {
    statusText.textContent = 'No active report';
    initBtn.style.display = 'inline';
    closeBtn.style.display = 'none';
    finalizeBtn.style.display = 'none';
  } else if (data.status === 'review') {
    statusText.textContent = 'Review phase (' + data.entryCount + ' flagged)';
    initBtn.style.display = 'none';
    closeBtn.style.display = 'inline';
    finalizeBtn.style.display = 'none';
    document.body.classList.add('review-phase');
  } else if (data.status === 'verification') {
    statusText.textContent = 'Clusters updated — ' + (data.entryCount || 0) + ' false-positives excluded. Finalize or start new review.';
    initBtn.style.display = 'inline';
    closeBtn.style.display = 'none';
    finalizeBtn.style.display = 'inline';
    document.body.classList.add('verification-phase');
  }
  _updateButtonVisibility();
}

async function _loadFeedback() {
  try {
    const res = await fetch(API_BASE + '/api/feedback');
    const data = await res.json();
    data.entries.forEach(function(entry) {
      var card = document.querySelector('.card[data-url="' + entry.url + '"]');
      if (!card) return;
      card.classList.add(entry.reason === 'false-positive' ? 'flagged-fp' : 'flagged-wc');
      card.querySelectorAll('.fb-btn').forEach(function(btn) {
        if (btn.getAttribute('data-fb-reason') === entry.reason) {
          btn.classList.add('copied');
          btn.textContent = entry.reason === 'false-positive' ? '🚫 Flagged' : '⚠️ Flagged';
        }
      });
    });
  } catch(e) {
    console.error('Failed to load feedback:', e);
  }
}

function _updateButtonVisibility() {
  var wrongClusterBtns = document.querySelectorAll('.fb-btn[data-fb-reason="wrong-cluster"]');
  wrongClusterBtns.forEach(function(btn) {
    if (currentReport && currentReport.status === 'verification') {
      btn.style.display = 'inline-block';
    } else {
      btn.style.display = 'none';
    }
  });
}

window._fbClick = async function(btn) {
  if (!currentReport || currentReport.status !== 'review') {
    alert('Please initialize a report first');
    return;
  }

  var url = btn.getAttribute('data-fb-url');
  var title = btn.getAttribute('data-fb-title');
  var reason = btn.getAttribute('data-fb-reason');
  var card = btn.closest('.card');
  var auditJson = card ? card.getAttribute('data-classification-audit') : null;
  var classificationAudit = null;
  if (auditJson) {
    try { classificationAudit = JSON.parse(auditJson); } catch(e) {}
  }
  var articleText = card ? card.getAttribute('data-article-text') : null;

  // Check if already marked - if so, unmark instead
  var isMarked = card && (card.classList.contains('flagged-fp') || card.classList.contains('flagged-wc'));
  if (isMarked) {
    try {
      const res = await fetch(API_BASE + '/api/feedback/unmark', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url })
      });
      const data = await res.json();
      if (data.success) {
        btn.classList.remove('copied');
        btn.textContent = reason === 'false-positive' ? '🚫 False positive' : '⚠️ Wrong cluster';
        if (card) {
          card.classList.remove('flagged-fp', 'flagged-wc');
        }
        _checkReportStatus();
      }
    } catch(e) {
      console.error('Failed to unmark:', e);
      alert('Failed to unmark');
    }
    return;
  }

  // Mark as false-positive
  try {
    const res = await fetch(API_BASE + '/api/feedback/false-positive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: url,
        title: title,
        articleText: articleText,
        classificationAudit: classificationAudit
      })
    });
    const data = await res.json();
    if (data.success) {
      btn.classList.add('copied');
      btn.textContent = '� Flagged';
      if (card) {
        card.classList.remove('flagged-fp', 'flagged-wc');
        card.classList.add('flagged-fp');
      }
      var toast = document.getElementById('fb-toast');
      toast.classList.add('show');
      setTimeout(function() { toast.classList.remove('show'); }, 2000);
      _checkReportStatus();
    }
  } catch(e) {
    console.error('Failed to save feedback:', e);
    alert('Failed to save feedback');
  }
};

document.getElementById('init-report-btn').addEventListener('click', async function() {
  try {
    const res = await fetch(API_BASE + '/api/report/init', { method: 'POST' });
    const data = await res.json();
    if (data.reportId) {
      _checkReportStatus();
    }
  } catch(e) {
    console.error('Failed to init report:', e);
    alert('Failed to initialize report');
  }
});

document.getElementById('close-report-btn').addEventListener('click', async function() {
  if (!confirm('Close the false-positive review? The page will reload with updated clusters.')) return;
  const btn = this;
  btn.disabled = true;
  btn.textContent = 'Re-clustering…';
  try {
    const res = await fetch(API_BASE + '/api/report/close', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      window.location.reload();
    }
  } catch(e) {
    console.error('Failed to close report:', e);
    alert('Failed to close report');
    btn.disabled = false;
    btn.textContent = 'Close Report';
  }
});

document.getElementById('finalize-report-btn').addEventListener('click', async function() {
  if (!confirm('Finalize report? This will archive feedback and export to training data.')) return;
  try {
    const res = await fetch(API_BASE + '/api/report/finalize', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      alert('Report finalized: ' + data.archivedReportId);
      _checkReportStatus();
    }
  } catch(e) {
    console.error('Failed to finalize report:', e);
    alert('Failed to finalize report');
  }
});

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
  quotedPhraseTerms: Set<string>;
  termCounts: Map<string, number>;
};

import type { SubjectAlias } from '../src/pipelineTerms.js';

const SUBJECT_ALIASES: SubjectAlias[] = (() => {
  try {
    const p = new URL('../data/subject-aliases.json', import.meta.url);
    return JSON.parse(readFileSync(p, 'utf-8')) as SubjectAlias[];
  } catch {
    return [];
  }
})();

function injectEntityAliases(
  text: string,
  storyLanguage: string,
  termCounts: Map<string, number>,
  anchorTerms: Set<string>,
  weight: number,
): void {
  const lower = text.toLowerCase();
  for (const { canonical, aliases } of SUBJECT_ALIASES) {
    // Check canonical first
    if (lower.includes(canonical.toLowerCase())) {
      termCounts.set(canonical, (termCounts.get(canonical) ?? 0) + weight);
      anchorTerms.add(canonical);
      continue;
    }
    // Then check language-specific aliases
    for (const alias of aliases) {
      if (alias.lang && alias.lang !== storyLanguage) continue;
      if (lower.includes(alias.text)) {
        termCounts.set(canonical, (termCounts.get(canonical) ?? 0) + weight);
        anchorTerms.add(canonical);
        break;
      }
    }
  }
}

const GROUP_STOPWORDS_BY_LANGUAGE: StopwordsByLanguage = (() => {
  const byLang = loadGroupStopwordsByLanguageFromDiscoveryLangFiles();
  return Object.fromEntries(
    Object.entries(byLang).map(([lang, terms]) => [lang, terms.map((value) => value.toLowerCase())]),
  );
})();

function tokenize(value: string, stopwords: Set<string>): string[] {
  function stemOnce(token: string): string {
    // Strip plural/possessive: "speedrunnings" -> "speedrunning", "unchosens" -> "unchosen"
    if (token.length > 5 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
    // Strip gerund -ing, then collapse doubled terminal consonant: "speedrunning" -> "speedrunn" -> "speedrun"
    if (token.length > 6 && token.endsWith('ing') && !token.endsWith('ring') && !token.endsWith('king')) {
      const stem = token.slice(0, -3);
      // Collapse doubled terminal consonant (running->run,anning->ann->an handled next iter)
      if (stem.length >= 2 && stem[stem.length - 1] === stem[stem.length - 2]) {
        return stem.slice(0, -1);
      }
      return stem;
    }
    return token;
  }
  function normalizeToken(token: string): string {
    // Apply stemming iteratively until stable (handles speedrunnings->speedrunning->speedrun)
    let t = token;
    for (let i = 0; i < 3; i += 1) {
      const next = stemOnce(t);
      if (next === t || next.length < 3) break;
      t = next;
    }
    return t;
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
  // Prefer HTML lang attribute first
  if (story.htmlLang) {
    const baseLang = story.htmlLang.split('-')[0];
    if (baseLang && baseLang !== 'en') {
      return baseLang;
    }
  }

  // Infer from URL TLD
  const hostname = getHostname(story.url);
  if (hostname) {
    const tld = hostname.split('.').pop()?.toLowerCase();
    const tldToLang: Record<string, string> = {
      de: 'de',
      at: 'de',
      ch: 'de',
      fr: 'fr',
      it: 'it',
      es: 'es',
      pt: 'pt',
      pl: 'pl',
      nl: 'nl',
      be: 'nl',
      se: 'sv',
      no: 'no',
      dk: 'da',
      fi: 'fi',
      gr: 'el',
      hu: 'hu',
      ro: 'ro',
      bg: 'bg',
      cs: 'cs',
      sk: 'sk',
      hr: 'hr',
      si: 'sl',
      rs: 'sr',
      ba: 'bs',
      mk: 'mk',
      al: 'sq',
      ee: 'et',
      lv: 'lv',
      lt: 'lt',
      uk: 'uk',
    };
    if (tld && tldToLang[tld]) {
      return tldToLang[tld];
    }
  }

  // Fallback to tinyld detection
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
  // Normalize special quote characters to regular quotes
  original = original.replace(/[ΓÇÿΓÇÖ]/g, "\"");
  const result = new Set<string>();
  for (const token of tokens) {
    if (stopwords.has(token)) continue;
    if (token.length < 3) continue;
    const capitalized = token[0]!.toUpperCase() + token.slice(1);
    // Match the token when preceded by a space (not sentence-start after . or start-of-string)
    const pattern = new RegExp(`(?<=[^.!?
])\\s+${capitalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[^a-z]|$)`, 'u');
    if (pattern.test(original)) {
      result.add(token);
    }
  }
  
  // Also extract terms that appear in quotes (quoted terms are often proper nouns)
  // Handle all European quote styles with properly paired quotes
  // Preserve full quoted phrases including stop words (e.g., "Game of Thrones")
  const quotePatterns = [
    // Regular double quotes: "text"
    /"([^"]+)"/g,
    // Curly double quotes: "text" "text"
    /[\u201C\u201E]([^\u201C\u201D\u201E\u201F]+)[\u201D\u201F]/g,
    // German quotes: „text"
    /\u201E([^\u201E\u201C]+)\u201C/g,
    // Guillemets: «text»
    /\u00BB([^\u00AB\u00BB]+)\u00AB/g,
    /\u00AB([^\u00AB\u00BB]+)\u00BB/g,
    // Regular single quotes: 'text'
    /'([^']+)'/g,
    // Curly single quotes: 'text' 'text'
    /[\u2018\u201A]([^\u2018\u2019\u201A\u201B]+)[\u2019\u201B]/g,
  ];
  for (const pattern of quotePatterns) {
    let match;
    while ((match = pattern.exec(original)) !== null) {
      const quotedText = match[1];
      // Add the full quoted phrase as a single term (preserves stop words like "of")
      const lowerQuoted = quotedText.toLowerCase().trim();
      if (lowerQuoted.length >= 3) {
        result.add(lowerQuoted);
      }
      // Also add individual non-stopword words for matching flexibility
      const quotedWords = quotedText.split(/\s+/);
      for (const word of quotedWords) {
        const lowerWord = word.toLowerCase();
        if (lowerWord.length >= 3 && !stopwords.has(lowerWord)) {
          result.add(lowerWord);
        }
      }
    }
  }
  
  // Also extract terms that appear next to German quotation marks
  const germanQuotePattern = /„([^„“]+)“/g;
  let germanMatch;
  while ((germanMatch = germanQuotePattern.exec(original)) !== null) {
    const quotedText = germanMatch[1];
    // Add the full quoted phrase as a single term (preserves stop words like "of")
    const lowerQuoted = quotedText.toLowerCase().trim();
    if (lowerQuoted.length >= 3) {
      result.add(lowerQuoted);
    }
    // Also add individual non-stopword words for matching flexibility
    const quotedWords = quotedText.split(/\s+/);
    for (const word of quotedWords) {
      const lowerWord = word.toLowerCase();
      if (lowerWord.length >= 3 && !stopwords.has(lowerWord)) {
        result.add(lowerWord);
      }
    }
  }
  
  return result;
}

/**
 * Extracts quoted phrases from text, removes cult names, and returns remaining terms
 * as proper nouns with non-plural variations. Only processes quoted phrases that
 * contain cult names.
 */
function extractQuotedPhraseTerms(text: string, language: string): Set<string> {
  const result = new Set<string>();
  // Match quoted phrases (both curly quotes and straight quotes)
  const quotePatterns = [
    /[""„\u201C\u201D\u201E\u201F\u00AB\u00BB](.+?)[""„\u201C\u201D\u201E\u201F\u00AB\u00BB]/g,
    /[''\u2018\u2019\u201A\u201B](.+?)[''\u2018\u2019\u201A\u201B]/g,
  ];

  // Get all cult name aliases for this language
  const cultNames = new Set<string>();
  for (const { canonical, aliases } of SUBJECT_ALIASES) {
    cultNames.add(canonical);
    for (const alias of aliases) {
      if (!alias.lang || alias.lang === language) {
        cultNames.add(alias.text.toLowerCase());
      }
    }
  }

  for (const pattern of quotePatterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const phrase = match[1]!.toLowerCase();
      const phraseTokens = phrase.split(/\s+/).filter(t => t.length >= 3);

      // Only process if the quoted phrase contains a cult name
      const hasCultName = phraseTokens.some(t => cultNames.has(t));
      if (!hasCultName) continue;

      // Remove cult names from the phrase
      const remainingTokens = phraseTokens.filter(t => !cultNames.has(t));

      // Add remaining tokens and their non-plural variations
      for (const token of remainingTokens) {
        result.add(token);
        // Remove trailing 's' for non-plural variation (if not ending in 'ss')
        if (token.length > 5 && token.endsWith('s') && !token.endsWith('ss')) {
          result.add(token.slice(0, -1));
        }
      }
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
    
    // Extract proper nouns from URL slug (entity names often in path even when omitted from title)
    const urlPath = new URL(story.url).pathname;
    const urlSlugText = urlPath.replace(/-/g, ' ').replace(/\//g, ' ');
    const urlSlugTokens = tokenize(urlSlugText, stopwords);
    // URL slug tokens are already clean - add them directly as anchor terms
    const urlProperNouns = new Set(urlSlugTokens);
    
    const properNounBigrams = [
      ...Array.from(titleProperNouns).flatMap((t, _, arr) => {
        const idx = titleTokens.indexOf(t);
        if (idx < titleTokens.length - 1 && titleProperNouns.has(titleTokens[idx + 1]!)) {
          return [`${t} ${titleTokens[idx + 1]}`];
        }
        return [];
      }),
      ...Array.from(descProperNouns).flatMap((t, _, arr) => {
        const idx = descriptionTokens.indexOf(t);
        if (idx < descriptionTokens.length - 1 && descProperNouns.has(descriptionTokens[idx + 1]!)) {
          return [`${t} ${descriptionTokens[idx + 1]}`];
        }
        return [];
      }),
      ...Array.from(urlProperNouns).flatMap((t, _, arr) => {
        const idx = urlSlugTokens.indexOf(t);
        if (idx < urlSlugTokens.length - 1 && urlProperNouns.has(urlSlugTokens[idx + 1]!)) {
          return [`${t} ${urlSlugTokens[idx + 1]}`];
        }
        return [];
      }),
    ];

    const titleQuotedTerms = extractQuotedPhraseTerms(story.title, language);

    const anchorTerms = new Set<string>([
      ...titleProperNouns,
      ...descProperNouns,
      ...articleProperNouns,
      ...urlProperNouns,
      ...properNounBigrams,
      ...titleQuotedTerms,
    ]);

    const fullText = `${story.title} ${story.description ?? ''} ${story.articleText ?? ''}`;
    injectEntityAliases(fullText, language, termCounts, anchorTerms, 6);

    // Give quoted phrase terms very high weight to make them dominant clustering signal
    for (const term of titleQuotedTerms) {
      termCounts.set(term, (termCounts.get(term) ?? 0) + 10);
    }

    return { index, language, anchorTerms, quotedPhraseTerms: titleQuotedTerms, termCounts };
  });
}
// Terms appearing in more than this fraction of documents are corpus-ubiquitous
// ("cult", "sect", "abuse", etc. in any language) and must not drive similarity.
// This is language-agnostic and scales automatically to any corpus size.
const IDF_MAX_DF_RATIO = 0.40;

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
    // Zero out terms that appear in more than IDF_MAX_DF_RATIO of documents.
    // This kills corpus-ubiquitous words in any language without a hand-curated list.
    if (frequency / total > IDF_MAX_DF_RATIO) {
      idf.set(term, 0);
      continue;
    }
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
  const entityAliasCanonicals = new Set(SUBJECT_ALIASES.map((e) => e.canonical));
  let shared = 0;
  for (const term of a.anchorTerms) {
    if (!b.anchorTerms.has(term)) {
      continue;
    }
    if (term.length < 4) {
      continue;
    }
    if (entityAliasCanonicals.has(term)) {
      shared += 1;
      continue;
    }
    if ((idf.get(term) ?? 0) < 1.0) {
      continue;
    }
    shared += 1;
  }

  return shared;
}

function buildAdjacency(features: StoryFeatures[], idf: Map<string, number>, stories: EnrichedStory[]): Map<number, Set<number>> {
  const edges = new Map<number, Set<number>>();
  const strictThreshold = 0.42;
  const relaxedThreshold = 0.18;
  const anchorMinSimilarity = 0.20;
  const entityAliasCanonicals = new Set(SUBJECT_ALIASES.map((e) => e.canonical));

  for (let i = 0; i < features.length; i += 1) {
    for (let j = i + 1; j < features.length; j += 1) {
      const similarity = cosineSimilarity(features[i], features[j], idf);
      const sharedRareAnchorTerms = countSharedRareAnchorTerms(features[i], features[j], idf);

      const sameLanguage = features[i].language === features[j].language;

      // Check if stories share the same entity alias (not just any entity alias)
      const entityAliasesI = [...features[i].anchorTerms].filter(t => entityAliasCanonicals.has(t));
      const entityAliasesJ = [...features[j].anchorTerms].filter(t => entityAliasCanonicals.has(t));
      const hasEntityAliasMatch = entityAliasesI.some(t => entityAliasesJ.includes(t));

      // Count non-entity-alias shared terms
      let nonAliasShared = 0;
      for (const term of features[i].anchorTerms) {
        if (features[j].anchorTerms.has(term) && !entityAliasCanonicals.has(term) && term.length >= 4) {
          nonAliasShared += 1;
        }
      }

      // When stories match on entity alias, allow linking with 0 non-alias shared terms
      // if similarity is high enough (use relaxed threshold)
      // For non-entity-alias matches, require at least 3 shared rare anchor terms to prevent spurious connections
      const requiredShared = hasEntityAliasMatch ? 0 : 3;

      // Cross-language stories need higher similarity threshold
      // However, if they share rare proper nouns (high IDF anchor terms), use lower threshold
      const adjustedRelaxedThreshold = sameLanguage ? relaxedThreshold : 0.30;
      // For entity alias matches, use lower relaxed threshold (0.15) to allow clustering with few shared terms
      // For non-entity-alias matches with shared rare anchor terms, also use lower threshold (0.05)
      // For non-entity-alias matches without shared rare anchor terms, require higher similarity
      const finalRelaxedThreshold = hasEntityAliasMatch ? 0.15 : (sharedRareAnchorTerms >= 3 ? 0.10 : 0.50);
      // For entity alias matches, use very low anchor similarity threshold (0.05)
      // For non-entity-alias matches with shared rare anchor terms, use lower anchor threshold (0.05)
      const adjustedAnchorMinSimilarity = hasEntityAliasMatch ? 0.05 : (sharedRareAnchorTerms >= 1 ? 0.05 : (sameLanguage ? anchorMinSimilarity : 0.25));

      // If stories share entity alias and have different quoted phrase terms,
      // prevent them from clustering (quoted terms define sub-topics)
      const hasQuotedTermsI = features[i].quotedPhraseTerms.size > 0;
      const hasQuotedTermsJ = features[j].quotedPhraseTerms.size > 0;
      const hasMismatchedQuotedTerms = hasEntityAliasMatch &&
                                     ((hasQuotedTermsI && !hasQuotedTermsJ) ||
                                      (!hasQuotedTermsI && hasQuotedTermsJ) ||
                                      (hasQuotedTermsI && hasQuotedTermsJ &&
                                       ![...features[i].quotedPhraseTerms].some(t => features[j].quotedPhraseTerms.has(t))));

      // For Plymouth Brethren, also check for sub-topic keywords in title
      // Only block if stories have mutually exclusive sub-topic keywords (e.g., one has "unchosen", other has "pets")
      const hasUnchosenI = stories[i].title.toLowerCase().includes('unchosen');
      const hasUnchosenJ = stories[j].title.toLowerCase().includes('unchosen');
      const hasPetsI = stories[i].title.toLowerCase().includes('pets') || stories[i].title.toLowerCase().includes('animaux');
      const hasPetsJ = stories[j].title.toLowerCase().includes('pets') || stories[j].title.toLowerCase().includes('animaux');
      const bothPlymouthBrethren = (entityAliasesI.includes('plymouth brethren') || entityAliasesJ.includes('plymouth brethren'));
      const hasSubTopicMismatch = bothPlymouthBrethren &&
                                  ((hasUnchosenI && hasPetsJ) || (hasPetsI && hasUnchosenJ));

      // Check if stories share any quoted phrase terms (quoted proper nouns are strong clustering signal)
      const sharedQuotedTerms = [...features[i].quotedPhraseTerms].filter(t => features[j].quotedPhraseTerms.has(t));
      const hasSharedQuotedTerm = sharedQuotedTerms.length > 0;

      // PRIMARY CLUSTERING SIGNAL: Shared proper noun bigrams (e.g., "hannah murray", "game of thrones")
      // If stories share 2+ proper noun bigrams, link them regardless of language or similarity
      const sharedProperNounBigrams = [...features[i].anchorTerms].filter(t => 
        t.includes(' ') && t.length >= 8 && features[j].anchorTerms.has(t)
      );
      
      if (sharedProperNounBigrams.length >= 2) {
        const left = edges.get(i) ?? new Set<number>();
        const right = edges.get(j) ?? new Set<number>();
        left.add(j);
        right.add(i);
        edges.set(i, left);
        edges.set(j, right);
        continue;
      }

      // SECONDARY: Shared proper noun unigrams (e.g., "hannah", "murray", "game", "thrones")
      // If stories share 3+ proper noun unigrams, link them with lower similarity threshold
      const sharedProperNounUnigrams = [...features[i].anchorTerms].filter(t => 
        !t.includes(' ') && t.length >= 4 && features[j].anchorTerms.has(t) && !entityAliasCanonicals.has(t)
      );
      if (sharedProperNounUnigrams.length >= 3 && similarity >= 0.10) {
        const left = edges.get(i) ?? new Set<number>();
        const right = edges.get(j) ?? new Set<number>();
        left.add(j);
        right.add(i);
        edges.set(i, left);
        edges.set(j, right);
        continue;
      }

      // FALLBACK: Use existing similarity-based rules for stories without strong proper noun overlap
      // BUT: If one story has quoted phrase bigrams and the other doesn't share them, don't link via fallback
      // This prevents stories with strong proper noun identity (from quotes) from being pulled into generic clusters
      const iQuotedBigrams = [...features[i].quotedPhraseTerms].filter(t => t.includes(' ') && t.length >= 8);
      const jQuotedBigrams = [...features[j].quotedPhraseTerms].filter(t => t.includes(' ') && t.length >= 8);
      const sharedQuotedBigrams = iQuotedBigrams.filter(t => features[j].quotedPhraseTerms.has(t));
      
      // If one has 1+ quoted bigrams and they don't share ANY quoted bigrams, block fallback
      if ((iQuotedBigrams.length >= 1 || jQuotedBigrams.length >= 1) && sharedQuotedBigrams.length === 0) {
        continue;
      }

      const shouldLink =
        similarity >= strictThreshold ||
        (sharedRareAnchorTerms >= requiredShared && similarity >= finalRelaxedThreshold) ||
        (sharedRareAnchorTerms >= 2 && similarity >= adjustedAnchorMinSimilarity) ||
        (!sameLanguage && sharedRareAnchorTerms >= 2 && similarity >= 0.15) || // Cross-language: 2+ shared terms, higher similarity
        (hasSharedQuotedTerm && similarity >= 0.12); // Quoted terms need meaningful similarity

      // Block linking if one story carries an entity alias the other doesn't share.
      // This prevents alias-bearing stories from being pulled into generic clusters.
      const eitherHasAlias = entityAliasesI.length > 0 || entityAliasesJ.length > 0;
      if (eitherHasAlias && !hasEntityAliasMatch) {
        continue;
      }

      // Block linking if stories have mismatched quoted phrase terms
      if (hasMismatchedQuotedTerms) {
        continue;
      }

      // Block linking if Plymouth Brethren stories have sub-topic mismatch
      if (hasSubTopicMismatch) {
        continue;
      }

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

const MIN_CLUSTER_COHERENCE = 0.01;

function isClusterCoherent(component: number[], features: StoryFeatures[], idf: Map<string, number>): boolean {
  if (component.length <= 2) return true;
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

  // Prioritize proper noun bigrams from anchorTerms (preserve stop words like "of" in "Game of Thrones")
  const bigramCandidates: string[] = [];
  for (const idx of storyIndexes) {
    const feature = features[idx];
    if (!feature) continue;
    for (const term of feature.anchorTerms) {
      if (term.includes(' ') && term.length >= 8) {
        const seenCount = storyIndexes.filter(i => features[i]?.anchorTerms.has(term)).length;
        if (seenCount >= minimumCoverage && !bigramCandidates.includes(term)) {
          bigramCandidates.push(term);
        }
      }
    }
  }

  // Sort bigram candidates: prefer shorter bigrams, but prioritize those with higher coverage
  // Also prefer bigrams that preserve stop words (like "game of thrones" over "game throne")
  bigramCandidates.sort((a, b) => {
    const aCoverage = storyIndexes.filter(i => features[i]?.anchorTerms.has(a)).length;
    const bCoverage = storyIndexes.filter(i => features[i]?.anchorTerms.has(b)).length;
    // First sort by coverage (higher is better)
    if (aCoverage !== bCoverage) {
      return bCoverage - aCoverage;
    }
    // Then prefer bigrams with stop words (longer is better for preserving "of")
    return b.split(/\s+/).length - a.split(/\s+/).length;
  });

  // Use bigram terms if available, otherwise fall back to regular candidates
  const top = bigramCandidates.length > 0 ? bigramCandidates.slice(0, 2) : candidates.slice(0, 2);
  if (top.length === 0) {
    return 'Detected Cluster';
  }

  return toTitleCase(top.join(' '));
}

function detectStoryClusters(stories: EnrichedStory[]): DetectedGroup[] {
  const features = buildStoryFeatures(stories);
  const idf = buildIdf(features);
  const edges = buildAdjacency(features, idf, stories);
  const groups: DetectedGroup[] = [];
  const assigned = new Set<number>();

  // Complete-linkage: a candidate can only join a cluster if it links to ALL
  // current members, not just one. This prevents transitive-bridge merges.
  for (let i = 0; i < features.length; i += 1) {
    if (assigned.has(i)) continue;

    const neighbors = edges.get(i) ?? new Set<number>();
    if (neighbors.size === 0) continue;

    // Seed cluster with i and its direct neighbours
    let component: number[] = [i, ...neighbors];

    // Check if component has multiple languages and shares proper noun bigrams
    const componentLanguages = new Set(component.map(idx => features[idx].language));
    const isCrossLanguage = componentLanguages.size > 1;
    
    // Check if component has significant proper noun bigram overlap (strong cross-language signal)
    // Instead of requiring ALL stories to share bigrams, check if enough pairs share bigrams
    let bigramEdgeCount = 0;
    for (let a = 0; a < component.length; a++) {
      for (let b = a + 1; b < component.length; b++) {
        const idxA = component[a];
        const idxB = component[b];
        const shared = [...features[idxA].anchorTerms].filter(t => 
          t.includes(' ') && t.length >= 8 && features[idxB].anchorTerms.has(t)
        );
        if (shared.length >= 2) {
          bigramEdgeCount++;
        }
      }
    }
    const totalPairs = (component.length * (component.length - 1)) / 2;
    const bigramEdgeRatio = totalPairs > 0 ? bigramEdgeCount / totalPairs : 0;
    const hasSignificantBigramOverlap = bigramEdgeRatio >= 0.3; // At least 30% of pairs share 2+ bigrams


    // Iteratively prune members that don't link to required percentage of others.
    // Pure complete-linkage (100%) is too strict for cross-language clusters;
    // majority-linkage prevents transitive bridges while still allowing near-cliques.
    // Cross-language clusters with shared proper noun bigrams use lower threshold (60%).
    const majorityThreshold = (isCrossLanguage && hasSignificantBigramOverlap) ? 0.6 : 0.8;
    let changed = true;
    while (changed) {
      changed = false;
      const next: number[] = [];
      for (const a of component) {
        const aEdges = edges.get(a) ?? new Set<number>();
        const others = component.filter((b) => b !== a);
        const linkedCount = others.filter((b) => aEdges.has(b)).length;
        const linkRatio = others.length === 0 ? 1 : linkedCount / others.length;
        
        // Additional check: if story shares proper noun bigrams with enough others, keep it even if linkRatio is lower
        const bigramSharedCount = others.filter((b) => {
          const shared = [...features[a].anchorTerms].filter(t => 
            t.includes(' ') && t.length >= 8 && features[b].anchorTerms.has(t)
          );
          return shared.length >= 2;
        }).length;
        const bigramRatio = others.length === 0 ? 1 : bigramSharedCount / others.length;
        
        // If story has exclusive bigrams not shared with others, require higher threshold
        const aBigrams = [...features[a].anchorTerms].filter(t => t.includes(' ') && t.length >= 8);
        const hasExclusiveBigrams = aBigrams.some(t => !others.every(b => features[b].anchorTerms.has(t)));
        
        // If story has exclusive bigrams, require it to share bigrams with 60%+ of others AND have linkRatio >= 60%
        if (hasExclusiveBigrams) {
          if (bigramRatio < 0.6 || linkRatio < 0.6) {
            changed = true;
            continue;
          }
        }
        
        // If story shares bigrams with 50%+ of others, use lower threshold (50%)
        const effectiveThreshold = (bigramRatio >= 0.5 && !hasExclusiveBigrams) ? 0.5 : majorityThreshold;
        
        if (linkRatio >= effectiveThreshold) {
          next.push(a);
        } else {
          changed = true;
        }
      }
      component = next;
    }

    if (component.length < 2) continue;
    if (component.some((idx) => assigned.has(idx))) continue;

    if (!isClusterCoherent(component, features, idf)) continue;

    for (const idx of component) assigned.add(idx);
    groups.push({
      label: selectGroupLabel(features, component, idf),
      storyIndexes: new Set(component),
    });
  }

  groups.sort((a, b) => b.storyIndexes.size - a.storyIndexes.size);
  return groups;
}

function classifyStories(stories: EnrichedStory[], wrongClusterUrls?: Set<string>): StoryGroup[] {
  const wrongClusterIndexes = new Set<number>();
  if (wrongClusterUrls && wrongClusterUrls.size > 0) {
    stories.forEach((story, idx) => {
      if (wrongClusterUrls.has(createDedupeKey(story.url))) {
        wrongClusterIndexes.add(idx);
      }
    });
  }

  const detectedGroups = detectStoryClusters(stories);
  const groupedIndexes = new Set<number>();
  const result: StoryGroup[] = [];

  for (const group of detectedGroups) {
    const filteredIndexes = Array.from(group.storyIndexes).filter((idx) => !wrongClusterIndexes.has(idx));
    
    const groupedStories = filteredIndexes
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

    for (const idx of filteredIndexes) {
      groupedIndexes.add(idx);
    }
  }

  const detachedStories = Array.from(wrongClusterIndexes)
    .map((idx) => stories[idx])
    .filter((story): story is EnrichedStory => Boolean(story));

  const ungrouped = stories.filter((_, idx) => !groupedIndexes.has(idx) && !wrongClusterIndexes.has(idx));
  const independentStories = [...ungrouped, ...detachedStories];

  if (independentStories.length > 0) {
    result.push({ label: 'Independent Journalism', type: 'independent', stories: independentStories });
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

  const { feedbackBlocklist, wrongClusterSet } = (() => {
    const feedbackPath = new URL('../data/feedback/false-positives.json', import.meta.url);
    try {
      const parsed = JSON.parse(readFileSync(feedbackPath, 'utf-8')) as { entries?: Array<{ url?: string; reason?: string }> };
      const entries = parsed.entries ?? [];
      return {
        feedbackBlocklist: new Set(
          entries.filter((e) => e.reason === 'false-positive' && typeof e.url === 'string').map((e) => createDedupeKey(e.url!))
        ),
        wrongClusterSet: new Set(
          entries.filter((e) => e.reason === 'wrong-cluster' && typeof e.url === 'string').map((e) => createDedupeKey(e.url!))
        ),
      };
    } catch {
      return { feedbackBlocklist: new Set<string>(), wrongClusterSet: new Set<string>() };
    }
  })();

  const eligibleDrafts = feedbackBlocklist.size > 0
    ? canonicalDrafts.filter((draft) => {
        const dedupeKey = createDedupeKey(draft.url);
        if (!feedbackBlocklist.has(dedupeKey)) return true;
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
    const enrichedStory: EnrichedStory = {
      ...draft,
      title: meta.title?.trim() || draft.title,
      description: meta.description?.trim() || '',
      image: meta.image,
      publishedAt: meta.publishedAt || draft.publishedAt,
      articleText: meta.articleText?.trim() || '',
      htmlLang: meta.htmlLang,
      classificationAudit: draft.classificationAudit, // Explicitly preserve audit data
    };
    fetchedStories.push(enrichedStory);
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

  const groups = classifyStories(stories, wrongClusterSet);

  for (const g of groups) {
    console.log(`[cluster] "${g.label}" (${g.type}) — ${g.stories.length} stories`);
    for (const s of g.stories) console.log(`  - ${s.title.slice(0, 90)}`);
  }

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




