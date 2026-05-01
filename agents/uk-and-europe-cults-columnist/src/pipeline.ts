import { readFileSync } from 'node:fs';
import { detect as detectLanguageText } from 'tinyld';
import { evaluateRelevance } from './relevance.js';
import { evaluateSourceReliability } from './sourceReliability.js';
import { ALL_CULT_TERMS, getCultTermsForLanguage } from './cultTerms.js';
import { fetchTextWithBrowserRender } from './browserFetch.js';
import {
  BROWSER_RENDER_FALLBACK_ENABLED,
  BROWSER_RENDER_FALLBACK_STATUS_CODES,
} from './http-cache/config.js';
import {
  ALL_GENERIC_CULT_TERMS,
  EXCLUDED_SOURCE_HOSTS,
  FIGURATIVE_CULT_COMMERCIAL_CONTEXT_TERMS_BY_LANGUAGE,
  FIGURATIVE_CULT_CONTEXT_TERMS_BY_LANGUAGE,
  FIGURATIVE_CULT_PHRASES_BY_LANGUAGE,
  FIGURATIVE_CULT_REGEX_PATTERNS_BY_LANGUAGE,
  GENERIC_CULT_TERMS_BY_LANGUAGE,
  STRICT_CULT_TERM_EXTENSIONS_BY_LANGUAGE,
} from './pipelineTerms.js';
import { fetchTextWithCache } from './httpCache.js';
import { REGION_TERMS, REGIONAL_HOST_SUFFIXES } from './discoveryConfig.js';
import type { DraftPayload, PipelineResult } from './types.js';

