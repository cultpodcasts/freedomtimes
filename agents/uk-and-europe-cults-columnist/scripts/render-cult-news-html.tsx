/// <reference types="node" />
/* @jsxRuntime classic */
/** @jsx h */
/** @jsxFrag Fragment */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { detect as detectLanguage } from 'tinyld';
import { clusterStopwordsForLanguage, normalizeClusterStopwordLookupToken } from '../src/clusterStopwords.ts';
import { canonicalizeApostrophes } from '../src/discoveryTextNormalize.ts';
import { extractQuotedSpans } from '../src/quotePatterns.ts';
import {
  getReligiousGroupTermsForLanguage,
  getCoerciveHarmTermsForLanguage,
} from '../src/pipelineTerms.ts';
import { stripPublisherBoilerplate } from '../src/publisherBoilerplate.ts';
import { getCultTermsForLanguage } from '../src/cultTerms.ts';
import { cleanDisplayTitle } from '../src/articleContent.ts';
import { buildArchiveMirrorLinks, getCanonicalArticleUrl } from '../src/archiveMirrors.ts';
import { ARCHIVE_FALLBACK_HOSTS } from '../src/http-cache/config.ts';
import { buildCitationReport, buildStorySourceCitation, type CitationReport } from '../src/sourceCitation.ts';
import { applyClusterLayout, loadClusterLayout } from '../src/clusterLayout.ts';
import { hasFigurativeCultUsage } from '../src/pipeline.ts';
import {
  buildGenericCultClusterTermSet,
  isClusterSignalBigram,
  isClusterSignalUnigram,
  isGenericCultClusterTerm,
} from '../src/clusterGenericCultTerms.ts';
import {
  Fragment,
  DRAFTS_ARCHIVE_PATH,
  DRAFTS_PATH,
  LOG_PATH,
  OUTPUT_PATH,
  SOURCES_OUTPUT_PATH,
  extractDraftsFromLog,
  extractRunSummary,
  fetchStoryMeta,
  formatPublishedAt,
  h,
  renderDocument,
  type EnrichedStory,
} from './render-cult-news-html.helpers.ts';

declare global {
  namespace JSX {
    interface IntrinsicElements {
      [elementName: string]: Record<string, unknown>;
    }
  }
}

type StoryGroup = {
  id?: string;
  label: string;
  type: 'detected' | 'independent';
  stories: EnrichedStory[];
};

export type { StoryGroup, ClusterDetectionResult, ClusterAuditReport, RenderStorySet };
export { classifyStories, detectStoryClusters, auditClusterGaps, createDedupeKey, loadEnrichedStoriesForClustering };

type DraftStory = {
  title: string;
  url: string;
  host?: string;
  publishedAt?: string;
  contentMirrorUrl?: string;
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
  source?: { url?: unknown; host?: unknown; publishedAt?: unknown; contentMirrorUrl?: unknown };
  classificationAudit?: CultClassificationAudit;
};

function mapRawDraft(draft: RawDraftShape): DraftStory | null {
  const title = typeof draft.title === 'string' ? draft.title : '';
  const rawSourceUrl = typeof draft.source?.url === 'string' ? draft.source.url : '';
  const url = getCanonicalArticleUrl(rawSourceUrl);
  if (!title || !url) return null;
  const storedMirror =
    typeof draft.source?.contentMirrorUrl === 'string' ? draft.source.contentMirrorUrl : undefined;
  const contentMirrorUrl =
    storedMirror ?? (rawSourceUrl && rawSourceUrl !== url ? rawSourceUrl : undefined);
  return {
    title,
    url,
    host: typeof draft.source?.host === 'string' ? draft.source.host : undefined,
    publishedAt: typeof draft.source?.publishedAt === 'string' ? draft.source.publishedAt : undefined,
    contentMirrorUrl,
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

if (RENDER_MAX_AGE_HOURS !== undefined) {
  console.log(`[render] freshness window: ${RENDER_MAX_AGE_HOURS} hours (CULT_NEWS_RENDER_MAX_AGE_HOURS / DISCOVERY_MAX_AGE_HOURS)`);
} else {
  console.log('[render] freshness window: disabled (no age filter — all dated stories kept)');
}

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

    const embeddedHostSegment = segments[embeddedHostIndex];
    if (!embeddedHostSegment) {
      return parsed.toString();
    }

    const embeddedHost = embeddedHostSegment.toLowerCase();
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

function shouldShowArchiveMirrors(story: EnrichedStory): boolean {
  const host = (story.host || getHostname(story.url) || '').toLowerCase();
  if (story.contentMirrorUrl) return true;
  return Array.from(ARCHIVE_FALLBACK_HOSTS).some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

function storyCitationInput(story: EnrichedStory) {
  return {
    title: story.title,
    url: story.url,
    host: story.host,
    publishedAt: story.publishedAt,
    articleText: story.articleText,
    contentMirrorUrl: story.contentMirrorUrl,
    archiveMirrorLinks: story.archiveMirrorLinks,
  };
}

function attachSourceCitation(story: EnrichedStory): EnrichedStory {
  return {
    ...story,
    sourceCitation: buildStorySourceCitation(storyCitationInput(story)),
  };
}

function renderCard(story: EnrichedStory, language?: string) {
  const canonicalUrl = story.url;
  const hostname = story.host || new URL(canonicalUrl).hostname.replace(/^www\./, '');
  const logo = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostname)}&sz=64`;
  const isNonEnglish = language && language !== 'en';
  const escapedUrl = canonicalUrl;
  const escapedTitle = story.title;
  const archiveMirrors =
    story.archiveMirrorLinks ??
    buildArchiveMirrorLinks(canonicalUrl, {
      knownSnapshotUrls: story.contentMirrorUrl ? [story.contentMirrorUrl] : [],
    });
  const showArchiveMirrors = shouldShowArchiveMirrors(story) && archiveMirrors.length > 0;
  const citation = story.sourceCitation;
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
          <a href={canonicalUrl} target="_blank" rel="noopener noreferrer">
            {story.title}
          </a>
        </h2>
        <p {...(isNonEnglish ? { lang: language } : {})}>{story.description || 'No abstract available.'}</p>
        <div className="feedback-row">
          <a className="read" href={canonicalUrl} target="_blank" rel="noopener noreferrer">Read on {hostname}</a>
          {citation?.paywalled && citation.accessibleUrl ? (
            <a className="read cite-accessible" href={citation.accessibleUrl} target="_blank" rel="noopener noreferrer">
              Accessible copy for citing
            </a>
          ) : null}
          {showArchiveMirrors ? (
            <div className="archive-mirror-links">
              <span className="archive-mirror-label">Also via archive:</span>
              {archiveMirrors.map((mirror) => (
                <a
                  className="archive-mirror-link"
                  href={mirror.href}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {mirror.label}
                </a>
              ))}
            </div>
          ) : null}
          <div className="fb-row-actions">
          <button
            className="fb-btn copy-cite-btn"
            data-cite-url={escapedUrl}
            onclick="window._copyStoryCitation(this)"
          >📋 Copy citation</button>
          <button
            className="fb-btn"
            data-fb-url={escapedUrl}
            data-fb-title={escapedTitle}
            data-fb-reason="false-positive"
            onclick="window._fbClick(this)"
          >🚫 False positive</button>
          <select className="cluster-move-select" data-story-url={escapedUrl} onchange="window._onMoveTargetPick(this)">
            <option value="">Move to…</option>
            <option value="independent">Independent</option>
          </select>
          <button
            type="button"
            className="cluster-move-btn"
            data-story-url={escapedUrl}
            onclick="window._confirmStoryMove(this)"
            disabled
          >Move</button>
          </div>
        </div>
      </div>
    </article>
  );
}

function buildPage(
  groups: StoryGroup[],
  totalCount: number,
  generatedAt: string,
  citationReport: CitationReport,
) {
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
          .read.cite-accessible {
            margin-top: 0;
            font-size: 0.9rem;
            color: #4a5568;
          }
          .read.cite-accessible:hover { color: var(--accent); }
          .copy-citations-btn {
            font-family: system-ui, sans-serif;
            font-size: 0.72rem;
            font-weight: 600;
            padding: 3px 9px;
            border-radius: 5px;
            border: 1px solid var(--line);
            background: #f4f2ea;
            color: #5c5548;
            cursor: pointer;
            margin-left: auto;
          }
          .copy-citations-btn:hover { background: #e8e0d0; }
          .copy-citations-btn.copied {
            background: #d4edda;
            color: #1a5c38;
            border-color: #a3d3b0;
          }
          .header-actions {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            align-items: center;
            margin-bottom: 8px;
          }
          .header-actions .status-note {
            font-family: system-ui, sans-serif;
            font-size: 0.8rem;
            color: #1a5c38;
            display: none;
          }
          .header-actions .status-note.show { display: inline; }
          .feedback-row {
            display: flex;
            flex-direction: column;
            align-items: flex-start;
            gap: 6px;
            margin-top: 10px;
          }
          .feedback-row .fb-row-actions {
            display: flex;
            gap: 6px;
            flex-wrap: wrap;
          }
          .archive-mirror-links {
            display: flex;
            flex-wrap: wrap;
            gap: 6px 10px;
            align-items: center;
            font-size: 0.82rem;
            font-family: system-ui, sans-serif;
            color: #5c5548;
          }
          .archive-mirror-label {
            font-weight: 600;
          }
          .archive-mirror-link {
            color: #4a5568;
            text-decoration: none;
            border-bottom: 1px dotted #9a9488;
          }
          .archive-mirror-link:hover {
            color: var(--accent);
            border-bottom-color: var(--accent);
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
          .fb-btn[data-fb-reason="false-positive"] { display: none; }
          body.review-phase .fb-btn[data-fb-reason="false-positive"] { display: inline-block; }
          body.verification-phase .cluster-move-select,
          body.verification-phase .cluster-move-btn,
          body.verification-phase .cluster-label-input,
          body.verification-phase .cluster-delete-btn { display: inline-block; }
          body.verification-phase .group-label { display: none; }
          .cluster-move-select,
          .cluster-move-btn,
          .cluster-label-input,
          .cluster-delete-btn,
          #cluster-editor { display: none; }
          body.verification-phase #cluster-editor { display: flex; }
          .cluster-move-select {
            font-size: 0.72rem;
            font-family: system-ui, sans-serif;
            max-width: 11rem;
            padding: 3px 6px;
            border-radius: 5px;
            border: 1px solid var(--line);
            background: #fff;
          }
          .cluster-move-btn {
            font-size: 0.72rem;
            font-family: system-ui, sans-serif;
            font-weight: 600;
            padding: 3px 9px;
            border-radius: 5px;
            border: 1px solid #1a5c38;
            background: #dff0e8;
            color: #1a5c38;
            cursor: pointer;
          }
          .cluster-move-btn:disabled {
            opacity: 0.45;
            cursor: not-allowed;
            border-color: var(--line);
            background: #f4f2ea;
            color: #756f63;
          }
          .cluster-label-input {
            font-size: 1rem;
            font-weight: 700;
            font-family: Georgia, serif;
            border: 1px solid var(--line);
            border-radius: 6px;
            padding: 4px 8px;
            min-width: 12rem;
          }
          .cluster-delete-btn {
            font-size: 0.72rem;
            font-family: system-ui, sans-serif;
            padding: 3px 9px;
            border-radius: 5px;
            border: 1px solid #e57373;
            background: #fff5f5;
            color: #8b1a1a;
            cursor: pointer;
          }
          #cluster-editor {
            position: fixed;
            bottom: 0;
            left: 0;
            right: 0;
            z-index: 1001;
            gap: 10px;
            align-items: center;
            flex-wrap: wrap;
            padding: 12px 18px;
            background: rgba(255, 253, 250, 0.97);
            border-top: 2px solid var(--line);
            box-shadow: 0 -4px 20px rgba(0,0,0,0.08);
            font-family: system-ui, sans-serif;
            font-size: 0.85rem;
          }
          #cluster-editor button {
            font-family: system-ui, sans-serif;
            font-size: 0.8rem;
            font-weight: 600;
            padding: 6px 12px;
            border-radius: 6px;
            border: 1px solid var(--line);
            background: #f4f2ea;
            cursor: pointer;
          }
          #cluster-editor button.primary {
            background: #1a5c38;
            color: #fff;
            border-color: #1a5c38;
          }
          #layout-status { color: #4a463d; }
          body.verification-phase main.wrap { padding-bottom: 72px; }
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
            <div className="header-actions">
            <button id="export-fb-btn" onclick="window._fbExport()" style="font-family:system-ui,sans-serif;font-size:0.8rem;font-weight:600;padding:5px 12px;border-radius:6px;border:1px solid #ded6c4;background:#f4f2ea;color:#5c5548;cursor:pointer;">📋 Export all feedback to clipboard</button>
            <span id="export-fb-status" style="font-family:system-ui,sans-serif;font-size:0.8rem;color:#1a5c38;margin-left:8px;display:none;">✓ Copied! Paste into data/feedback/false-positives.json → entries array</span>
            <button id="copy-all-citations-btn" onclick="window._copyAllCitations()" style="font-family:system-ui,sans-serif;font-size:0.8rem;font-weight:600;padding:5px 12px;border-radius:6px;border:1px solid #ded6c4;background:#f4f2ea;color:#5c5548;cursor:pointer;">📋 Copy all source citations</button>
            <span id="copy-all-citations-status" className="status-note">✓ Citations copied — paste into your draft</span>
            </div>
          </header>
          {hasStories ? (
            groups.map((group, groupIndex) =>
              group.type === 'independent' ? (
                <div className="story-group" data-citation-group-index={groupIndex} data-group-type="independent">
                  <div className="group-header">
                    <p className="latest-heading" style="margin:0;border:0;padding:0;">Latest Stories</p>
                    <button
                      className="copy-citations-btn"
                      data-citation-group-index={groupIndex}
                      onclick="window._copyGroupCitations(this)"
                    >Copy citations</button>
                  </div>
                  <div className="grid">
                    {group.stories.map((story) => renderCard(story, detectStoryLanguage(story)))}
                  </div>
                </div>
              ) : (
                <div
                  className="story-group"
                  data-citation-group-index={groupIndex}
                  data-cluster-id={group.id ?? `auto-${groupIndex}`}
                  data-group-type="detected"
                >
                  <div className="group-header">
                    <h3 className="group-label">{group.label}</h3>
                    <input
                      className="cluster-label-input"
                      type="text"
                      value={group.label}
                      data-cluster-id={group.id ?? `auto-${groupIndex}`}
                      placeholder="Cluster name"
                    />
                    <span className={`group-badge ${group.type}`}>Cluster</span>
                    <span className="group-count">{group.stories.length} {group.stories.length === 1 ? 'article' : 'articles'}</span>
                    <button
                      className="copy-citations-btn"
                      data-citation-group-index={groupIndex}
                      onclick="window._copyGroupCitations(this)"
                    >Copy citations</button>
                    <button
                      className="cluster-delete-btn"
                      type="button"
                      data-cluster-id={group.id ?? `auto-${groupIndex}`}
                      onclick="window._dissolveCluster(this)"
                    >Dissolve cluster</button>
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
      <div id="cluster-editor">
        <strong>Cluster editor</strong>
        <button type="button" id="new-cluster-btn" onclick="window._newCluster()">+ New cluster</button>
        <button type="button" id="save-layout-btn" className="primary" onclick="window._saveLayout()">Apply changes &amp; refresh</button>
        <span id="layout-status"></span>
      </div>
      <div id="report-status" style="position: fixed; top: 10px; right: 10px; background: white; padding: 10px 15px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); font-size: 0.85rem; z-index: 1000;">
        <span id="status-text">Loading...</span>
        <button id="init-report-btn" style="margin-left: 10px; padding: 4px 8px; cursor: pointer;">Init Report</button>
        <button id="close-report-btn" style="margin-left: 5px; padding: 4px 8px; cursor: pointer; display: none;">Close Report</button>
        <button id="finalize-report-btn" style="margin-left: 5px; padding: 4px 8px; cursor: pointer; display: none;">Finalize</button>
      </div>
      <script dangerouslySetInnerHTML={{ __html: `
var FB_GENERATED_AT = '${generatedAt}';
var CITATION_REPORT = ${JSON.stringify(citationReport)};
var CITATION_BY_URL = {};
(CITATION_REPORT.groups || []).forEach(function(group) {
  (group.sources || []).forEach(function(source) {
    CITATION_BY_URL[source.publisherUrl] = source.markdown;
  });
});
var API_BASE = window.location.origin;
var currentReport = null;

function _copyTextToClipboard(text, onSuccess) {
  if (!text) return;
  navigator.clipboard.writeText(text).then(function() {
    if (onSuccess) onSuccess();
  }).catch(function(err) {
    console.error('Clipboard copy failed:', err);
    alert('Could not copy to clipboard');
  });
}

window._copyStoryCitation = function(btn) {
  var url = btn.getAttribute('data-cite-url');
  var md = url ? CITATION_BY_URL[url] : '';
  _copyTextToClipboard(md, function() {
    btn.classList.add('copied');
    btn.textContent = '✓ Copied';
    setTimeout(function() {
      btn.classList.remove('copied');
      btn.textContent = '📋 Copy citation';
    }, 1800);
  });
};

window._copyGroupCitations = function(btn) {
  var idx = Number(btn.getAttribute('data-citation-group-index'));
  var group = CITATION_REPORT.groups[idx];
  if (!group) return;
  var heading = group.type === 'independent' ? '## Latest Stories' : ('## ' + group.label);
  var body = group.sources.map(function(source) { return source.markdown; }).join('\\n');
  _copyTextToClipboard(heading + '\\n\\n' + body, function() {
    btn.classList.add('copied');
    btn.textContent = '✓ Copied';
    setTimeout(function() {
      btn.classList.remove('copied');
      btn.textContent = 'Copy citations';
    }, 1800);
  });
};

window._copyAllCitations = function() {
  _copyTextToClipboard(CITATION_REPORT.markdown, function() {
    var status = document.getElementById('copy-all-citations-status');
    if (status) {
      status.classList.add('show');
      setTimeout(function() { status.classList.remove('show'); }, 2500);
    }
  });
};

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
    statusText.textContent = 'Verification — pick a cluster, click Move, then Apply changes';
    initBtn.style.display = 'inline';
    closeBtn.style.display = 'none';
    finalizeBtn.style.display = 'inline';
    document.body.classList.add('verification-phase');
    _loadClusterLayoutEditor();
  }
  _updateButtonVisibility();
}

