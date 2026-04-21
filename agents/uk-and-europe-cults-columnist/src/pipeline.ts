import { evaluateRelevance } from './relevance.js';
import { evaluateSourceReliability } from './sourceReliability.js';
import { ALL_CULT_TERMS } from './cultTerms.js';
import {
  EXCLUDED_SOURCE_HOSTS,
  FIGURATIVE_CULT_CONTEXT_TERMS,
  FIGURATIVE_CULT_PHRASES,
  GENERIC_CULT_TERMS,
  STRICT_CULT_TERM_EXTENSIONS,
} from './pipelineTerms.js';
import { fetchTextWithCache } from './httpCache.js';
import type { DraftPayload, PipelineResult } from './types.js';

type UrlResolver = (html: string, pageUrl: string) => string | undefined;
type RunPipelineOptions = {
  requiresUrlResolution?: boolean;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const figurativeContextPattern = FIGURATIVE_CULT_CONTEXT_TERMS.map((term) => escapeRegExp(term)).join('|');

const STRICT_CULT_TERMS = Array.from(
  new Set([
    ...ALL_CULT_TERMS,
    ...STRICT_CULT_TERM_EXTENSIONS,
  ]),
);

const SPECIFIC_CULT_TERMS = STRICT_CULT_TERMS.filter((term) => !GENERIC_CULT_TERMS.includes(term));
const genericCultUrlPattern = GENERIC_CULT_TERMS.map((term) => escapeRegExp(term)).join('|');
const GENERIC_CULT_URL_SIGNAL_PATTERN = new RegExp(`/(${genericCultUrlPattern})([/-]|$)`, 'i');
const figurativePhrasePattern = FIGURATIVE_CULT_PHRASES.map((phrase) => escapeRegExp(phrase)).join('|');

const FIGURATIVE_CULT_PATTERNS = [
  new RegExp(`cult[^\\p{L}\\p{N}]{0,24}(${figurativeContextPattern})`, 'iu'),
  new RegExp(`\\b(${figurativePhrasePattern})\\b`, 'iu'),
];

const EXCLUDED_SOURCE_HOST_SET = new Set(EXCLUDED_SOURCE_HOSTS.map((host) => normalizeHost(host)));

function containsPhrase(text: string, phrase: string): boolean {
  const escaped = escapeRegExp(phrase.toLowerCase());
  const pattern = new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}([^\\p{L}\\p{N}]|$)`, 'iu');
  return pattern.test(text);
}

function includesAnyPhrase(text: string, terms: string[]): boolean {
  return terms.some((term) => containsPhrase(text, term));
}

function normalizeMatchingText(text: string): string {
  return text
    .replace(/&quot;|&#34;|&#x22;/gi, '"')
    .replace(/&#39;|&#x27;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'");
}

function hasFigurativeCultUsage(text: string): boolean {
  const normalized = normalizeMatchingText(text);
  return FIGURATIVE_CULT_PATTERNS.some((pattern) => pattern.test(normalized));
}

function isCultTopicPrecise(title: string, text: string, url: string): boolean {
  const titleLower = normalizeMatchingText(title.toLowerCase());
  const bodyLeadLower = normalizeMatchingText(text.slice(0, 2800).toLowerCase());
  const urlLower = url.toLowerCase();

  const titleSpecificSignal = includesAnyPhrase(titleLower, SPECIFIC_CULT_TERMS);
  const bodySpecificSignal = includesAnyPhrase(bodyLeadLower, SPECIFIC_CULT_TERMS);
  const titleGenericSignal = includesAnyPhrase(titleLower, GENERIC_CULT_TERMS);
  const bodyGenericSignal = includesAnyPhrase(bodyLeadLower, GENERIC_CULT_TERMS);
  const urlSignal = GENERIC_CULT_URL_SIGNAL_PATTERN.test(urlLower);

  if (titleSpecificSignal || bodySpecificSignal || urlSignal) {
    return true;
  }

  if (!titleGenericSignal && !bodyGenericSignal) {
    return false;
  }

  return !hasFigurativeCultUsage(`${titleLower} ${bodyLeadLower}`);
}

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, '');
}

function decodeHtmlHref(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function extractCultNews101SourceUrl(html: string, pageUrl: string): string | undefined {
  const preferred: string[] = [];
  const fallback: string[] = [];
  const anchorRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>/gi;
  let match: RegExpExecArray | null = anchorRegex.exec(html);

  while (match) {
    const rawHref = match[1] ? decodeHtmlHref(match[1]) : undefined;
    if (!rawHref) {
      match = anchorRegex.exec(html);
      continue;
    }

    try {
      const absolute = new URL(rawHref, pageUrl).toString();
      const host = normalizeHost(new URL(absolute).hostname);

      if (Array.from(EXCLUDED_SOURCE_HOST_SET).some((excluded) => host === excluded || host.endsWith(`.${excluded}`))) {
        match = anchorRegex.exec(html);
        continue;
      }

      const contextStart = Math.max(0, match.index - 140);
      const contextEnd = Math.min(html.length, match.index + 220);
      const context = html.slice(contextStart, contextEnd).toLowerCase();
      const hasSourceHint = /(source|original|via|read\s+(full|more)|full\s+article|article\s+at|from\s+the)/i.test(
        context,
      );

      if (hasSourceHint) {
        preferred.push(absolute);
      } else {
        fallback.push(absolute);
      }
    } catch {
      // Ignore malformed links.
    }

    match = anchorRegex.exec(html);
  }

  const pick = preferred.length > 0 ? preferred[preferred.length - 1] : fallback[fallback.length - 1];
  return pick;
}

const URL_RESOLVERS_BY_HOST: Record<string, UrlResolver> = {
  'cultnews101.com': extractCultNews101SourceUrl,
};

function getResolverForUrl(url: string): UrlResolver | undefined {
  try {
    const host = normalizeHost(new URL(url).hostname);
    for (const [resolverHost, resolver] of Object.entries(URL_RESOLVERS_BY_HOST)) {
      if (host === resolverHost || host.endsWith(`.${resolverHost}`)) {
        return resolver;
      }
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function removeNonArticleBlocks(html: string): string {
  return html
    .replace(/<aside[\s\S]*?<\/aside>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(
      /<div[^>]+class=["'][^"']*(article-readmore|read-more|readmore|related|recommended|most-read|popular)[^"']*["'][^>]*>[\s\S]*?<\/div>/gi,
      ' ',
    )
    .replace(
      /<section[^>]+class=["'][^"']*(related|recommended|most-read|popular)[^"']*["'][^>]*>[\s\S]*?<\/section>/gi,
      ' ',
    );
}

function stripHtml(html: string): string {
  return removeNonArticleBlocks(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizePublishedAt(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }

  return new Date(parsed).toISOString();
}

function findDatePublishedInJsonValue(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = findDatePublishedInJsonValue(item);
      if (nested) {
        return nested;
      }
    }
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const direct =
    normalizePublishedAt(typeof record.datePublished === 'string' ? record.datePublished : undefined) ??
    normalizePublishedAt(typeof record.dateCreated === 'string' ? record.dateCreated : undefined) ??
    normalizePublishedAt(typeof record.dateModified === 'string' ? record.dateModified : undefined);

  if (direct) {
    return direct;
  }

  for (const nested of Object.values(record)) {
    const nestedDate = findDatePublishedInJsonValue(nested);
    if (nestedDate) {
      return nestedDate;
    }
  }

  return undefined;
}

function detectPublishedAtFromJsonLd(html: string): string | undefined {
  const scriptRegex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null = scriptRegex.exec(html);

  while (match) {
    const rawJson = match[1]?.trim();
    if (rawJson) {
      try {
        const parsed = JSON.parse(rawJson) as unknown;
        const detected = findDatePublishedInJsonValue(parsed);
        if (detected) {
          return detected;
        }
      } catch {
        // Ignore malformed JSON-LD blocks.
      }
    }

    match = scriptRegex.exec(html);
  }

  return undefined;
}

function detectPublishedAt(html: string): string | undefined {
  const patterns = [
    /<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+name=["']article:published_time["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+property=["']og:published_time["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+name=["']pubdate["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+name=["']publishdate["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+itemprop=["']datePublished["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+property=["']article:published["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<time[^>]+datetime=["']([^"']+)["'][^>]*>/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    const normalized = normalizePublishedAt(match?.[1]);
    if (normalized) {
      return normalized;
    }
  }

  return detectPublishedAtFromJsonLd(html);
}

function detectTitle(html: string, fallback: string): string {
  const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
  return titleMatch?.[1]?.trim() || fallback;
}

function createDraft(title: string, text: string, sourceLine: string, region: 'UK' | 'Europe', confidence: number, source: PipelineResult['source']): DraftPayload {
  const trimmed = text.slice(0, 1400);

  return {
    title,
    dek: `Summary of a ${region} cult-related story from a reliable source.`,
    body: `${trimmed}\n\nSource: ${sourceLine}`,
    tags: ['cult', region.toLowerCase(), 'draft-agent'],
    region,
    confidence,
    reviewNotes: 'Auto-generated draft. Editorial review is required before publication.',
    source,
  };
}

export async function runPipeline(
  url: string,
  allowedHosts: Set<string>,
  options: RunPipelineOptions = {},
  archiveFallbackHosts: Set<string> = new Set(),
): Promise<PipelineResult> {
  let effectiveUrl = url;
  let response = await fetchTextWithCache(effectiveUrl);

  if (!response.ok && archiveFallbackHosts.size > 0) {
    try {
      const originalHost = normalizeHost(new URL(effectiveUrl).hostname);
      const shouldTryArchive = Array.from(archiveFallbackHosts).some(
        (h) => originalHost === h || originalHost.endsWith(`.${h}`),
      );
      if (shouldTryArchive) {
        const archiveUrl = `https://archive.ph/newest/${effectiveUrl}`;
        const archiveResponse = await fetchTextWithCache(archiveUrl);
        if (archiveResponse.ok) {
          response = archiveResponse;
        }
      }
    } catch {
      // Archive fallback failed; continue with original error response.
    }
  }

  if (!response.ok) {
    throw new Error(`Failed to fetch source URL: HTTP ${response.status}`);
  }

  let html = response.text;
  effectiveUrl = response.url;

  if (options.requiresUrlResolution) {
    const resolver = getResolverForUrl(effectiveUrl);
    const resolvedUrl = resolver?.(html, effectiveUrl);
    if (resolvedUrl && resolvedUrl !== effectiveUrl) {
      try {
        const resolvedResponse = await fetchTextWithCache(resolvedUrl);

        if (resolvedResponse.ok) {
          effectiveUrl = resolvedUrl;
          response = resolvedResponse;
          html = resolvedResponse.text;
        }
      } catch {
        // Keep original page fallback when source URL cannot be fetched.
      }
    }
  }

  const publishedAt = detectPublishedAt(html);
  const source = evaluateSourceReliability(effectiveUrl, allowedHosts, publishedAt);
  const missingAllowlistOnly =
    source.reliabilityReasons.includes('Source host is not on reliability allowlist') &&
    !source.reliabilityReasons.includes('Non-HTTPS source URL') &&
    !source.reliabilityReasons.includes('No publication date detected');

  if (source.reliabilityScore < 70 && !missingAllowlistOnly) {
    return {
      status: 'rejected',
      source,
      relevance: {
        accepted: false,
        region: 'Unknown',
        confidence: 0,
        reasons: ['Source reliability below threshold'],
      },
      reason: 'Source failed reliability checks',
    };
  }

  const title = detectTitle(html, 'Untitled source story');
  const text = stripHtml(html);
  const relevance = evaluateRelevance(`${title} ${text}`);

  if (!isCultTopicPrecise(title, text, effectiveUrl)) {
    return {
      status: 'rejected',
      source,
      relevance,
      reason: 'Story failed strict cult-topic precision checks',
    };
  }

  if (!relevance.accepted || (relevance.region !== 'UK' && relevance.region !== 'Europe')) {
    return {
      status: 'rejected',
      source,
      relevance,
      reason: 'Story does not meet UK/EU cult-topic relevance threshold',
    };
  }

  const sourceLine = `${source.publisher} (${source.url})`;
  const draft = createDraft(title, text, sourceLine, relevance.region, relevance.confidence, source);

  return {
    status: 'drafted',
    source,
    relevance,
    draft,
  };
}