type UrlResolver = (html: string, pageUrl: string) => string | undefined;
type ResolverKey = 'republishedSourceLink';
type RunPipelineOptions = {
  requiresUrlResolution?: boolean;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Shared (English) figurative patterns — applied to all articles regardless of language.
const enContextTerms = FIGURATIVE_CULT_CONTEXT_TERMS_BY_LANGUAGE.en ?? [];
const enPhrases = FIGURATIVE_CULT_PHRASES_BY_LANGUAGE.en ?? [];
const figurativeContextPattern = enContextTerms.map((term) => escapeRegExp(term)).join('|');
const figurativePhrasePattern = enPhrases.map((phrase) => escapeRegExp(phrase)).join('|');

const FIGURATIVE_CULT_PATTERNS = [
  new RegExp(`cult[^\\p{L}\\p{N}]{0,24}(${figurativeContextPattern})`, 'iu'),
  new RegExp(`\\b(${figurativePhrasePattern})\\b`, 'iu'),
];

// Per-language cult prefix word used when building figurative context-term patterns.
const FIGURATIVE_CONTEXT_PREFIX_BY_LANGUAGE: Record<string, string> = {
  de: 'kult',
  fr: 'culte',
};

// Per-language figurative patterns: built from language-specific context terms + phrases,
// then merged with the explicit regex patterns loaded from JSON.
const FIGURATIVE_CULT_PATTERNS_BY_LANGUAGE: Record<string, RegExp[]> = (() => {
  const result: Record<string, RegExp[]> = {};
  const allLanguages = new Set([
    ...Object.keys(FIGURATIVE_CULT_CONTEXT_TERMS_BY_LANGUAGE),
    ...Object.keys(FIGURATIVE_CULT_PHRASES_BY_LANGUAGE),
    ...Object.keys(FIGURATIVE_CULT_REGEX_PATTERNS_BY_LANGUAGE),
  ]);
  for (const lang of allLanguages) {
    if (lang === 'en') continue;
    const contextTerms = FIGURATIVE_CULT_CONTEXT_TERMS_BY_LANGUAGE[lang] ?? [];
    const phrases = FIGURATIVE_CULT_PHRASES_BY_LANGUAGE[lang] ?? [];
    const patterns: RegExp[] = [...(FIGURATIVE_CULT_REGEX_PATTERNS_BY_LANGUAGE[lang] ?? [])];
    if (contextTerms.length > 0) {
      const prefix = escapeRegExp(FIGURATIVE_CONTEXT_PREFIX_BY_LANGUAGE[lang] ?? 'cult');
      const ctx = contextTerms.map(escapeRegExp).join('|');
      patterns.push(new RegExp(`${prefix}[^\\p{L}\\p{N}]{0,24}(${ctx})`, 'iu'));
    }
    if (phrases.length > 0) {
      const phr = phrases.map(escapeRegExp).join('|');
      patterns.push(new RegExp(`\\b(${phr})\\b`, 'iu'));
    }
    result[lang] = patterns;
  }
  return result;
})();

const STRICT_CULT_TERMS = Array.from(
  new Set([
    ...ALL_CULT_TERMS,
    ...(STRICT_CULT_TERM_EXTENSIONS_BY_LANGUAGE.en ?? []),
  ]),
);

const SPECIFIC_CULT_TERMS = STRICT_CULT_TERMS.filter((term) => !ALL_GENERIC_CULT_TERMS.includes(term));
const AMBIGUOUS_SPECIFIC_CULT_TERMS = new Set(['lahko']);
const genericCultUrlPattern = ALL_GENERIC_CULT_TERMS.map((term) => escapeRegExp(term)).join('|');
const GENERIC_CULT_URL_SIGNAL_PATTERN = new RegExp(`/(${genericCultUrlPattern})([/-]|$)`, 'i');

function getGenericCultTermsForLanguage(language?: string): string[] {
  const en = GENERIC_CULT_TERMS_BY_LANGUAGE.en ?? [];
  if (!language || language === 'en') return en;
  const langTerms = GENERIC_CULT_TERMS_BY_LANGUAGE[language] ?? [];
  return Array.from(new Set([...langTerms, ...en]));
}

const EXCLUDED_SOURCE_HOST_SET = new Set(EXCLUDED_SOURCE_HOSTS.map((host) => normalizeHost(host)));

function containsPhrase(text: string, phrase: string): boolean {
  const escaped = escapeRegExp(phrase.toLowerCase());
  const pattern = new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}([^\\p{L}\\p{N}]|$)`, 'iu');
  return pattern.test(text);
}

function includesAnyPhrase(text: string, terms: string[]): boolean {
  return terms.some((term) => containsPhrase(text, term));
}

function findMatchingPhrase(text: string, terms: string[]): string | undefined {
  return terms.find((term) => containsPhrase(text, term));
}

function countMatchingPhrases(text: string, terms: string[]): number {
  const uniqueTerms = new Set(terms);
  let matches = 0;
  for (const term of uniqueTerms) {
    if (containsPhrase(text, term)) {
      matches += 1;
    }
  }
  return matches;
}

function normalizeMatchingText(text: string): string {
  return text
    .replace(/&quot;|&#34;|&#x22;/gi, '"')
    .replace(/&#39;|&#x27;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'");
}

function detectLanguageFromHtml(html: string): string | undefined {
  const match = html.match(/<html[^>]+lang=["']([^"']+)["']/i);
  if (match?.[1]) return match[1].toLowerCase().split('-')[0];

  // Fallback: use tinyld trigram detection on a plain-text sample of the article body.
  const sample = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2000);
  const detected = detectLanguageText(sample);
  return detected || undefined;
}

function hasFigurativeCultUsage(text: string, language?: string): boolean {
  const normalized = normalizeMatchingText(text);
  if (FIGURATIVE_CULT_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return true;
  }
  if (language) {
    const langPatterns = FIGURATIVE_CULT_PATTERNS_BY_LANGUAGE[language];
    if (langPatterns?.some((pattern) => pattern.test(normalized))) {
      return true;
    }
  }
  return false;
}

function hasCommercialFigurativeCultUsage(title: string, text: string, language?: string): boolean {
  const localTerms = language ? (FIGURATIVE_CULT_COMMERCIAL_CONTEXT_TERMS_BY_LANGUAGE[language] ?? []) : [];
  const englishTerms = FIGURATIVE_CULT_COMMERCIAL_CONTEXT_TERMS_BY_LANGUAGE.en ?? [];
  const terms = Array.from(new Set([...englishTerms, ...localTerms]));
  if (terms.length === 0) {
    return false;
  }

  const normalizedTitle = normalizeMatchingText(title);
  const normalizedLead = normalizeMatchingText(text.slice(0, 2800));
  const titleMatches = countMatchingPhrases(normalizedTitle, terms);
  if (titleMatches >= 1) {
    return true;
  }

  const leadMatches = countMatchingPhrases(`${normalizedTitle} ${normalizedLead}`, terms);
  return leadMatches >= 2;
}

function isCultTopicPrecise(title: string, text: string, url: string, language?: string): boolean {
  const titleLower = normalizeMatchingText(title.toLowerCase());
  const bodyLeadLower = normalizeMatchingText(text.slice(0, 2800).toLowerCase());
  const urlLower = url.toLowerCase();

  const languageCultTerms = getCultTermsForLanguage(language);
  const languageSpecificTerms = languageCultTerms.filter((term) => !ALL_GENERIC_CULT_TERMS.includes(term));
  const specificTerms = languageSpecificTerms.length > 0 ? languageSpecificTerms : SPECIFIC_CULT_TERMS;

  const genericTermsForLanguage = getGenericCultTermsForLanguage(language);
  const titleSpecificMatch = findMatchingPhrase(titleLower, specificTerms);
  const bodySpecificMatch = findMatchingPhrase(bodyLeadLower, specificTerms);
  const titleSpecificSignal = Boolean(titleSpecificMatch);
  const bodySpecificSignal = Boolean(bodySpecificMatch);
  const titleGenericSignal = includesAnyPhrase(titleLower, genericTermsForLanguage);
  const bodyGenericSignal = includesAnyPhrase(bodyLeadLower, genericTermsForLanguage);
  const urlSignal = GENERIC_CULT_URL_SIGNAL_PATTERN.test(urlLower);
  const hasNonAmbiguousSpecific = [titleSpecificMatch, bodySpecificMatch].some(
    (match) => Boolean(match) && !AMBIGUOUS_SPECIFIC_CULT_TERMS.has(match ?? ''),
  );
  const hasOnlyAmbiguousSpecific = (titleSpecificSignal || bodySpecificSignal) && !hasNonAmbiguousSpecific;

  if (hasOnlyAmbiguousSpecific && !titleGenericSignal && !bodyGenericSignal && !urlSignal) {
    return false;
  }

  if (hasNonAmbiguousSpecific || urlSignal) {
    return true;
  }

  if (!titleGenericSignal && !bodyGenericSignal) {
    return false;
  }

  if (!hasNonAmbiguousSpecific && hasCommercialFigurativeCultUsage(titleLower, bodyLeadLower, language)) {
    return false;
  }

  return !hasFigurativeCultUsage(`${titleLower} ${bodyLeadLower}`, language);
}

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, '');
}

function loadResolverHostConfigs(): Map<string, ResolverKey> {
  try {
    const feedsUrl = new URL('../feeds.json', import.meta.url);
    const raw = readFileSync(feedsUrl, 'utf-8');
    const parsed = JSON.parse(raw) as { feeds?: Array<{ url?: unknown; enabled?: unknown; urlResolver?: unknown }> };
    const feeds = parsed.feeds ?? [];
    const configs = new Map<string, ResolverKey>();

    for (const feed of feeds) {
      if (feed.enabled === false) {
        continue;
      }

      if (typeof feed.url !== 'string' || typeof feed.urlResolver !== 'string') {
        continue;
      }

      if (feed.urlResolver !== 'republishedSourceLink') {
        continue;
      }

      try {
        const host = normalizeHost(new URL(feed.url).hostname);
        configs.set(host, feed.urlResolver);
      } catch {
        // Ignore malformed feed URLs.
      }
    }

    return configs;
  } catch {
    return new Map();
  }
}

function isLikelyConfiguredRegionalHost(host: string): boolean {
  const normalized = normalizeHost(host);
  return REGIONAL_HOST_SUFFIXES.some((suffix) => normalized.endsWith(suffix.toLowerCase()));
}

function hasConfiguredRegionalSignalInText(text: string): boolean {
  const normalized = normalizeMatchingText(text.toLowerCase());
  return includesAnyPhrase(normalized, REGION_TERMS);
}

function decodeHtmlHref(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function extractRepublishedSourceUrl(html: string, pageUrl: string): string | undefined {
  const preferred: string[] = [];
  const fallback: string[] = [];
  let pageHost: string | undefined;
  try {
    pageHost = normalizeHost(new URL(pageUrl).hostname);
  } catch {
    pageHost = undefined;
  }
  const pagePathTokens = (() => {
    try {
      return new URL(pageUrl)
        .pathname.toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((token) => token.length >= 5);
    } catch {
      return [] as string[];
    }
  })();

  function scoreSourceCandidate(candidateUrl: string): number {
    let score = 0;

    try {
      const parsed = new URL(candidateUrl);
      if (parsed.protocol === 'https:') {
        score += 5;
      }

      if (parsed.pathname && parsed.pathname !== '/') {
        score += 5;
      }

      const candidatePath = parsed.pathname.toLowerCase();
      const overlap = pagePathTokens.reduce((acc, token) => (candidatePath.includes(token) ? acc + 1 : acc), 0);
      score += overlap * 8;
    } catch {
      // Ignore malformed URLs during scoring.
    }

    return score;
  }

  function pickBest(candidates: string[]): string | undefined {
    let bestUrl: string | undefined;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (const candidate of candidates) {
      const score = scoreSourceCandidate(candidate);
      if (score >= bestScore) {
        bestScore = score;
        bestUrl = candidate;
      }
    }

    return bestUrl;
  }
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

      if (pageHost && (host === pageHost || host.endsWith(`.${pageHost}`))) {
        match = anchorRegex.exec(html);
        continue;
      }

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

  const plainUrlRegex = /https?:\/\/[^\s"'<>]+/gi;
  let plainMatch: RegExpExecArray | null = plainUrlRegex.exec(html);
  while (plainMatch) {
    const rawUrl = decodeHtmlHref(plainMatch[0] ?? '').replace(/[),.;:]+$/g, '');

    try {
      const absolute = new URL(rawUrl, pageUrl).toString();
      const host = normalizeHost(new URL(absolute).hostname);

      if (pageHost && (host === pageHost || host.endsWith(`.${pageHost}`))) {
        plainMatch = plainUrlRegex.exec(html);
        continue;
      }

      if (Array.from(EXCLUDED_SOURCE_HOST_SET).some((excluded) => host === excluded || host.endsWith(`.${excluded}`))) {
        plainMatch = plainUrlRegex.exec(html);
        continue;
      }

      const contextStart = Math.max(0, plainMatch.index - 140);
      const contextEnd = Math.min(html.length, plainMatch.index + 220);
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
      // Ignore malformed plain URLs.
    }

    plainMatch = plainUrlRegex.exec(html);
  }

  const pick = preferred.length > 0 ? pickBest(preferred) : pickBest(fallback);
  return pick;
}

const RESOLVER_BY_KEY: Record<ResolverKey, UrlResolver> = {
  republishedSourceLink: extractRepublishedSourceUrl,
};

const URL_RESOLVER_HOST_CONFIGS = loadResolverHostConfigs();

function getResolverForUrl(url: string): UrlResolver | undefined {
  try {
    const host = normalizeHost(new URL(url).hostname);
    for (const [resolverHost, resolverKey] of URL_RESOLVER_HOST_CONFIGS.entries()) {
      if (host === resolverHost || host.endsWith(`.${resolverHost}`)) {
        return RESOLVER_BY_KEY[resolverKey];
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
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
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

  if (!response.ok) {
    try {
      const originalHost = normalizeHost(new URL(effectiveUrl).hostname);
      const shouldTryArchive = Array.from(archiveFallbackHosts).some(
        (h) => originalHost === h || originalHost.endsWith(`.${h}`),
      );

      // Bot-block statuses commonly indicate access controls. Attempting
      // an archival mirror gives us a second retrieval path without changing
      // source reliability policy.
      if (shouldTryArchive || BROWSER_RENDER_FALLBACK_STATUS_CODES.has(response.status)) {
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

  if (
    !response.ok &&
    BROWSER_RENDER_FALLBACK_ENABLED &&
    BROWSER_RENDER_FALLBACK_STATUS_CODES.has(response.status)
  ) {
    try {
      const browserResponse = await fetchTextWithBrowserRender(effectiveUrl);
      if (browserResponse.ok) {
        response = browserResponse;
      }
    } catch {
      // Browser fallback failed; keep current response.
    }
  }

  if (!response.ok) {
    if (BROWSER_RENDER_FALLBACK_STATUS_CODES.has(response.status)) {
      throw new Error(`Source fetch blocked by remote anti-bot controls: HTTP ${response.status}`);
    }

    throw new Error(`Failed to fetch source URL: HTTP ${response.status}`);
  }

  let html = response.text;
  effectiveUrl = response.url;

  if (options.requiresUrlResolution || Boolean(getResolverForUrl(effectiveUrl))) {
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

  const language = detectLanguageFromHtml(html);
  const title = detectTitle(html, 'Untitled source story');
  const text = stripHtml(html);
  const relevance = evaluateRelevance(`${title} ${text}`);
  const leadRegionSignal = hasConfiguredRegionalSignalInText(`${title} ${text.slice(0, 2800)}`);

  if (!isCultTopicPrecise(title, text, effectiveUrl, language)) {
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

  if (!isLikelyConfiguredRegionalHost(source.host) && !leadRegionSignal) {
    return {
      status: 'rejected',
      source,
      relevance,
      reason: 'Story does not have a configured regional source or configured regional geographic signal',
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