var clusterLayoutState = null;

function _layoutFromDom() {
  var clusters = [];
  document.querySelectorAll('.story-group[data-group-type="detected"]').forEach(function(group, index) {
    var id = group.getAttribute('data-cluster-id') || ('auto-' + index);
    var labelInput = group.querySelector('.cluster-label-input');
    var labelEl = group.querySelector('.group-label');
    var label = (labelInput && labelInput.value.trim())
      ? labelInput.value.trim()
      : (labelEl ? labelEl.textContent.trim() : 'Cluster');
    var urls = [];
    group.querySelectorAll('.card[data-url]').forEach(function(card) {
      var url = card.getAttribute('data-url');
      if (url) urls.push(url);
    });
    clusters.push({ id: id, label: (label || 'Cluster').trim(), urls: urls });
  });
  var independentUrls = [];
  document.querySelectorAll('.story-group[data-group-type="independent"] .card[data-url]').forEach(function(card) {
    var url = card.getAttribute('data-url');
    if (url) independentUrls.push(url);
  });
  return { updatedAt: new Date().toISOString(), clusters: clusters, independentUrls: independentUrls };
}

function _findClusterForUrl(layout, url) {
  for (var i = 0; i < layout.clusters.length; i++) {
    if (layout.clusters[i].urls.indexOf(url) !== -1) return layout.clusters[i].id;
  }
  if (layout.independentUrls.indexOf(url) !== -1) return 'independent';
  return '';
}

function _removeUrlFromLayout(layout, url) {
  layout.clusters.forEach(function(cluster) {
    cluster.urls = cluster.urls.filter(function(u) { return u !== url; });
  });
  layout.independentUrls = layout.independentUrls.filter(function(u) { return u !== url; });
}

function _showToast(message) {
  var toast = document.getElementById('fb-toast');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(function() { toast.classList.remove('show'); }, 2200);
}

function _clusterGridForTarget(targetId) {
  if (targetId === 'independent') {
    var independent = document.querySelector('.story-group[data-group-type="independent"] .grid');
    return independent || null;
  }
  var group = document.querySelector('.story-group[data-group-type="detected"][data-cluster-id="' + targetId + '"]');
  return group ? group.querySelector('.grid') : null;
}

function _updateClusterCounts() {
  document.querySelectorAll('.story-group[data-group-type="detected"]').forEach(function(group) {
    var countEl = group.querySelector('.group-count');
    var cards = group.querySelectorAll('.grid .card[data-url]');
    if (countEl) {
      countEl.textContent = cards.length + ' ' + (cards.length === 1 ? 'article' : 'articles');
    }
  });
}

function _insertClusterSection(id, label) {
  if (document.querySelector('.story-group[data-cluster-id="' + id + '"]')) return;
  var section = document.createElement('div');
  section.className = 'story-group';
  section.setAttribute('data-group-type', 'detected');
  section.setAttribute('data-cluster-id', id);
  section.innerHTML =
    '<div class="group-header">' +
      '<h3 class="group-label">' + label + '</h3>' +
      '<input class="cluster-label-input" type="text" value="' + label.replace(/"/g, '&quot;') + '" data-cluster-id="' + id + '" placeholder="Cluster name">' +
      '<span class="group-badge detected">Cluster</span>' +
      '<span class="group-count">0 articles</span>' +
      '<button class="cluster-delete-btn" type="button" data-cluster-id="' + id + '" onclick="window._dissolveCluster(this)">Dissolve cluster</button>' +
    '</div>' +
    '<div class="grid"></div>';
  var independent = document.querySelector('.story-group[data-group-type="independent"]');
  if (independent && independent.parentNode) {
    independent.parentNode.insertBefore(section, independent);
  } else {
    var main = document.querySelector('main.wrap');
    if (main) main.appendChild(section);
  }
}

function _moveCardInDom(card, targetId) {
  var grid = _clusterGridForTarget(targetId);
  if (!grid || !card) return false;
  grid.appendChild(card);
  card.classList.remove('flagged-wc', 'flagged-fp');
  _updateClusterCounts();
  return true;
}

function _applyStoryMove(url, targetId) {
  if (!clusterLayoutState || !url || !targetId) return false;
  var current = _findClusterForUrl(clusterLayoutState, url);
  if (current === targetId) return false;
  _removeUrlFromLayout(clusterLayoutState, url);
  if (targetId === 'independent') {
    clusterLayoutState.independentUrls.push(url);
  } else {
    var cluster = clusterLayoutState.clusters.find(function(c) { return c.id === targetId; });
    if (!cluster) return false;
    cluster.urls.push(url);
  }
  clusterLayoutState.updatedAt = new Date().toISOString();
  return true;
}

function _syncMoveButton(select) {
  var row = select.closest('.fb-row-actions');
  var btn = row ? row.querySelector('.cluster-move-btn') : null;
  if (!btn || !clusterLayoutState) {
    if (btn) btn.disabled = true;
    return;
  }
  var url = select.getAttribute('data-story-url');
  var current = _findClusterForUrl(clusterLayoutState, url);
  var target = select.value;
  btn.disabled = !target || target === current;
}

function _populateMoveSelects() {
  if (!clusterLayoutState) return;
  document.querySelectorAll('.cluster-move-select').forEach(function(select) {
    var url = select.getAttribute('data-story-url');
    if (!url) return;
    while (select.options.length > 1) select.remove(1);
    clusterLayoutState.clusters.forEach(function(cluster) {
      var opt = document.createElement('option');
      opt.value = cluster.id;
      opt.textContent = cluster.label;
      select.appendChild(opt);
    });
    select.value = '';
    _syncMoveButton(select);
  });
  document.querySelectorAll('.cluster-label-input').forEach(function(input) {
    var id = input.getAttribute('data-cluster-id');
    var cluster = clusterLayoutState.clusters.find(function(c) { return c.id === id; });
    if (cluster && !input.matches(':focus')) input.value = cluster.label;
  });
}

window._onMoveTargetPick = function(select) {
  _syncMoveButton(select);
};

window._confirmStoryMove = function(btn) {
  if (!clusterLayoutState) return;
  var url = btn.getAttribute('data-story-url');
  var row = btn.closest('.fb-row-actions');
  var select = row ? row.querySelector('.cluster-move-select') : null;
  var target = select ? select.value : '';
  if (!url || !target) return;
  var current = _findClusterForUrl(clusterLayoutState, url);
  if (target === current) return;

  if (target !== 'independent') {
    var cluster = clusterLayoutState.clusters.find(function(c) { return c.id === target; });
    if (cluster) _insertClusterSection(cluster.id, cluster.label);
  }

  if (!_applyStoryMove(url, target)) return;

  var card = btn.closest('.card');
  if (card && !_moveCardInDom(card, target)) {
    alert('Could not move card in the page. Click Apply changes & refresh to sync.');
  }

  if (select) {
    select.value = '';
    _syncMoveButton(select);
  }

  var status = document.getElementById('layout-status');
  if (status) status.textContent = 'Unsaved moves — click Apply changes & refresh when done';
  var targetLabel = target === 'independent'
    ? 'Independent'
    : ((clusterLayoutState.clusters.find(function(c) { return c.id === target; }) || {}).label || 'cluster');
  _showToast('Moved to ' + targetLabel);
};

async function _loadClusterLayoutEditor() {
  try {
    var res = await fetch(API_BASE + '/api/cluster-layout');
    var data = await res.json();
    clusterLayoutState = data.layout && data.layout.clusters ? data.layout : _layoutFromDom();
    _populateMoveSelects();
  } catch (e) {
    console.error('Failed to load cluster layout:', e);
    clusterLayoutState = _layoutFromDom();
    _populateMoveSelects();
  }
}

window._newCluster = function() {
  if (!clusterLayoutState) clusterLayoutState = _layoutFromDom();
  var label = prompt('Cluster name');
  if (!label || !label.trim()) return;
  var id = 'manual-' + Date.now();
  clusterLayoutState.clusters.push({ id: id, label: label.trim(), urls: [] });
  clusterLayoutState.updatedAt = new Date().toISOString();
  _insertClusterSection(id, label.trim());
  _populateMoveSelects();
  var status = document.getElementById('layout-status');
  if (status) status.textContent = 'New cluster added — move stories with Move, then Apply changes';
  _showToast('Created cluster: ' + label.trim());
};

window._dissolveCluster = function(btn) {
  if (!clusterLayoutState) return;
  var id = btn.getAttribute('data-cluster-id');
  var cluster = clusterLayoutState.clusters.find(function(c) { return c.id === id; });
  if (!cluster) return;
  cluster.urls.forEach(function(url) {
    if (clusterLayoutState.independentUrls.indexOf(url) === -1) {
      clusterLayoutState.independentUrls.push(url);
    }
  });
  clusterLayoutState.clusters = clusterLayoutState.clusters.filter(function(c) { return c.id !== id; });
  clusterLayoutState.updatedAt = new Date().toISOString();
  _populateMoveSelects();
  var status = document.getElementById('layout-status');
  if (status) status.textContent = 'Unsaved changes — click Apply changes & refresh';
};

window._saveLayout = async function() {
  if (!clusterLayoutState) clusterLayoutState = _layoutFromDom();
  document.querySelectorAll('.cluster-label-input').forEach(function(input) {
    var id = input.getAttribute('data-cluster-id');
    var cluster = clusterLayoutState.clusters.find(function(c) { return c.id === id; });
    if (cluster) cluster.label = input.value.trim() || cluster.label;
  });
  var btn = document.getElementById('save-layout-btn');
  var status = document.getElementById('layout-status');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  try {
    var res = await fetch(API_BASE + '/api/report/apply-layout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ layout: clusterLayoutState })
    });
    var data = await res.json();
    if (data.success) {
      window.location.reload();
    } else {
      throw new Error(data.error || 'Apply failed');
    }
  } catch (e) {
    console.error('Failed to save layout:', e);
    alert('Failed to save layout');
    if (btn) { btn.disabled = false; btn.textContent = 'Apply changes & refresh'; }
    if (status) status.textContent = 'Save failed';
  }
};

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

function _updateButtonVisibility() {}

window._fbClick = async function(btn) {
  if (!currentReport || currentReport.status !== 'review') {
    alert('False positive marking is only available during review phase (after Init Report)');
    return;
  }
  var url = btn.getAttribute('data-fb-url');
  var title = btn.getAttribute('data-fb-title');
  var reason = btn.getAttribute('data-fb-reason') || 'false-positive';
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
      btn.textContent = '🚫 Flagged';
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

type StoryFeatures = {
  index: number;
  language: string;
  anchorTerms: Set<string>;
  quotedPhraseTerms: Set<string>;
  termCounts: Map<string, number>;
};

import type { SubjectAlias } from '../src/pipelineTerms.ts';

const SUBJECT_ALIASES: SubjectAlias[] = (() => {
  try {
    const p = new URL('../data/subject-aliases.json', import.meta.url);
    return JSON.parse(readFileSync(p, 'utf-8')) as SubjectAlias[];
  } catch {
    return [];
  }
})();

const SUBJECT_GROUP_CANONICALS = new Set(
  SUBJECT_ALIASES.filter((entry) => entry.clusterRole !== 'topic').map((entry) => entry.canonical),
);
const SUBJECT_TOPIC_CANONICALS = new Set(
  SUBJECT_ALIASES.filter((entry) => entry.clusterRole === 'topic').map((entry) => entry.canonical),
);

function normalizeSubjectMatchText(value: string): string {
  return canonicalizeApostrophes(value.toLowerCase());
}

function isClusterStopword(token: string, stopwords: Set<string>): boolean {
  return stopwords.has(normalizeClusterStopwordLookupToken(token));
}

const GENERIC_CULT_CLUSTER_TERMS = buildGenericCultClusterTermSet();

/** Skip cult/sect/religion vocabulary even when capitalized like a proper noun. */
function isExcludedClusterProperNoun(token: string, stopwords: Set<string>): boolean {
  if (isClusterStopword(token, stopwords)) return true;
  return isGenericCultClusterTerm(token, GENERIC_CULT_CLUSTER_TERMS);
}

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
    .filter((token) => !isClusterStopword(token, stopwords));
}

function toTitleCase(value: string): string {
  return value
    .split(' ')
    .map((word) => (word ? word[0]!.toUpperCase() + word.slice(1) : word))
    .join(' ');
}

/** French/Italian headline elisions (c'est, qu'est, j'ai, …) — not cluster identity. */
function isHeadlineElisionLikeToken(term: string): boolean {
  const t = term.toLowerCase().trim();
  if (t.length < 4 || t.length > 8) return false;
  return /^[\p{L}]{1,2}[''\u2019][\p{L}]/u.test(t);
}

function buildStopwordSet(language: string): Set<string> {
  return clusterStopwordsForLanguage(language);
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

function distinctiveCaseTerms(story: EnrichedStory, language: string): Set<string> {
  const stopwords = buildStopwordSet(language);
  const terms = new Set<string>();
  for (const term of extractTitleHeadProperNouns(story.title, stopwords)) {
    if (term.length >= 5 && !isHeadlineElisionLikeToken(term) && !isGenericCultClusterTerm(term, GENERIC_CULT_CLUSTER_TERMS)) {
      terms.add(term);
    }
  }
  for (const term of extractQuotedTerms(story.title)) {
    if (term.length >= 5 && !isHeadlineElisionLikeToken(term) && !isGenericCultClusterTerm(term, GENERIC_CULT_CLUSTER_TERMS)) {
      terms.add(term);
    }
  }
  return terms;
}

function bodyReferencesDistinctiveTerms(body: string, peerTerms: Set<string>): number {
  if (!body.trim() || peerTerms.size === 0) return 0;
  const lower = body.toLowerCase();
  let hits = 0;
  for (const term of peerTerms) {
    if (term.length < 5) continue;
    if (lower.includes(term)) hits += 1;
  }
  const peerMentionsPyrenees = [...peerTerms].some((t) => /pyren/i.test(t));
  if (peerMentionsPyrenees && /\bp\.?\s*o(?:[\s.,;:!?)]|$)/i.test(body)) {
    hits += 1;
  }
  return hits;
}

/** Same publisher companion pieces: one article body references the other's case (title/slug terms). */
function hasCompanionCaseCrossReference(
  storyI: EnrichedStory,
  storyJ: EnrichedStory,
  featI: StoryFeatures,
  featJ: StoryFeatures,
): boolean {
  if (featI.language !== featJ.language) return false;
  const hostI = (storyI.host || getHostname(storyI.url) || '').toLowerCase();
  const hostJ = (storyJ.host || getHostname(storyJ.url) || '').toLowerCase();
  if (!hostI || hostI !== hostJ) return false;

  const pubI = storyI.publishedAt ? Date.parse(storyI.publishedAt) : NaN;
  const pubJ = storyJ.publishedAt ? Date.parse(storyJ.publishedAt) : NaN;
  if (Number.isFinite(pubI) && Number.isFinite(pubJ)) {
    const maxGapMs = 7 * 24 * 60 * 60 * 1000;
    if (Math.abs(pubI - pubJ) > maxGapMs) return false;
  }

  const termsI = distinctiveCaseTerms(storyI, featI.language);
  const termsJ = distinctiveCaseTerms(storyJ, featJ.language);
  if (termsI.size === 0 || termsJ.size === 0) return false;

  const bodyI = stripPublisherBoilerplate(storyI.articleText ?? '');
  const bodyJ = stripPublisherBoilerplate(storyJ.articleText ?? '');
  const textI = bodyI.length >= 200 ? bodyI : `${storyI.description ?? ''} ${bodyI}`.trim();
  const textJ = bodyJ.length >= 200 ? bodyJ : `${storyJ.description ?? ''} ${bodyJ}`.trim();
  const iRefsJ = bodyReferencesDistinctiveTerms(textI, termsJ);
  const jRefsI = bodyReferencesDistinctiveTerms(textJ, termsI);

  if (iRefsJ >= 1 && jRefsI >= 1) return true;
  if (iRefsJ >= 2 || jRefsI >= 2) return true;

  return false;
}

function countSharedArticleBodyProperNouns(
  storyI: EnrichedStory,
  storyJ: EnrichedStory,
  featI: StoryFeatures,
  featJ: StoryFeatures,
  entityAliasCanonicals: Set<string>,
): number {
  const bodyI = stripPublisherBoilerplate(storyI.articleText ?? '');
  const bodyJ = stripPublisherBoilerplate(storyJ.articleText ?? '');
  if (bodyI.length < 400 || bodyJ.length < 400) return 0;

  const stopI = buildStopwordSet(featI.language);
  const stopJ = buildStopwordSet(featJ.language);
  const snippetI = bodyI.slice(0, 5000);
  const snippetJ = bodyJ.slice(0, 5000);
  const properI = extractProperNounTokens(snippetI, tokenize(snippetI, stopI), stopI, featI.language);
  const properJ = extractProperNounTokens(snippetJ, tokenize(snippetJ, stopJ), stopJ, featJ.language);

  let shared = 0;
  for (const term of properI) {
    if (!properJ.has(term)) continue;
    if (entityAliasCanonicals.has(term)) continue;
    if (!isPositiveLabelTerm(term, stopI, entityAliasCanonicals)) continue;
    if (term.length < 5) continue;
    shared += 1;
  }
  return shared;
}

function subjectAliasesInText(text: string): Set<string> {
  const normalized = normalizeSubjectMatchText(text);
  const found = new Set<string>();
  for (const { canonical, aliases } of SUBJECT_ALIASES) {
    if (normalized.includes(normalizeSubjectMatchText(canonical))) {
      found.add(canonical);
      continue;
    }
    if (aliases.some((alias) => normalized.includes(normalizeSubjectMatchText(alias.text)))) {
      found.add(canonical);
    }
  }
  return found;
}

function entityAliasesInFullStoryText(story: EnrichedStory): Set<string> {
  return subjectAliasesInText(
    `${story.title} ${story.description ?? ''} ${stripPublisherBoilerplate(story.articleText ?? '')}`,
  );
}

function groupSubjectsInStoryBody(story: EnrichedStory): Set<string> {
  return new Set(
    [...subjectAliasesInText(`${story.description ?? ''} ${stripPublisherBoilerplate(story.articleText ?? '')}`)].filter(
      (canonical) => SUBJECT_GROUP_CANONICALS.has(canonical),
    ),
  );
}

function sharedQuotedPhraseWordOverlap(titleA: string, titleB: string): number {
  const emptyStop = new Set<string>();
  const wordsA = new Set<string>();
  const wordsB = new Set<string>();
  for (const phrase of extractQuotedTerms(titleA)) {
    for (const word of tokenize(phrase, emptyStop)) {
      if (word.length >= 5 && !isGenericCultClusterTerm(word, GENERIC_CULT_CLUSTER_TERMS)) {
        wordsA.add(word);
      }
    }
  }
  for (const phrase of extractQuotedTerms(titleB)) {
    for (const word of tokenize(phrase, emptyStop)) {
      if (word.length >= 5 && !isGenericCultClusterTerm(word, GENERIC_CULT_CLUSTER_TERMS)) {
        wordsB.add(word);
      }
    }
  }
  let shared = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) shared += 1;
  }
  return shared;
}

type ClusterDetectionResult = {
  groups: DetectedGroup[];
  edges: Map<number, Set<number>>;
  features: StoryFeatures[];
};

type ClusterAuditReport = {
  generatedAt: string;
  storyCount: number;
  detectedClusterCount: number;
  independentCount: number;
  missedPairs: Array<{
    reason: string;
    severity: 'high' | 'medium';
    storyA: { title: string; url: string };
    storyB: { title: string; url: string };
  }>;
  suspiciousClusters: Array<{
    label: string;
    storyCount: number;
    reason: string;
    stories: Array<{ title: string; url: string }>;
  }>;
  linkedButUngrouped: Array<{
    reason: string;
    storyA: { title: string; url: string };
    storyB: { title: string; url: string };
  }>;
};

function auditClusterGaps(
  stories: EnrichedStory[],
  classifiedGroups: StoryGroup[],
  detection: ClusterDetectionResult,
): ClusterAuditReport {
  const { edges, features } = detection;
  const indexByUrl = new Map(stories.map((story, idx) => [createDedupeKey(story.url), idx]));

  const clusteredIndexes = new Set<number>();
  for (const group of classifiedGroups) {
    if (group.type !== 'detected') continue;
    for (const story of group.stories) {
      const idx = indexByUrl.get(createDedupeKey(story.url));
      if (idx !== undefined) clusteredIndexes.add(idx);
    }
  }

  const independentIndexes = stories.map((_, idx) => idx).filter((idx) => !clusteredIndexes.has(idx));
  const missedPairs: ClusterAuditReport['missedPairs'] = [];
  const linkedButUngrouped: ClusterAuditReport['linkedButUngrouped'] = [];

  for (let a = 0; a < independentIndexes.length; a += 1) {
    for (let b = a + 1; b < independentIndexes.length; b += 1) {
      const i = independentIndexes[a];
      const j = independentIndexes[b];
      if (i === undefined || j === undefined) continue;
      const storyI = stories[i];
      const storyJ = stories[j];
      const featI = features[i];
      const featJ = features[j];
      if (!storyI || !storyJ || !featI || !featJ) continue;

      const reasons: string[] = [];
      if (hasCompanionCaseCrossReference(storyI, storyJ, featI, featJ)) {
        reasons.push('same-publisher companion cross-reference');
      }
      const aliasesI = entityAliasesInFullStoryText(storyI);
      const aliasesJ = entityAliasesInFullStoryText(storyJ);
      const sharedAliases = [...aliasesI].filter((alias) => aliasesJ.has(alias));
      if (sharedAliases.length > 0) {
        reasons.push(`shared entity in text: ${sharedAliases.join(', ')}`);
      }
      if (sharedQuotedPhraseWordOverlap(storyI.title, storyJ.title) >= 2) {
        reasons.push('shared quoted headline words');
      }
      if (sharedTitleIdentityTerms(storyI, storyJ, featI, featJ, new Set(SUBJECT_ALIASES.map((e) => e.canonical))).length > 0) {
        reasons.push('shared title identity');
      }

      if (reasons.length === 0) continue;

      missedPairs.push({
        reason: reasons.join('; '),
        severity: reasons.some((r) => r.includes('entity') || r.includes('companion')) ? 'high' : 'medium',
        storyA: { title: storyI.title, url: storyI.url },
        storyB: { title: storyJ.title, url: storyJ.url },
      });
    }
  }

  for (const i of independentIndexes) {
    for (const j of independentIndexes) {
      if (i === undefined || j === undefined || i >= j) continue;
      if (edges.get(i)?.has(j)) {
        const storyI = stories[i];
        const storyJ = stories[j];
        if (!storyI || !storyJ) continue;
        linkedButUngrouped.push({
          reason: 'adjacency edge exists but complete-linkage/coherence kept both ungrouped',
          storyA: { title: storyI.title, url: storyI.url },
          storyB: { title: storyJ.title, url: storyJ.url },
        });
      }
    }
  }

  const suspiciousClusters: ClusterAuditReport['suspiciousClusters'] = [];
  for (const group of classifiedGroups) {
    if (group.type !== 'detected') continue;
    const indexes = group.stories
      .map((s) => indexByUrl.get(createDedupeKey(s.url)))
      .filter((idx): idx is number => idx !== undefined);
    let identityPairs = 0;
    let totalPairs = 0;
    for (let a = 0; a < indexes.length; a += 1) {
      for (let b = a + 1; b < indexes.length; b += 1) {
        const idxA = indexes[a];
        const idxB = indexes[b];
        if (idxA === undefined || idxB === undefined) continue;
        totalPairs += 1;
        const storyA = stories[idxA];
        const storyB = stories[idxB];
        const featA = features[idxA];
        const featB = features[idxB];
        if (!storyA || !storyB || !featA || !featB) continue;
        if (
          sharedTitleIdentityTerms(
            storyA,
            storyB,
            featA,
            featB,
            new Set(SUBJECT_ALIASES.map((e) => e.canonical)),
          ).length > 0
        ) {
          identityPairs += 1;
        }
      }
    }
    if (totalPairs > 0 && identityPairs / totalPairs < 0.34) {
      suspiciousClusters.push({
        label: group.label,
        storyCount: group.stories.length,
        reason: 'no shared title identity across most pairs (possible bridge merge)',
        stories: group.stories.map((s) => ({ title: s.title, url: s.url })),
      });
    }
  }

  missedPairs.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'high' ? -1 : 1));

  return {
    generatedAt: new Date().toISOString(),
    storyCount: stories.length,
    detectedClusterCount: classifiedGroups.filter((g) => g.type === 'detected').length,
    independentCount: independentIndexes.length,
    missedPairs: missedPairs.slice(0, 40),
    suspiciousClusters,
    linkedButUngrouped: linkedButUngrouped.slice(0, 20),
  };
}

function groupSubjectsInFullStoryText(story: EnrichedStory): Set<string> {
  return new Set([...entityAliasesInFullStoryText(story)].filter((canonical) => SUBJECT_GROUP_CANONICALS.has(canonical)));
}

function topicSubjectsGroundedInTitle(story: EnrichedStory): Set<string> {
  return new Set(subjectAliasesGroundedInTitle(story, [...SUBJECT_TOPIC_CANONICALS]));
}

function normalizeWireStorySlug(rawUrl: string): string | undefined {
  const slug = getSlug(rawUrl);
  if (!slug) return undefined;
  return slug
    .replace(/\.amp\.html?$/i, '')
    .replace(/\.html?$/i, '')
    .replace(/_ad-\d+$/i, '');
}

function sharedWireReprintSlugLink(storyI: EnrichedStory, storyJ: EnrichedStory): boolean {
  const slugI = normalizeWireStorySlug(storyI.url);
  const slugJ = normalizeWireStorySlug(storyJ.url);
  return Boolean(slugI && slugJ && slugI === slugJ && slugI.length >= 24);
}

function groupSubjectBodyMentionCount(story: EnrichedStory, canonical: string): number {
  const body = normalizeSubjectMatchText(
    `${story.description ?? ''} ${stripPublisherBoilerplate(story.articleText ?? '')}`,
  );
  const entry = SUBJECT_ALIASES.find((candidate) => candidate.canonical === canonical);
  if (!entry) return 0;

  const needles = [canonical, ...entry.aliases.map((alias) => alias.text)].map((text) =>
    normalizeSubjectMatchText(text),
  );
  let count = 0;
  for (const needle of needles) {
    if (needle.length < 4) continue;
    let from = 0;
    for (;;) {
      const idx = body.indexOf(needle, from);
      if (idx === -1) break;
      count += 1;
      from = idx + needle.length;
    }
  }
  return count;
}

/** Shared group subject in story text + matching topic subjects in both titles, or cross-language body coverage. */
function sharedGroupPlusEventTitleLink(
  storyI: EnrichedStory,
  storyJ: EnrichedStory,
  languageI: string | undefined,
  languageJ: string | undefined,
): boolean {
  const groupsI = groupSubjectsInFullStoryText(storyI);
  const groupsJ = groupSubjectsInFullStoryText(storyJ);
  const sharedGroups = [...groupsI].filter((canonical) => groupsJ.has(canonical));
  if (sharedGroups.length === 0) {
    return false;
  }

  const topicsI = topicSubjectsGroundedInTitle(storyI);
  const topicsJ = topicSubjectsGroundedInTitle(storyJ);
  if ([...topicsI].some((canonical) => topicsJ.has(canonical))) {
    return true;
  }

  if (!languageI || !languageJ || languageI === languageJ) {
    return false;
  }

  const bodyGroupsI = groupSubjectsInStoryBody(storyI);
  const bodyGroupsJ = groupSubjectsInStoryBody(storyJ);
  const sharedBodyGroups = sharedGroups.filter(
    (canonical) => bodyGroupsI.has(canonical) && bodyGroupsJ.has(canonical),
  );
  if (sharedBodyGroups.length === 0) {
    return false;
  }

  return sharedBodyGroups.some(
    (canonical) =>
      !shouldBlockScientologySubtopicBridge(storyI, storyJ, [canonical]) &&
      groupSubjectBodyMentionCount(storyI, canonical) >= 2 &&
      groupSubjectBodyMentionCount(storyJ, canonical) >= 2,
  );
}

function hasDistinctGroupSubjectConflict(storyI: EnrichedStory, storyJ: EnrichedStory): boolean {
  const groupsI = groupSubjectsInFullStoryText(storyI);
  const groupsJ = groupSubjectsInFullStoryText(storyJ);
  if (groupsI.size === 0 || groupsJ.size === 0) {
    return false;
  }
  return ![...groupsI].some((canonical) => groupsJ.has(canonical));
}

function hasSubjectClusterBridgeLink(
  storyI: EnrichedStory,
  storyJ: EnrichedStory,
  languageI: string | undefined,
  languageJ: string | undefined,
): boolean {
  return (
    sharedWireReprintSlugLink(storyI, storyJ) ||
    sharedGroupPlusEventTitleLink(storyI, storyJ, languageI, languageJ)
  );
}

/** Absorb wire syndication / subject-bridge siblings into the seed component. */
function expandComponentWithSubjectBridges(
  component: number[],
  edges: Map<number, Set<number>>,
  stories: EnrichedStory[],
  features: StoryFeatures[],
): number[] {
  const componentSet = new Set(component);
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const idx of [...component]) {
      const storyIdx = stories[idx];
      const featIdx = features[idx];
      if (!storyIdx || !featIdx) continue;
      for (const j of edges.get(idx) ?? []) {
        if (componentSet.has(j)) continue;
        const storyJ = stories[j];
        const featJ = features[j];
        if (!storyJ || !featJ) continue;
        if (
          !hasSubjectClusterBridgeLink(storyIdx, storyJ, featIdx.language, featJ.language)
        ) {
          continue;
        }
        component.push(j);
        componentSet.add(j);
        expanded = true;
      }
    }
  }
  return component;
}

function titleHasSpeedrunSubtopic(title: string): boolean {
  return title.toLowerCase().includes('speedrun');
}

function sharedSubjectAliasViaTitleGrounding(
  storyI: EnrichedStory,
  storyJ: EnrichedStory,
  sharedAliases: string[],
): boolean {
  return sharedAliases.some(
    (alias) =>
      subjectAliasesGroundedInTitle(storyI, [alias]).length > 0 &&
      subjectAliasesGroundedInTitle(storyJ, [alias]).length > 0,
  );
}

function shouldBlockScientologySubtopicBridge(storyI: EnrichedStory, storyJ: EnrichedStory, sharedAliases: string[]): boolean {
  if (!sharedAliases.includes('scientology')) return false;
  return titleHasSpeedrunSubtopic(storyI.title) !== titleHasSpeedrunSubtopic(storyJ.title);
}

/**
 * Returns lowercased tokens that appear capitalised mid-sentence in the original text —
 * a cheap proper-noun signal. The first word of a sentence is excluded (it's always
 * capitalised) by requiring the preceding character to be a non-sentence-opening context
 * (i.e. the token must not be the very first word and must follow a space, not a period).
 */
function extractQuotedTerms(text: string): Set<string> {
  const result = new Set<string>();
  for (const quotedText of extractQuotedSpans(text)) {
    const lowerQuoted = quotedText.toLowerCase().trim();
    if (lowerQuoted.length >= 3) {
      result.add(lowerQuoted);
    }
  }
  return result;
}

/** Capitalized words in a headline (including the first word and quoted titles) — TV/film names. */
function extractTitleHeadProperNouns(title: string, stopwords: Set<string>): Set<string> {
  const result = new Set<string>();
  const pattern = /\b[\p{Lu}][\p{Ll}]+(?:[''][\p{Ll}]+)?\b/gu;
  for (const match of title.matchAll(pattern)) {
    const lower = match[0].toLowerCase();
    if (lower.length >= 4 && !isExcludedClusterProperNoun(lower, stopwords)) {
      result.add(lower);
    }
  }

  for (const quotedText of extractQuotedSpans(title)) {
    const trimmed = quotedText.trim();
    if (!trimmed) continue;
    if (!trimmed.includes(' ')) {
      const lower = trimmed.toLowerCase();
      if (lower.length >= 4 && !isExcludedClusterProperNoun(lower, stopwords)) {
        result.add(lower);
      }
      continue;
    }
    for (const word of trimmed.split(/\s+/)) {
      const lower = word.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '').toLowerCase();
      if (lower.length >= 4 && !isExcludedClusterProperNoun(lower, stopwords)) {
        result.add(lower);
      }
    }
  }

  return result;
}

function titleHeadClusterTerms(story: EnrichedStory, language: string): Set<string> {
  const stopwords = buildStopwordSet(language);
  const terms = new Set<string>();
  for (const term of extractTitleHeadProperNouns(story.title, stopwords)) {
    if (term.length >= 7 && !isGenericCultClusterTerm(term, GENERIC_CULT_CLUSTER_TERMS)) {
      terms.add(term);
    }
  }
  for (const term of extractQuotedTerms(story.title)) {
    if (term.length >= 7 && !isGenericCultClusterTerm(term, GENERIC_CULT_CLUSTER_TERMS)) {
      terms.add(term);
    }
  }
  return terms;
}

function extractProperNounTokens(original: string, tokens: string[], stopwords: Set<string>, language: string = 'en'): Set<string> {
  // Normalize special quote characters to regular quotes
  original = original.replace(/[ΓÇÿΓÇÖ]/g, "\"");
  const result = new Set<string>();
  for (const token of tokens) {
    if (isExcludedClusterProperNoun(token, stopwords)) continue;
    if (token.length < 3) continue;
    const capitalized = token[0]!.toUpperCase() + token.slice(1);
    // Match the token when preceded by a space (not sentence-start after . or start-of-string)
    const pattern = new RegExp(`(?<=[^.!?
])\\s+${capitalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[^a-z]|$)`, 'u');
    if (pattern.test(original)) {
      if (!isExcludedClusterProperNoun(token, stopwords)) {
        result.add(token);
      }
    }
  }
  
  // Extract sequences of capitalized words with stop words in between (e.g., "Ahmadi Religion of Peace and Light")
  // This captures organization names, book titles, etc. that have internal stop words
  const capitalizedWordPattern = /\b[A-Z][a-z]+\b/g;
  const capitalizedWords = [];
  let match;
  while ((match = capitalizedWordPattern.exec(original)) !== null) {
    capitalizedWords.push({ word: match[0], index: match.index });
  }
  
  // Build sequences of capitalized words (allowing stop words between them)
  // Use locale-specific stopwords from discovery lang files
  const phraseStopwords = clusterStopwordsForLanguage(language);
  
  for (let i = 0; i < capitalizedWords.length; i++) {
    const currentWord = capitalizedWords[i];
    if (!currentWord) continue;
    
    let phrase = currentWord.word;
    let phraseEndIndex = currentWord.index + currentWord.word.length;
    
    for (let j = i + 1; j < capitalizedWords.length; j++) {
      const nextWord = capitalizedWords[j];
      if (!nextWord) break;
      
      const textBetween = original.slice(phraseEndIndex, nextWord.index).trim().toLowerCase();
      
      // Allow only stop words between capitalized words
      const wordsBetween = textBetween.split(/\s+/).filter(w => w.length > 0);
      const allStopwords = wordsBetween.every(w => phraseStopwords.has(w));
      
      if (allStopwords && wordsBetween.length <= 2) {
        // Build the full phrase including stop words
        phrase += ' ' + textBetween + ' ' + nextWord.word;
        phraseEndIndex = nextWord.index + nextWord.word.length;
        
        // Add the phrase if it has at least 2 capitalized words
        const lowerPhrase = phrase.toLowerCase();
        if (
          lowerPhrase.length >= 8 &&
          !isGenericCultClusterTerm(lowerPhrase, GENERIC_CULT_CLUSTER_TERMS)
        ) {
          result.add(lowerPhrase);
        }
      } else {
        break; // Stop if non-stopword encountered
      }
    }
  }
  
  // Quoted terms (often proper nouns) — full phrase plus non-stopword tokens
  for (const quotedText of extractQuotedSpans(original)) {
    const lowerQuoted = quotedText.toLowerCase().trim();
    if (lowerQuoted.length >= 3 && !isGenericCultClusterTerm(lowerQuoted, GENERIC_CULT_CLUSTER_TERMS)) {
      result.add(lowerQuoted);
    }
    for (const word of quotedText.split(/\s+/)) {
      const lowerWord = word.toLowerCase();
      if (lowerWord.length >= 3 && !isExcludedClusterProperNoun(lowerWord, stopwords)) {
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

  const cultNames = new Set<string>();
  for (const { canonical, aliases } of SUBJECT_ALIASES) {
    cultNames.add(canonical);
    for (const alias of aliases) {
      if (!alias.lang || alias.lang === language) {
        cultNames.add(alias.text.toLowerCase());
      }
    }
  }

  for (const quotedText of extractQuotedSpans(text)) {
    const phrase = quotedText.toLowerCase();
    const phraseTokens = phrase.split(/\s+/).filter((t) => t.length >= 3);

    const hasCultName = phraseTokens.some((t) => cultNames.has(t));
    if (!hasCultName) continue;

    const remainingTokens = phraseTokens.filter((t) => !cultNames.has(t));

    for (const token of remainingTokens) {
      result.add(token);
      if (token.length > 5 && token.endsWith('s') && !token.endsWith('ss')) {
        result.add(token.slice(0, -1));
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
    const articleRaw = stripPublisherBoilerplate(story.articleText ?? '');
    const articleTokens = tokenize(articleRaw, stopwords).slice(0, 500);

    addTokens(termCounts, titleTokens, 3);
    addTokens(termCounts, descriptionTokens, 1);
    addTokens(termCounts, articleTokens, 0.4);

    addNgrams(termCounts, titleTokens, 2, 2);
    addNgrams(termCounts, titleTokens, 3, 1);
    addNgrams(termCounts, descriptionTokens, 2, 1.3);
    addNgrams(termCounts, descriptionTokens, 3, 0.9);
    addNgrams(termCounts, articleTokens, 2, 0.3);

    const titleProperNouns = extractProperNounTokens(story.title, titleTokens, stopwords, language);
    const descProperNouns = extractProperNounTokens(story.description ?? '', descriptionTokens, stopwords, language);
    
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
      ...urlProperNouns,
      ...properNounBigrams,
      ...titleQuotedTerms,
    ]);

    for (let i = 0; i < titleTokens.length - 1; i += 1) {
      const bigram = `${titleTokens[i]} ${titleTokens[i + 1]}`;
      if (bigram.length >= 8 && isClusterSignalBigram(bigram, GENERIC_CULT_CLUSTER_TERMS)) {
        anchorTerms.add(bigram);
      }
    }

    for (const term of extractTitleHeadProperNouns(story.title, stopwords)) {
      anchorTerms.add(term);
    }

    const headlineText = `${story.title} ${story.description ?? ''}`;
    injectEntityAliases(headlineText, language, termCounts, anchorTerms, 6);
    if (articleRaw) {
      injectEntityAliases(articleRaw, language, termCounts, new Set(), 0.4);
    }

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
    if (isGenericCultClusterTerm(term, GENERIC_CULT_CLUSTER_TERMS)) {
      continue;
    }
    if ((idf.get(term) ?? 0) < 1.0) {
      continue;
    }
    shared += 1;
  }

  return shared;
}

/** Canonical subject-aliases present in a story's anchor terms. */
function subjectAliasesInAnchorTerms(anchorTerms: Set<string>): string[] {
  const canonicals = new Set(SUBJECT_ALIASES.map((e) => e.canonical));
  return [...anchorTerms].filter((t) => canonicals.has(t));
}

/**
 * Block clustering when stories name different tracked groups in their headlines.
 * Body-only alias mentions (e.g. Plymouth Brethren discussed inside an Unchosen review) are ignored.
 */
function subjectAliasesGroundedInTitle(story: EnrichedStory, aliases: string[]): string[] {
  const titleLower = normalizeSubjectMatchText(story.title);
  return aliases.filter((canonical) => {
    if (titleLower.includes(normalizeSubjectMatchText(canonical))) return true;
    const entry = SUBJECT_ALIASES.find((e) => e.canonical === canonical);
    if (!entry) return false;
    return entry.aliases.some((alias) => titleLower.includes(normalizeSubjectMatchText(alias.text)));
  });
}

function hasSubjectAliasClusterConflict(
  aliasesA: string[],
  aliasesB: string[],
  storyA: EnrichedStory,
  storyB: EnrichedStory,
): boolean {
  const setA = new Set(subjectAliasesGroundedInTitle(storyA, aliasesA));
  const setB = new Set(subjectAliasesGroundedInTitle(storyB, aliasesB));
  if (setA.size === 0 && setB.size === 0) {
    return false;
  }
  if (setA.size === 0 || setB.size === 0) {
    return true;
  }
  for (const alias of setA) {
    if (setB.has(alias)) {
      return false;
    }
  }
  return true;
}

function sharedTitleIdentityTerms(
  storyI: EnrichedStory,
  storyJ: EnrichedStory,
  featI: StoryFeatures,
  featJ: StoryFeatures,
  entityAliasCanonicals: Set<string>,
): string[] {
  const iTitleQuoted = extractQuotedTerms(storyI.title);
  const jTitleQuoted = extractQuotedTerms(storyJ.title);
  const quoted = [...iTitleQuoted].filter(
    (t) =>
      t.length >= 7 &&
      jTitleQuoted.has(t) &&
      !isGenericCultClusterTerm(t, GENERIC_CULT_CLUSTER_TERMS),
  );
  const headI = extractTitleHeadProperNouns(storyI.title, buildStopwordSet(featI.language));
  const headJ = extractTitleHeadProperNouns(storyJ.title, buildStopwordSet(featJ.language));
  const heads = [...headI].filter(
    (t) =>
      t.length >= 7 &&
      headJ.has(t) &&
      !isGenericCultClusterTerm(t, GENERIC_CULT_CLUSTER_TERMS) &&
      !entityAliasCanonicals.has(t),
  );
  return [...quoted, ...heads];
}

function buildAdjacency(features: StoryFeatures[], idf: Map<string, number>, stories: EnrichedStory[]): Map<number, Set<number>> {
  const edges = new Map<number, Set<number>>();
  const strictThreshold = 0.42;
  const relaxedThreshold = 0.18;
  const anchorMinSimilarity = 0.20;
  const entityAliasCanonicals = new Set(SUBJECT_ALIASES.map((e) => e.canonical));

  for (let i = 0; i < features.length; i += 1) {
    for (let j = i + 1; j < features.length; j += 1) {
      const featI = features[i];
      const featJ = features[j];
      const storyI = stories[i];
      const storyJ = stories[j];
      if (!featI || !featJ || !storyI || !storyJ) {
        continue;
      }

      const entityAliasesI = subjectAliasesInAnchorTerms(featI.anchorTerms);
      const entityAliasesJ = subjectAliasesInAnchorTerms(featJ.anchorTerms);
      const hasEntityAliasMatch = entityAliasesI.some((t) => entityAliasesJ.includes(t));

      // Shared capitalized / quoted title token — link before group-subject conflict checks.
      if (
        sharedTitleIdentityTerms(storyI, storyJ, featI, featJ, entityAliasCanonicals).length >= 1
      ) {
        const left = edges.get(i) ?? new Set<number>();
        const right = edges.get(j) ?? new Set<number>();
        left.add(j);
        right.add(i);
        edges.set(i, left);
        edges.set(j, right);
        continue;
      }

      if (hasDistinctGroupSubjectConflict(storyI, storyJ)) {
        if (sharedWireReprintSlugLink(storyI, storyJ)) {
          const left = edges.get(i) ?? new Set<number>();
          const right = edges.get(j) ?? new Set<number>();
          left.add(j);
          right.add(i);
          edges.set(i, left);
          edges.set(j, right);
        }
        continue;
      }

      const similarity = cosineSimilarity(featI, featJ, idf);
      const sharedRareAnchorTerms = countSharedRareAnchorTerms(featI, featJ, idf);

      const sameLanguage = featI.language === featJ.language;

      if (hasCompanionCaseCrossReference(storyI, storyJ, featI, featJ)) {
        const left = edges.get(i) ?? new Set<number>();
        const right = edges.get(j) ?? new Set<number>();
        left.add(j);
        right.add(i);
        edges.set(i, left);
        edges.set(j, right);
        continue;
      }

      if (
        sharedGroupPlusEventTitleLink(storyI, storyJ, featI.language, featJ.language) ||
        sharedWireReprintSlugLink(storyI, storyJ)
      ) {
        const left = edges.get(i) ?? new Set<number>();
        const right = edges.get(j) ?? new Set<number>();
        left.add(j);
        right.add(i);
        edges.set(i, left);
        edges.set(j, right);
        continue;
      }

      const textAliasesI = entityAliasesInFullStoryText(storyI);
      const textAliasesJ = entityAliasesInFullStoryText(storyJ);
      const sharedTextAliases = [...textAliasesI].filter((alias) => textAliasesJ.has(alias));
      if (
        sharedTextAliases.length > 0 &&
        !hasSubjectAliasClusterConflict(entityAliasesI, entityAliasesJ, storyI, storyJ) &&
        !shouldBlockScientologySubtopicBridge(storyI, storyJ, sharedTextAliases) &&
        sharedSubjectAliasViaTitleGrounding(storyI, storyJ, sharedTextAliases)
      ) {
        const left = edges.get(i) ?? new Set<number>();
        const right = edges.get(j) ?? new Set<number>();
        left.add(j);
        right.add(i);
        edges.set(i, left);
        edges.set(j, right);
        continue;
      }

      if (sharedQuotedPhraseWordOverlap(storyI.title, storyJ.title) >= 2) {
        const left = edges.get(i) ?? new Set<number>();
        const right = edges.get(j) ?? new Set<number>();
        left.add(j);
        right.add(i);
        edges.set(i, left);
        edges.set(j, right);
        continue;
      }

      if (hasSubjectAliasClusterConflict(entityAliasesI, entityAliasesJ, storyI, storyJ)) {
        continue;
      }

      const sharedEntityAliases = entityAliasesI.filter((a) => entityAliasesJ.includes(a));
      if (sharedEntityAliases.length > 0) {
        const sharedSubtopic = [...featI.anchorTerms].filter((t) => {
          if (!featJ.anchorTerms.has(t)) return false;
          if (entityAliasCanonicals.has(t)) return false;
          if (isGenericCultClusterTerm(t, GENERIC_CULT_CLUSTER_TERMS)) return false;
          if (t.includes(' ')) {
            return (
              isClusterSignalBigram(t, GENERIC_CULT_CLUSTER_TERMS) &&
              storyI.title.toLowerCase().includes(t) &&
              storyJ.title.toLowerCase().includes(t)
            );
          }
          return isClusterSignalUnigram(t, GENERIC_CULT_CLUSTER_TERMS, entityAliasCanonicals) && t.length >= 5;
        });

        const iTitleQuoted = extractQuotedTerms(storyI.title);
        const jTitleQuoted = extractQuotedTerms(storyJ.title);
        const sharedTitleQuoted = [...iTitleQuoted].filter(
          (t) =>
            t.length >= 7 &&
            jTitleQuoted.has(t) &&
            !isGenericCultClusterTerm(t, GENERIC_CULT_CLUSTER_TERMS),
        );

        const headI = extractTitleHeadProperNouns(storyI.title, buildStopwordSet(featI.language));
        const headJ = extractTitleHeadProperNouns(storyJ.title, buildStopwordSet(featJ.language));
        const sharedTitleHead = [...headI].filter(
          (t) =>
            t.length >= 7 &&
            headJ.has(t) &&
            !isGenericCultClusterTerm(t, GENERIC_CULT_CLUSTER_TERMS) &&
            !entityAliasCanonicals.has(t),
        );

        if (sharedSubtopic.length >= 1 || sharedTitleQuoted.length >= 1 || sharedTitleHead.length >= 1) {
          const left = edges.get(i) ?? new Set<number>();
          const right = edges.get(j) ?? new Set<number>();
          left.add(j);
          right.add(i);
          edges.set(i, left);
          edges.set(j, right);
          continue;
        }
        // Same entity without a shared subtopic in headlines — do not merge.
      }

      // Count non-entity-alias shared terms
      let nonAliasShared = 0;
      for (const term of featI.anchorTerms) {
        if (
          featJ.anchorTerms.has(term) &&
          !entityAliasCanonicals.has(term) &&
          term.length >= 4 &&
          !isGenericCultClusterTerm(term, GENERIC_CULT_CLUSTER_TERMS)
        ) {
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
      const hasQuotedTermsI = featI.quotedPhraseTerms.size > 0;
      const hasQuotedTermsJ = featJ.quotedPhraseTerms.size > 0;
      const hasMismatchedQuotedTerms = hasEntityAliasMatch &&
                                     ((hasQuotedTermsI && !hasQuotedTermsJ) ||
                                      (!hasQuotedTermsI && hasQuotedTermsJ) ||
                                      (hasQuotedTermsI && hasQuotedTermsJ &&
                                       ![...featI.quotedPhraseTerms].some(t => featJ.quotedPhraseTerms.has(t))));

      // Check if stories share any quoted phrase terms (quoted proper nouns are strong clustering signal)
      const sharedQuotedTerms = [...featI.quotedPhraseTerms].filter(t => featJ.quotedPhraseTerms.has(t));
      const hasSharedQuotedTerm = sharedQuotedTerms.length > 0;

      // PRIMARY CLUSTERING SIGNAL: Shared proper noun bigrams (e.g., "hannah murray", "game of thrones")
      // If stories share 2+ proper noun bigrams, link them regardless of language or similarity
      const sharedProperNounBigrams = [...featI.anchorTerms].filter(
        (t) =>
          featJ.anchorTerms.has(t) &&
          isClusterSignalBigram(t, GENERIC_CULT_CLUSTER_TERMS),
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

      // PRIMARY CLUSTERING SIGNAL 2: Shared quoted proper noun unigram (e.g., "Artgemeinschaft")
      // If stories share a proper noun that appears in quotes in both titles, link them regardless of language
      // This handles single-word proper nouns like "Artgemeinschaft" that are quoted in titles
      // Extract quoted terms from both titles and check for overlap
      const iTitleQuoted = extractQuotedTerms(storyI.title);
      const jTitleQuoted = extractQuotedTerms(storyJ.title);
      const sharedTitleQuoted = [...iTitleQuoted].filter(
        (t) =>
          t.length >= 7 &&
          jTitleQuoted.has(t) &&
          !isGenericCultClusterTerm(t, GENERIC_CULT_CLUSTER_TERMS),
      );
      
      if (sharedTitleQuoted.length >= 1) {
        const left = edges.get(i) ?? new Set<number>();
        const right = edges.get(j) ?? new Set<number>();
        left.add(j);
        right.add(i);
        edges.set(i, left);
        edges.set(j, right);
        continue;
      }

      // PRIMARY CLUSTERING SIGNAL 3: Shared title bigram (e.g. "cull pets", "speedrun scientology")
      const sharedTitleBigrams = [...featI.anchorTerms].filter(
        (t) =>
          t.includes(' ') &&
          featJ.anchorTerms.has(t) &&
          isClusterSignalBigram(t, GENERIC_CULT_CLUSTER_TERMS) &&
          storyI.title.toLowerCase().includes(t) &&
          storyJ.title.toLowerCase().includes(t),
      );

      if (sharedTitleBigrams.length >= 1) {
        const left = edges.get(i) ?? new Set<number>();
        const right = edges.get(j) ?? new Set<number>();
        left.add(j);
        right.add(i);
        edges.set(i, left);
        edges.set(j, right);
        continue;
      }

      // PRIMARY CLUSTERING SIGNAL 4: Shared capitalized title head (e.g. Unchosen without quotes)
      const headI = extractTitleHeadProperNouns(storyI.title, buildStopwordSet(featI.language));
      const headJ = extractTitleHeadProperNouns(storyJ.title, buildStopwordSet(featJ.language));
      const sharedTitleHead = [...headI].filter(
        (t) =>
          t.length >= 7 &&
          headJ.has(t) &&
          !isGenericCultClusterTerm(t, GENERIC_CULT_CLUSTER_TERMS) &&
          !entityAliasCanonicals.has(t),
      );

      if (sharedTitleHead.length >= 1) {
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
      const sharedProperNounUnigrams = [...featI.anchorTerms].filter(
        (t) =>
          featJ.anchorTerms.has(t) &&
          isClusterSignalUnigram(t, GENERIC_CULT_CLUSTER_TERMS, entityAliasCanonicals),
      );
      const sharedSignalBigrams = [...featI.anchorTerms].filter(
        (t) =>
          featJ.anchorTerms.has(t) &&
          isClusterSignalBigram(t, GENERIC_CULT_CLUSTER_TERMS),
      );
      // Unigrams alone often reflect publisher chrome (same site template), not the same story.
      if (
        sharedProperNounUnigrams.length >= 3 &&
        sharedSignalBigrams.length >= 1 &&
        similarity >= 0.10
      ) {
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
      const iQuotedBigrams = [...featI.quotedPhraseTerms].filter(t => t.includes(' ') && t.length >= 8);
      const jQuotedBigrams = [...featJ.quotedPhraseTerms].filter(t => t.includes(' ') && t.length >= 8);
      const sharedQuotedBigrams = iQuotedBigrams.filter(t => featJ.quotedPhraseTerms.has(t));
      
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

      // Block linking if stories have mismatched quoted phrase terms
      if (hasMismatchedQuotedTerms) {
        continue;
      }

      if (!shouldLink) {
        continue;
      }

      // Cosine / rare-term overlap alone is not enough (publisher templates, section nav).
      if (
        !hasEntityAliasMatch &&
        sharedSignalBigrams.length < 1 &&
        sharedTitleQuoted.length < 1 &&
        sharedProperNounBigrams.length < 2
      ) {
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

function isClusterCoherent(component: number[], features: StoryFeatures[], idf: Map<string, number>, hasEntityAliasOverlap = false): boolean {
  if (component.length <= 2) return true;
  // For clusters with entity alias overlap, use much lower coherence threshold
  // since cross-language stories naturally have low cosine similarity
  const threshold = hasEntityAliasOverlap ? 0.001 : MIN_CLUSTER_COHERENCE;
  let totalSim = 0;
  let pairs = 0;
  for (let i = 0; i < component.length; i += 1) {
    for (let j = i + 1; j < component.length; j += 1) {
      const idxI = component[i];
      const idxJ = component[j];
      const featI = idxI !== undefined ? features[idxI] : undefined;
      const featJ = idxJ !== undefined ? features[idxJ] : undefined;
      if (!featI || !featJ) {
        continue;
      }
      totalSim += cosineSimilarity(featI, featJ, idf);
      pairs += 1;
    }
  }
  return pairs === 0 || totalSim / pairs >= threshold;
}

function isPositiveLabelTerm(
  term: string,
  stopwords: Set<string>,
  entityAliasCanonicals: Set<string>,
): boolean {
  if (!term || isClusterStopword(term, stopwords)) return false;
  if (isHeadlineElisionLikeToken(term)) return false;
  if (entityAliasCanonicals.has(term)) return true;
  if (isGenericCultClusterTerm(term, GENERIC_CULT_CLUSTER_TERMS)) return false;
  const words = term.split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0 || words.some((word) => isClusterStopword(word, stopwords))) return false;
  if (term.includes(' ')) {
    if (!isClusterSignalBigram(term, GENERIC_CULT_CLUSTER_TERMS)) return false;
    return words.some((word) => word.length >= 6 || entityAliasCanonicals.has(word));
  }
  return isClusterSignalUnigram(term, GENERIC_CULT_CLUSTER_TERMS, entityAliasCanonicals) && term.length >= 5;
}

function subjectAliasCoverageInStories(
  storyIndexes: number[],
  stories: EnrichedStory[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const idx of storyIndexes) {
    const story = stories[idx];
    if (!story) continue;
    const text = `${story.title} ${story.description ?? ''} ${story.articleText ?? ''}`.toLowerCase();
    for (const { canonical, aliases } of SUBJECT_ALIASES) {
      const mentioned =
        text.includes(canonical) ||
        aliases.some((alias) => text.includes(alias.text.toLowerCase()));
      if (mentioned) {
        counts.set(canonical, (counts.get(canonical) ?? 0) + 1);
      }
    }
  }
  return counts;
}

function pickSharedTitleSubtopicQualifier(
  storyIndexes: number[],
  stories: EnrichedStory[],
  features: StoryFeatures[],
  entityAliasCanonicals: Set<string>,
  entityCanonical: string,
  minimumCoverage: number,
): string | undefined {
  const counts = new Map<string, number>();
  for (const idx of storyIndexes) {
    const story = stories[idx];
    const feature = features[idx];
    if (!story || !feature) continue;
    const stopwords = buildStopwordSet(feature.language);
    const titleLower = story.title.toLowerCase();
    const seenInStory = new Set<string>();

    for (const term of extractTitleHeadProperNouns(story.title, stopwords)) {
      if (term === entityCanonical || entityAliasCanonicals.has(term)) continue;
      if (!isPositiveLabelTerm(term, stopwords, entityAliasCanonicals)) continue;
      seenInStory.add(term);
    }
    for (const term of feature.anchorTerms) {
      if (term === entityCanonical || entityAliasCanonicals.has(term)) continue;
      if (!titleLower.includes(term)) continue;
      if (!isPositiveLabelTerm(term, stopwords, entityAliasCanonicals)) continue;
      seenInStory.add(term);
    }

    for (const term of seenInStory) {
      counts.set(term, (counts.get(term) ?? 0) + 1);
    }
  }
  const best = [...counts.entries()]
    .filter(([, count]) => count >= minimumCoverage)
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0];
  return best?.[0];
}

function pickSharedArticleProperNounLabel(
  storyIndexes: number[],
  stories: EnrichedStory[],
  features: StoryFeatures[],
  idf: Map<string, number>,
  minimumCoverage: number,
  entityAliasCanonicals: Set<string>,
): string | undefined {
  const counts = new Map<string, number>();
  for (const idx of storyIndexes) {
    const story = stories[idx];
    const feature = features[idx];
    if (!story?.articleText?.trim()) continue;
    const language = feature?.language ?? 'en';
    const stopwords = buildStopwordSet(language);
    const snippet = story.articleText.slice(0, 4000);
    const tokens = tokenize(snippet, stopwords);
    const proper = extractProperNounTokens(snippet, tokens, stopwords, language);
    const seenInStory = new Set<string>();

    for (const term of proper) {
      if (entityAliasCanonicals.has(term)) continue;
      if (!isPositiveLabelTerm(term, stopwords, entityAliasCanonicals)) continue;
      seenInStory.add(term);
    }

    for (const term of seenInStory) {
      counts.set(term, (counts.get(term) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .filter(([, count]) => count >= minimumCoverage)
    .sort(
      (a, b) =>
        b[1] - a[1] ||
        (idf.get(b[0]) ?? 0) - (idf.get(a[0]) ?? 0) ||
        b[0].length - a[0].length,
    )[0]?.[0];
}

function pickBestSharedTitleProperNoun(
  storyIndexes: number[],
  stories: EnrichedStory[],
  features: StoryFeatures[],
  idf: Map<string, number>,
  minimumCoverage: number,
  entityAliasCanonicals: Set<string>,
): string | undefined {
  const counts = new Map<string, number>();
  for (const idx of storyIndexes) {
    const story = stories[idx];
    const feature = features[idx];
    if (!story || !feature) continue;
    const stopwords = buildStopwordSet(feature.language);
    const seenInStory = new Set<string>();

    for (const term of extractTitleHeadProperNouns(story.title, stopwords)) {
      if (term.length < 7 || !isPositiveLabelTerm(term, stopwords, entityAliasCanonicals)) continue;
      seenInStory.add(term);
    }
    for (const term of extractQuotedTerms(story.title)) {
      if (term.length < 7 || !isPositiveLabelTerm(term, stopwords, entityAliasCanonicals)) continue;
      seenInStory.add(term);
    }

    for (const term of seenInStory) {
      counts.set(term, (counts.get(term) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .filter(([, count]) => count >= minimumCoverage)
    .sort(
      (a, b) =>
        b[1] - a[1] ||
        (idf.get(b[0]) ?? 0) - (idf.get(a[0]) ?? 0) ||
        b[0].length - a[0].length,
    )[0]?.[0];
}

function isPositiveBigramLabelTerm(
  term: string,
  stopwords: Set<string>,
): boolean {
  if (!term.includes(' ') || term.length < 8) return false;
  if (!isClusterSignalBigram(term, GENERIC_CULT_CLUSTER_TERMS)) return false;
  const words = term.split(/\s+/).filter((word) => word.length > 0);
  if (words.length < 2 || words.some((word) => isClusterStopword(word, stopwords))) return false;
  return true;
}

function isCapitalizedPhraseInTitle(title: string, phrase: string): boolean {
  const words = phrase.trim().split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) return false;
  const pattern = words
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\s+');
  const match = title.match(new RegExp(`\\b${pattern}\\b`, 'iu'));
  if (!match) return false;
  return match[0]
    .split(/\s+/)
    .every((word) => /^\p{Lu}/u.test(word.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '')));
}

function pickSharedTitleBigramLabel(
  storyIndexes: number[],
  stories: EnrichedStory[],
  features: StoryFeatures[],
  minimumCoverage: number,
  entityAliasCanonicals: Set<string>,
  idf: Map<string, number>,
): string | undefined {
  const counts = new Map<string, number>();
  const capitalizedCounts = new Map<string, number>();
  for (const idx of storyIndexes) {
    const story = stories[idx];
    const feature = features[idx];
    if (!story || !feature) continue;
    const stopwords = buildStopwordSet(feature.language);
    const titleLower = story.title.toLowerCase();
    const seenInStory = new Set<string>();
    for (const term of feature.anchorTerms) {
      if (!term.includes(' ') || term.length < 8) continue;
      if (!titleLower.includes(term)) continue;
      if (!isPositiveBigramLabelTerm(term, stopwords)) continue;
      seenInStory.add(term);
    }
    for (const term of seenInStory) {
      counts.set(term, (counts.get(term) ?? 0) + 1);
      if (isCapitalizedPhraseInTitle(story.title, term)) {
        capitalizedCounts.set(term, (capitalizedCounts.get(term) ?? 0) + 1);
      }
    }
  }

  const candidates = [...counts.entries()].filter(([, count]) => count >= minimumCoverage);
  const capitalizedCandidates = candidates.filter(
    ([term]) => (capitalizedCounts.get(term) ?? 0) >= minimumCoverage,
  );
  const pool = capitalizedCandidates.length > 0 ? capitalizedCandidates : candidates;

  return pool.sort(
    (a, b) =>
      b[1] - a[1] ||
      (idf.get(b[0]) ?? 0) - (idf.get(a[0]) ?? 0) ||
      b[0].length - a[0].length,
  )[0]?.[0];
}

function isRedundantClusterQualifier(canonical: string, qualifier: string): boolean {
  const c = canonical.toLowerCase().trim();
  const q = qualifier.toLowerCase().trim();
  if (!c || !q) return true;
  if (c.includes(q) || q.includes(c)) return true;
  const canonicalWords = new Set(c.split(/\s+/).filter((word) => word.length >= 3));
  const qualifierWords = q.split(/\s+/).filter((word) => word.length >= 3);
  return qualifierWords.length > 0 && qualifierWords.every((word) => canonicalWords.has(word));
}

function selectGroupLabel(
  features: StoryFeatures[],
  storyIndexes: number[],
  idf: Map<string, number>,
  stories: EnrichedStory[],
): string {
  const entityAliasCanonicals = new Set(SUBJECT_ALIASES.map((e) => e.canonical));
  const minimumCoverage = Math.max(2, Math.ceil(storyIndexes.length * 0.5));
  const aliasCoverage = subjectAliasCoverageInStories(storyIndexes, stories);
  const dominantAlias = [...aliasCoverage.entries()]
    .filter(([, count]) => count >= minimumCoverage)
    .sort((a, b) => b[1] - a[1])[0];

  if (dominantAlias) {
    const qualifier = pickSharedTitleSubtopicQualifier(
      storyIndexes,
      stories,
      features,
      entityAliasCanonicals,
      dominantAlias[0],
      minimumCoverage,
    );
    if (qualifier && !isRedundantClusterQualifier(dominantAlias[0], qualifier)) {
      return `${toTitleCase(dominantAlias[0])} ${toTitleCase(qualifier)}`;
    }
    return toTitleCase(dominantAlias[0]);
  }

  const bigramLabel = pickSharedTitleBigramLabel(
    storyIndexes,
    stories,
    features,
    minimumCoverage,
    entityAliasCanonicals,
    idf,
  );
  if (bigramLabel) {
    return toTitleCase(bigramLabel);
  }

  const properNounLabel = pickBestSharedTitleProperNoun(
    storyIndexes,
    stories,
    features,
    idf,
    minimumCoverage,
    entityAliasCanonicals,
  );
  if (properNounLabel) {
    return toTitleCase(properNounLabel);
  }

  const companionLabel = pickCompanionClusterLabel(storyIndexes, stories, features, idf);
  if (companionLabel) {
    return companionLabel;
  }

  return 'Detected Cluster';
}

function pickCompanionClusterLabel(
  storyIndexes: number[],
  stories: EnrichedStory[],
  features: StoryFeatures[],
  idf: Map<string, number>,
): string | undefined {
  if (storyIndexes.length !== 2) return undefined;
  const idxA = storyIndexes[0];
  const idxB = storyIndexes[1];
  if (idxA === undefined || idxB === undefined) return undefined;
  const storyA = stories[idxA];
  const storyB = stories[idxB];
  const featA = features[idxA];
  const featB = features[idxB];
  if (!storyA || !storyB || !featA || !featB) return undefined;
  if (!hasCompanionCaseCrossReference(storyA, storyB, featA, featB)) return undefined;

  const termsA = distinctiveCaseTerms(storyA, featA.language);
  const termsB = distinctiveCaseTerms(storyB, featB.language);
  const shared = [...termsA].filter(
    (term) => termsB.has(term) && term.length >= 5 && !isHeadlineElisionLikeToken(term),
  );
  if (shared.length > 0) {
    const best = shared.sort(
      (a, b) => (idf.get(b) ?? 0) - (idf.get(a) ?? 0) || b.length - a.length,
    )[0];
    if (best) return toTitleCase(best);
  }

  const host = (storyA.host || getHostname(storyA.url) || '').replace(/^www\./i, '').split('.')[0];
  return host ? toTitleCase(host) : undefined;
}

function detectStoryClusters(stories: EnrichedStory[]): ClusterDetectionResult {
  const features = buildStoryFeatures(stories);
  const idf = buildIdf(features);
  const entityAliasCanonicals = new Set(SUBJECT_ALIASES.map((e) => e.canonical));
  const edges = buildAdjacency(features, idf, stories);
  const groups: DetectedGroup[] = [];
  const assigned = new Set<number>();

  // Complete-linkage: a candidate can only join a cluster if it links to ALL
  // current members, not just one. This prevents transitive-bridge merges.
  for (let i = 0; i < features.length; i += 1) {
    if (assigned.has(i)) continue;

    const neighbors = edges.get(i) ?? new Set<number>();
    if (neighbors.size === 0) continue;

    // Seed cluster with i and its direct neighbours, then absorb topic/wire siblings (e.g. bol.uol ↔ noticias.uol).
    let component: number[] = expandComponentWithSubjectBridges([i, ...neighbors], edges, stories, features);

    // Check if component has multiple languages and shares proper noun bigrams
    const componentLanguages = new Set(
      component.flatMap((idx) => {
        const feat = features[idx];
        return feat ? [feat.language] : [];
      }),
    );
    const isCrossLanguage = componentLanguages.size > 1;
    
    // Check if component has significant proper noun bigram overlap (strong cross-language signal)
    // Instead of requiring ALL stories to share bigrams, check if enough pairs share bigrams
    let bigramEdgeCount = 0;
    for (let a = 0; a < component.length; a++) {
      for (let b = a + 1; b < component.length; b++) {
        const idxA = component[a];
        const idxB = component[b];
        if (idxA === undefined || idxB === undefined) {
          continue;
        }
        const featA = features[idxA];
        const featB = features[idxB];
        if (!featA || !featB) {
          continue;
        }
        const shared = [...featA.anchorTerms].filter(
          (t) => featB.anchorTerms.has(t) && isClusterSignalBigram(t, GENERIC_CULT_CLUSTER_TERMS),
        );
        if (shared.length >= 2) {
          bigramEdgeCount++;
        }
      }
    }
    const totalPairs = (component.length * (component.length - 1)) / 2;
    const bigramEdgeRatio = totalPairs > 0 ? bigramEdgeCount / totalPairs : 0;
    const hasSignificantBigramOverlap = bigramEdgeRatio >= 0.3; // At least 30% of pairs share 2+ bigrams
    
    // Check if component has significant quoted title term overlap (alternative cross-language signal)
    // This handles single-word proper nouns like "Artgemeinschaft" that are quoted in titles
    let quotedTermEdgeCount = 0;
    for (let a = 0; a < component.length; a++) {
      for (let b = a + 1; b < component.length; b++) {
        const idxA = component[a];
        const idxB = component[b];
        if (idxA === undefined || idxB === undefined) {
          continue;
        }
        const storyA = stories[idxA];
        const storyB = stories[idxB];
        if (!storyA || !storyB) {
          continue;
        }
        const quotedTermsA = extractQuotedTerms(storyA.title);
        const quotedTermsB = extractQuotedTerms(storyB.title);
        const sharedQuoted = [...quotedTermsA].filter(
          (t) =>
            t.length >= 7 &&
            quotedTermsB.has(t) &&
            !isGenericCultClusterTerm(t, GENERIC_CULT_CLUSTER_TERMS),
        );
        if (sharedQuoted.length >= 1) {
          quotedTermEdgeCount++;
        }
      }
    }
    const quotedTermEdgeRatio = totalPairs > 0 ? quotedTermEdgeCount / totalPairs : 0;
    const hasSignificantQuotedTermOverlap = quotedTermEdgeRatio >= 0.3;

    let titleHeadEdgeCount = 0;
    for (let a = 0; a < component.length; a++) {
      for (let b = a + 1; b < component.length; b++) {
        const idxA = component[a];
        const idxB = component[b];
        if (idxA === undefined || idxB === undefined) continue;
        const storyA = stories[idxA];
        const storyB = stories[idxB];
        const featA = features[idxA];
        const featB = features[idxB];
        if (!storyA || !storyB || !featA || !featB) continue;
        if (
          sharedTitleIdentityTerms(storyA, storyB, featA, featB, entityAliasCanonicals).length >= 1
        ) {
          titleHeadEdgeCount++;
        }
      }
    }
    const titleHeadEdgeRatio = totalPairs > 0 ? titleHeadEdgeCount / totalPairs : 0;
    const hasSignificantTitleHeadOverlap = titleHeadEdgeRatio >= 0.3;

    // Iteratively prune members that don't link to required percentage of others.
    // Pure complete-linkage (100%) is too strict for cross-language clusters;
    // majority-linkage prevents transitive bridges while still allowing near-cliques.
    // Cross-language clusters with shared proper noun bigrams OR quoted/title-head terms use lower threshold (60%).
    const majorityThreshold =
      isCrossLanguage &&
      (hasSignificantBigramOverlap || hasSignificantQuotedTermOverlap || hasSignificantTitleHeadOverlap)
        ? 0.6
        : 0.8;
    let changed = true;
    let iterationCount = 0;
    
    while (changed) {
      iterationCount++;
      changed = false;
      const next: number[] = [];
      
      for (const a of component) {
        const featA = features[a];
        const storyA = stories[a];
        if (!featA || !storyA) {
          changed = true;
          continue;
        }

        const aEdges = edges.get(a) ?? new Set<number>();
        const others = component.filter((b) => b !== a);
        const linkedCount = others.filter((b) => aEdges.has(b)).length;
        const linkRatio = others.length === 0 ? 1 : linkedCount / others.length;

        const topicBridgeLinked = others.some((b) => {
          const storyB = stories[b];
          const featB = features[b];
          return (
            storyB &&
            featB &&
            hasSubjectClusterBridgeLink(storyA, storyB, featA.language, featB.language)
          );
        });
        if (topicBridgeLinked) {
          next.push(a);
          continue;
        }
        
        // Additional check: if story shares proper noun bigrams with enough others, keep it even if linkRatio is lower
        const bigramSharedCount = others.filter((b) => {
          const featB = features[b];
          if (!featB) {
            return false;
          }
          const shared = [...featA.anchorTerms].filter(
            (t) => featB.anchorTerms.has(t) && isClusterSignalBigram(t, GENERIC_CULT_CLUSTER_TERMS),
          );
          return shared.length >= 2;
        }).length;
        const bigramRatio = others.length === 0 ? 1 : bigramSharedCount / others.length;
        
        // Additional check: if story shares quoted title terms with enough others, keep it even if linkRatio is lower
        const aTitleQuoted = extractQuotedTerms(storyA.title);
        const titleQuotedSharedCount = others.filter((b) => {
          const storyB = stories[b];
          if (!storyB) {
            return false;
          }
          const bTitleQuoted = extractQuotedTerms(storyB.title);
          const shared = [...aTitleQuoted].filter(
            (t) =>
              t.length >= 7 &&
              bTitleQuoted.has(t) &&
              !isGenericCultClusterTerm(t, GENERIC_CULT_CLUSTER_TERMS),
          );
          return shared.length >= 1;
        }).length;
        const titleQuotedRatio = others.length === 0 ? 1 : titleQuotedSharedCount / others.length;

        const aTitleHead = titleHeadClusterTerms(storyA, featA.language);
        const titleHeadSharedCount = others.filter((b) => {
          const storyB = stories[b];
          const featB = features[b];
          if (!storyB || !featB) {
            return false;
          }
          const bTitleHead = titleHeadClusterTerms(storyB, featB.language);
          return [...aTitleHead].some((t) => bTitleHead.has(t));
        }).length;
        const titleHeadRatio = others.length === 0 ? 1 : titleHeadSharedCount / others.length;
        
        // If story has exclusive bigrams not shared with others, require higher threshold
        // BUT skip this check if component has significant quoted term overlap (stronger signal for single-word proper nouns)
        const aBigrams = [...featA.anchorTerms].filter((t) =>
          isClusterSignalBigram(t, GENERIC_CULT_CLUSTER_TERMS),
        );
        const hasExclusiveBigrams = aBigrams.some((t) =>
          !others.every((b) => {
            const featB = features[b];
            return featB?.anchorTerms.has(t) ?? false;
          }),
        );
        
        // If story has exclusive bigrams, require it to share bigrams with 60%+ of others AND have linkRatio >= 60%
        // Skip this check if component has significant quoted term overlap (e.g., for "Artgemeinschaft")
        // Two-node pairs already passed an explicit adjacency rule — do not prune on bigram overlap alone.
        if (
          component.length > 2 &&
          hasExclusiveBigrams &&
          !hasSignificantQuotedTermOverlap &&
          !hasSignificantTitleHeadOverlap
        ) {
          if (bigramRatio < 0.6 || linkRatio < 0.6) {
            changed = true;
            continue;
          }
        }
        
        // If story shares quoted title terms with 50%+ of others, use lower threshold (40%)
        // This keeps quoted-term-based clusters together even if they don't have high linkage
        if (titleQuotedRatio >= 0.5) {
          if (linkRatio >= 0.4) {
            next.push(a);
          } else {
            changed = true;
          }
          continue;
        }

        // Capitalized / quoted title proper nouns (e.g. Unchosen across FR/NL/EN reviews)
        if (titleHeadRatio >= 0.5) {
          if (linkRatio >= 0.4) {
            next.push(a);
          } else {
            changed = true;
          }
          continue;
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

    const probeLabel = selectGroupLabel(features, component, idf, stories);

    for (const idx of component) assigned.add(idx);
    groups.push({
      label: probeLabel,
      storyIndexes: new Set(component),
    });
  }

  groups.sort((a, b) => b.storyIndexes.size - a.storyIndexes.size);
  return { groups, edges, features };
}

function classifyStories(
  stories: EnrichedStory[],
  wrongClusterUrls?: Set<string>,
  detection?: ClusterDetectionResult,
): { groups: StoryGroup[]; detection: ClusterDetectionResult } {
  const wrongClusterIndexes = new Set<number>();
  if (wrongClusterUrls && wrongClusterUrls.size > 0) {
    stories.forEach((story, idx) => {
      if (wrongClusterUrls.has(createDedupeKey(story.url))) {
        wrongClusterIndexes.add(idx);
      }
    });
  }

  const resolvedDetection = detection ?? detectStoryClusters(stories);
  const detectedGroups = resolvedDetection.groups;
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

  return { groups: result, detection: resolvedDetection };
}

function loadWrongClusterSet(): Set<string> {
  const feedbackPath = new URL('../data/feedback/false-positives.json', import.meta.url);
  try {
    const parsed = JSON.parse(readFileSync(feedbackPath, 'utf-8')) as { entries?: Array<{ url?: string; reason?: string }> };
    const entries = parsed.entries ?? [];
    return new Set(
      entries.filter((e) => e.reason === 'wrong-cluster' && typeof e.url === 'string').map((e) => createDedupeKey(e.url!)),
    );
  } catch {
    return new Set<string>();
  }
}

/** Classify stories and write cult-news-latest.html. */
function writeDigestFromStories(stories: EnrichedStory[], wrongClusterSet?: Set<string>): void {
  const citedStories = stories.map(attachSourceCitation);
  const { groups: autoGroups, detection } = classifyStories(citedStories, wrongClusterSet);
  const layout = loadClusterLayout();
  const groups = applyClusterLayout(autoGroups, citedStories, layout) as StoryGroup[];

  const audit = auditClusterGaps(citedStories, groups, detection);
  const auditPath = new URL('../reports/cluster-audit-latest.json', import.meta.url);
  mkdirSync(new URL('../reports/', import.meta.url), { recursive: true });
  writeFileSync(auditPath, `${JSON.stringify(audit, null, 2)}\n`, 'utf-8');
  console.log(
    `[cluster-audit] ${audit.missedPairs.length} likely missing pairs, ${audit.suspiciousClusters.length} suspicious clusters, ${audit.linkedButUngrouped.length} linked-but-ungrouped → reports/cluster-audit-latest.json`,
  );
  for (const miss of audit.missedPairs.slice(0, 8)) {
    console.log(`[cluster-audit] MISS (${miss.severity}): ${miss.reason}`);
    console.log(`  A: ${miss.storyA.title.slice(0, 85)}`);
    console.log(`  B: ${miss.storyB.title.slice(0, 85)}`);
  }
  for (const suspect of audit.suspiciousClusters.slice(0, 5)) {
    console.log(`[cluster-audit] SUSPECT "${suspect.label}" (${suspect.storyCount}): ${suspect.reason}`);
  }

  for (const g of groups) {
    console.log(`[cluster] "${g.label}" (${g.type}) — ${g.stories.length} stories`);
    for (const s of g.stories) console.log(`  - ${s.title.slice(0, 90)}`);
  }

  const generatedAt = new Date().toISOString();
  const citationReport = buildCitationReport(
    groups.map((group) => ({
      label: group.label,
      type: group.type,
      stories: group.stories.map(storyCitationInput),
    })),
    generatedAt,
  );

  const html = renderDocument(buildPage(groups, citedStories.length, generatedAt, citationReport));
  writeFileSync(OUTPUT_PATH, html, 'utf-8');
  writeFileSync(SOURCES_OUTPUT_PATH, JSON.stringify(citationReport, null, 2), 'utf-8');
  console.log(`[agent] wrote source citations to ${SOURCES_OUTPUT_PATH.pathname}`);
  console.log(`[agent] wrote ${citedStories.length} stories to ${OUTPUT_PATH.pathname}`);
}

type RenderStorySet = {
  stories: EnrichedStory[];
  wrongClusterSet: Set<string>;
  renderMaxAgeHours: number | undefined;
  draftSource: 'archive' | 'last-run-drafts' | 'log';
  draftCount: number;
  excluded: Array<{ url: string; reason: string }>;
};

/** Same story set render:html feeds into classifyStories (before manual layout overrides). */
async function loadEnrichedStoriesForClustering(): Promise<RenderStorySet> {
  const logText = readFileSync(LOG_PATH, 'utf-8');
  const archiveDrafts = loadDraftsFromArchive();
  const structuredDrafts = archiveDrafts ?? loadDraftsFromJson();
  const rawDrafts = structuredDrafts ?? extractDraftsFromLog(logText);
  if (rawDrafts.length === 0) {
    throw new Error(
      `No draft stories found. Run npm run dev first and confirm ${DRAFTS_ARCHIVE_PATH.pathname} or ${DRAFTS_PATH.pathname} exists with count > 0.`,
    );
  }
  const draftSource = archiveDrafts ? 'archive' : structuredDrafts ? 'last-run-drafts' : 'log';
  console.log(`[render] loaded ${rawDrafts.length} drafts from ${draftSource}`);

  const canonicalDrafts = rawDrafts.map((draft) => {
    const canonicalUrl = getCanonicalArticleUrl(canonicalizeStoryUrl(draft.url));
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
          entries.filter((e) => e.reason === 'false-positive' && typeof e.url === 'string').map((e) => createDedupeKey(e.url!)),
        ),
        wrongClusterSet: loadWrongClusterSet(),
      };
    } catch {
      return { feedbackBlocklist: new Set<string>(), wrongClusterSet: loadWrongClusterSet() };
    }
  })();

  const eligibleDrafts =
    feedbackBlocklist.size > 0
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
      .filter((slug): slug is string => Boolean(slug)),
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
    const meta = await fetchStoryMeta(draft.url, { contentMirrorUrl: draft.contentMirrorUrl });
    fetchedStories.push({
      ...draft,
      title: meta.title?.trim() || cleanDisplayTitle(draft.title),
      description: meta.description?.trim() || '',
      image: meta.image,
      publishedAt: meta.publishedAt || draft.publishedAt,
      articleText: meta.articleText?.trim() || '',
      htmlLang: meta.htmlLang,
      contentMirrorUrl: meta.contentMirrorUrl ?? draft.contentMirrorUrl,
      archiveMirrorLinks: meta.archiveMirrorLinks,
      classificationAudit: draft.classificationAudit,
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
  const freshnessExcluded = excluded.filter((entry) => entry.reason.includes('older than'));
  if (freshnessExcluded.length > 0) {
    console.log(
      `[render] freshness filter excluded ${freshnessExcluded.length} stories (window=${RENDER_MAX_AGE_HOURS}h). Set CULT_NEWS_RENDER_MAX_AGE_HOURS higher for multi-day review.`,
    );
  }

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

  return {
    stories: dedupeResult.kept,
    wrongClusterSet,
    renderMaxAgeHours: RENDER_MAX_AGE_HOURS,
    draftSource,
    draftCount: rawDrafts.length,
    excluded,
  };
}

async function main(): Promise<void> {
  const logText = readFileSync(LOG_PATH, 'utf-8');
  const summary = extractRunSummary(logText);
  const { stories, wrongClusterSet } = await loadEnrichedStoriesForClustering();
  writeDigestFromStories(stories, wrongClusterSet);
  if (summary) {
    console.log(`[agent] rendered from ${summary.processed ?? 0} processed candidates`);
  }
}

function isDirectScriptRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

if (isDirectScriptRun()) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[agent] failed to render html digest', { message });
    process.exitCode = 1;
  });
}




