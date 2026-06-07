import { readFileSync } from 'node:fs';
import { detect as detectLanguageText } from 'tinyld';
import { evaluateRelevance } from './relevance.ts';
import { evaluateSourceReliability } from './sourceReliability.ts';
import { ALL_CULT_TERMS, getCultTermsForLanguage } from './cultTerms.ts';
import { fetchTextWithBrowserRender } from './browserFetch.ts';
import {
  BROWSER_RENDER_FALLBACK_ENABLED,
  BROWSER_RENDER_FALLBACK_STATUS_CODES,
} from './http-cache/config.ts';
import {
  ALL_GENERIC_CULT_TERMS,
  AMBIGUOUS_CULT_TERMS_BY_LANGUAGE,
  CULT_TERMS_BY_LANGUAGE,
  EXCLUDED_SOURCE_HOSTS,
  FIGURATIVE_CULT_COMMERCIAL_CONTEXT_TERMS_BY_LANGUAGE,
  FIGURATIVE_CULT_CONTEXT_TERMS_BY_LANGUAGE,
  FIGURATIVE_CULT_PHRASES_BY_LANGUAGE,
  FIGURATIVE_CULT_REGEX_PATTERNS_BY_LANGUAGE,
  GENERIC_CULT_TERMS_BY_LANGUAGE,
  NEWS_COVERAGE_PREPOSITIONS_BY_LANGUAGE,
  getCoerciveHarmTermsForLanguage,
  getReligiousGroupTermsForLanguage,
  getStrictCultTermExtensionsForLanguage,
} from './pipelineTerms.ts';
import { extractPageMetadataFromHtml, htmlToPlainArticleText } from './articleContent.ts';
import { getCanonicalArticleUrl, isArchiveMirrorHost, looksLikeBlockedFetchPage, looksLikePartialPaywall } from './archiveMirrors.ts';
import { fetchTextResilient } from './resilientFetch.ts';
import { REGION_TERMS, REGIONAL_HOST_SUFFIXES } from './discoveryConfig.ts';
import { clusterStopwordsForLanguage } from './clusterStopwords.ts';
import { extractQuotedSpans } from './quotePatterns.ts';
import type { CultClassificationAudit, DraftPayload, PipelineResult } from './types.ts';

// Load subject aliases for proper noun matching
const SUBJECT_ALIASES_PATH = new URL('../data/subject-aliases.json', import.meta.url);
const SUBJECT_ALIASES: Array<{ canonical: string; aliases: Array<{ text: string; lang?: string }> }> = JSON.parse(
  readFileSync(SUBJECT_ALIASES_PATH, 'utf-8'),
);

// Build a set of all alias terms for matching
const ALIAS_TERMS = new Set<string>();
for (const entry of SUBJECT_ALIASES) {
  ALIAS_TERMS.add(entry.canonical);
  for (const alias of entry.aliases) {
    ALIAS_TERMS.add(alias.text);
  }
}

/**
 * Simple tokenization for proper noun extraction
 */
function tokenizeForProperNouns(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3);
}

/**
 * Extract proper nouns from text using capitalization and quoted phrases
 */
function extractProperNouns(text: string, language: string = 'en'): Set<string> {
  const result = new Set<string>();
  const tokens = tokenizeForProperNouns(text);
  
  // Extract capitalized words (not at sentence start)
  for (const token of tokens) {
    const capitalized = token[0]!.toUpperCase() + token.slice(1);
    const pattern = new RegExp(`(?<=[^.!?
])\\s+${capitalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[^a-z]|$)`, 'u');
    if (pattern.test(text)) {
      result.add(token);
    }
  }
  
  // Extract sequences of capitalized words with stop words in between (e.g., "Ahmadi Religion of Peace and Light")
  // This captures organization names, book titles, etc. that have internal stop words
  const capitalizedWordPattern = /\b[A-Z][a-z]+\b/g;
  const capitalizedWords = [];
  let match;
  while ((match = capitalizedWordPattern.exec(text)) !== null) {
    capitalizedWords.push({ word: match[0], index: match.index });
  }
  
  // Build sequences of capitalized words (allowing stop words between them)
  // Use locale-specific stopwords from discovery lang files
  const stopwords = clusterStopwordsForLanguage(language);
  
  for (let i = 0; i < capitalizedWords.length; i++) {
    const currentWord = capitalizedWords[i];
    if (!currentWord) continue;
    
    let phrase = currentWord.word;
    let phraseEndIndex = currentWord.index + currentWord.word.length;
    
    for (let j = i + 1; j < capitalizedWords.length; j++) {
      const nextWord = capitalizedWords[j];
      if (!nextWord) break;
      
      const textBetween = text.slice(phraseEndIndex, nextWord.index).trim().toLowerCase();
      
      // Allow only stop words between capitalized words
      const wordsBetween = textBetween.split(/\s+/).filter(w => w.length > 0);
      const allStopwords = wordsBetween.every(w => stopwords.has(w));
      
      if (allStopwords && wordsBetween.length <= 2) {
        // Build the full phrase including stop words
        phrase += ' ' + textBetween + ' ' + nextWord.word;
        phraseEndIndex = nextWord.index + nextWord.word.length;
        
        // Add the phrase if it has at least 2 capitalized words
        const lowerPhrase = phrase.toLowerCase();
        if (lowerPhrase.length >= 8) {
          result.add(lowerPhrase);
        }
      } else {
        break; // Stop if non-stopword encountered
      }
    }
  }
  
  // Extract quoted terms (often proper nouns) - preserve full phrase including stop words
  for (const quotedText of extractQuotedSpans(text)) {
    const lowerQuoted = quotedText.toLowerCase().trim();
    if (lowerQuoted.length >= 3) {
      result.add(lowerQuoted);
    }
    for (const word of quotedText.split(/\s+/)) {
      const lowerWord = word.toLowerCase();
      if (lowerWord.length >= 3) {
        result.add(lowerWord);
      }
    }
  }
  
  return result;
}

/**
 * Match proper nouns against subject aliases
 */
function matchProperNounsToAliases(properNouns: Set<string>): string[] {
  const matched: string[] = [];
  for (const noun of properNouns) {
    for (const entry of SUBJECT_ALIASES) {
      if (noun === entry.canonical) {
        matched.push(entry.canonical);
        break;
      }
      for (const alias of entry.aliases) {
        if (noun === alias.text) {
          matched.push(entry.canonical);
          break;
        }
      }
    }
  }
  return matched;
}

type UrlResolver = (html: string, pageUrl: string) => string | undefined;
type ResolverKey = 'republishedSourceLink';
type RunPipelineOptions = {
  requiresUrlResolution?: boolean;
};

function escapeRegExp(value: string): string {
  // First escape hyphens, then other special regex characters
  return value.replace(/[-]/g, '\\$&').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Shared (English) figurative patterns — applied to all articles regardless of language.
const enContextTerms = FIGURATIVE_CULT_CONTEXT_TERMS_BY_LANGUAGE.en ?? [];
const enPhrases = FIGURATIVE_CULT_PHRASES_BY_LANGUAGE.en ?? [];
const figurativeContextPattern = enContextTerms.map((term) => escapeRegExp(term)).join('|');
const figurativePhrasePattern = enPhrases.map((phrase) => escapeRegExp(phrase)).join('|');

const FIGURATIVE_CULT_PATTERNS = [
  // Match cult followed by context term within 24 chars (allows words between)
  new RegExp(`cult.{0,24}?(${figurativeContextPattern})`, 'iu'),
  new RegExp(`\\b(${figurativePhrasePattern})\\b`, 'iu'),
  // Bidirectional: context term before cult within 24 chars
  new RegExp(`(${figurativeContextPattern}).{0,24}?cult`, 'iu'),
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
      // Match cult followed by context term within 24 chars (allows words between)
      patterns.push(new RegExp(`${prefix}.{0,24}?(${ctx})`, 'iu'));
      // Bidirectional: context term before cult within 24 chars
      patterns.push(new RegExp(`(${ctx}).{0,24}?${prefix}`, 'iu'));
    }
    if (phrases.length > 0) {
      const phr = phrases.map(escapeRegExp).join('|');
      patterns.push(new RegExp(`\\b(${phr})\\b`, 'iu'));
    }
    result[lang] = patterns;
  }
  return result;
})();

/** Union of cult-terms.json only (no locale-specific strict extensions) — fallback when a language yields no specific terms. */
const SPECIFIC_CULT_TERMS_FALLBACK = ALL_CULT_TERMS.filter((term) => !ALL_GENERIC_CULT_TERMS.includes(term));
function getAmbiguousCultTermsForLanguage(language: string | undefined): Set<string> {
  const code = language ? (language.toLowerCase().split('-')[0] ?? 'en') : 'en';
  const localTerms = AMBIGUOUS_CULT_TERMS_BY_LANGUAGE[code] ?? [];
  const englishTerms = AMBIGUOUS_CULT_TERMS_BY_LANGUAGE.en ?? [];
  return new Set([...localTerms, ...englishTerms]);
}

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

export function normalizeMatchingText(text: string): string {
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

function hasNewsCoverageCultPattern(normalized: string, language?: string): boolean {
  const langCode = language?.toLowerCase();
  const prepositions = langCode ? (NEWS_COVERAGE_PREPOSITIONS_BY_LANGUAGE[langCode] ?? []) : [];
  const englishPrepositions = NEWS_COVERAGE_PREPOSITIONS_BY_LANGUAGE.en ?? [];
  const allPrepositions = Array.from(new Set([...englishPrepositions, ...prepositions]));

  const cultTerms = langCode ? (CULT_TERMS_BY_LANGUAGE[langCode] ?? []) : [];
  const englishCultTerms = CULT_TERMS_BY_LANGUAGE.en ?? [];
  const allCultTerms = Array.from(new Set([...englishCultTerms, ...cultTerms]));

  if (allPrepositions.length === 0 || allCultTerms.length === 0) {
    return false;
  }

  const prepositionPattern = new RegExp(
    `\\b(${allPrepositions.join('|')})[^.]{0,30}(${allCultTerms.join('|')})`,
    'iu',
  );
  return prepositionPattern.test(normalized);
}

function countCultTermMentions(normalized: string, language?: string): number {
  const terms = getCultTermsForLanguage(language);
  let count = 0;
  for (const term of terms) {
    const t = term.toLowerCase();
    if (t.length <= 5) {
      const regex = new RegExp(`\\b${escapeRegExp(t)}\\b`, 'giu');
      count += normalized.match(regex)?.length ?? 0;
      continue;
    }
    let searchFrom = 0;
    while (searchFrom < normalized.length) {
      const idx = normalized.indexOf(t, searchFrom);
      if (idx === -1) {
        break;
      }
      count += 1;
      searchFrom = idx + t.length;
    }
  }
  return count;
}

/**
 * Genre/marketing "cult" language present, but the piece substantively covers cult dynamics
 * (real groups or fictional depictions — e.g. Unchosen Netflix reviews, cult documentaries).
 */
export function hasSubstantiveCultSubjectMatter(text: string, language?: string): boolean {
  const normalized = normalizeMatchingText(text);
  const mentionCount = countCultTermMentions(normalized, language);

  if (mentionCount >= 4) {
    return true;
  }

  const coerciveTerms = getCoerciveHarmTermsForLanguage(language);
  const cultTerms = getCultTermsForLanguage(language);
  for (const cultTerm of cultTerms) {
    const ct = cultTerm.toLowerCase();
    let searchFrom = 0;
    while (searchFrom < normalized.length) {
      const idx = normalized.indexOf(ct, searchFrom);
      if (idx === -1) {
        break;
      }
      const windowStart = Math.max(0, idx - 300);
      const windowEnd = Math.min(normalized.length, idx + ct.length + 300);
      const window = normalized.slice(windowStart, windowEnd);
      if (coerciveTerms.some((term) => window.includes(term.toLowerCase()))) {
        return true;
      }
      searchFrom = idx + 1;
    }
  }

  if (mentionCount >= 2 && hasNewsCoverageCultPattern(normalized, language)) {
    return true;
  }

  return false;
}

export function hasFigurativeCultUsage(text: string, language?: string): boolean {
  const normalized = normalizeMatchingText(text);

  // Explicit figurative phrases beat generic preposition+cult heuristics
  // (e.g. Portuguese publisher name "cooperativa editorial A Seita" contains "da … seita").
  if (FIGURATIVE_CULT_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return true;
  }
  if (language) {
    const langPatterns = FIGURATIVE_CULT_PATTERNS_BY_LANGUAGE[language];
    if (langPatterns?.some((pattern) => pattern.test(normalized))) {
      return true;
    }
  }

  // News coverage patterns: preposition + cult term → not figurative
  if (hasNewsCoverageCultPattern(normalized, language)) {
    return false;
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

type CultClassificationResult = {
  isCultRelated: boolean;
  audit: CultClassificationAudit;
};

export function isCultTopicPreciseWithAudit(
  title: string,
  text: string,
  url: string,
  language?: string,
): CultClassificationResult {
  const titleLower = normalizeMatchingText(title.toLowerCase());
  const bodyLeadLower = normalizeMatchingText(text.slice(0, 2800).toLowerCase());
  const urlLower = url.toLowerCase();

  // Extract proper nouns from title and body
  const fullText = `${title} ${text.slice(0, 2800)}`;
  const properNouns = extractProperNouns(fullText, language);
  const matchedAliases = matchProperNounsToAliases(properNouns);

  const strictExtensions = getStrictCultTermExtensionsForLanguage(language);
  const languageCultTerms = Array.from(new Set([...getCultTermsForLanguage(language), ...strictExtensions]));
  const languageSpecificTerms = languageCultTerms.filter((term) => !ALL_GENERIC_CULT_TERMS.includes(term));
  const specificTerms = languageSpecificTerms.length > 0 ? languageSpecificTerms : SPECIFIC_CULT_TERMS_FALLBACK;

  const genericTermsForLanguage = getGenericCultTermsForLanguage(language);
  const titleSpecificMatch = findMatchingPhrase(titleLower, specificTerms);
  const bodySpecificMatch = findMatchingPhrase(bodyLeadLower, specificTerms);
  const titleSpecificSignal = Boolean(titleSpecificMatch);
  const bodySpecificSignal = Boolean(bodySpecificMatch);
  const titleGenericSignal = includesAnyPhrase(titleLower, genericTermsForLanguage);
  const bodyGenericSignal = includesAnyPhrase(bodyLeadLower, genericTermsForLanguage);
  const urlSignal = GENERIC_CULT_URL_SIGNAL_PATTERN.test(urlLower);
  const ambiguousCultTerms = getAmbiguousCultTermsForLanguage(language);
  const hasNonAmbiguousSpecific = [titleSpecificMatch, bodySpecificMatch].some(
    (match) => Boolean(match) && !ambiguousCultTerms.has(match ?? ''),
  );
  const hasOnlyAmbiguousSpecific = (titleSpecificSignal || bodySpecificSignal) && !hasNonAmbiguousSpecific;

  // Build audit trail
  const matchedTerms: string[] = [];
  const matchLocations: string[] = [];
  const matchContexts: string[] = [];

  if (titleSpecificMatch) {
    matchedTerms.push(titleSpecificMatch);
    matchLocations.push('title');
    const idx = titleLower.indexOf(titleSpecificMatch.toLowerCase());
    matchContexts.push(titleLower.substring(Math.max(0, idx - 30), idx + titleSpecificMatch.length + 30));
  }
  if (bodySpecificMatch) {
    matchedTerms.push(bodySpecificMatch);
    matchLocations.push('body');
    const idx = bodyLeadLower.indexOf(bodySpecificMatch.toLowerCase());
    matchContexts.push(bodyLeadLower.substring(Math.max(0, idx - 30), idx + bodySpecificMatch.length + 30));
  }

  const hasLegalCultEquivalentSignal = (() => {
    const combined = `${titleLower} ${bodyLeadLower}`;
    const religiousTerms = getReligiousGroupTermsForLanguage(language);
    const coerciveTerms = getCoerciveHarmTermsForLanguage(language);
    const religiousMatch = religiousTerms.find((t) => containsPhrase(combined, t));
    const coerciveMatch = coerciveTerms.find((t) => containsPhrase(combined, t));
    if (!religiousMatch || !coerciveMatch) return false;
    // Require the two signals to appear within 600 characters of each other
    // to avoid DV/safeguarding stories that incidentally mention both terms.
    const PROXIMITY = 600;
    const rIdx = combined.indexOf(religiousMatch);
    const cIdx = combined.indexOf(coerciveMatch);
    return Math.abs(rIdx - cIdx) <= PROXIMITY;
  })();

  // Track filter results
  const filtersChecked: string[] = [];
  const filterResults: Record<string, { passed: boolean; reason?: string }> = {};

  filtersChecked.push('legalCultEquivalent');
  filterResults['legalCultEquivalent'] = {
    passed: hasLegalCultEquivalentSignal,
    reason: hasLegalCultEquivalentSignal ? 'Religious + coercive terms within 600 chars' : 'No legal cult equivalent detected',
  };

  if (hasLegalCultEquivalentSignal) {
    return {
      isCultRelated: true,
      audit: {
        matchedTerms,
        matchLocations,
        matchContexts,
        classificationSource: 'isCultTopicPrecise-legalEquivalent',
        filtersChecked,
        filterResults,
        properNouns: [...properNouns],
        matchedAliases,
        classifiedAt: new Date().toISOString(),
      },
    };
  }

  filtersChecked.push('nonAmbiguousSpecific');
  filterResults['nonAmbiguousSpecific'] = {
    passed: hasNonAmbiguousSpecific,
    reason: hasNonAmbiguousSpecific ? `Matched: ${matchedTerms.join(', ')}` : 'No non-ambiguous specific terms',
  };

  filtersChecked.push('urlSignal');
  filterResults['urlSignal'] = {
    passed: urlSignal,
    reason: urlSignal ? 'URL contains cult signal pattern' : 'No URL cult signal',
  };

  if (hasOnlyAmbiguousSpecific && !titleGenericSignal && !bodyGenericSignal && !urlSignal) {
    return {
      isCultRelated: false,
      audit: {
        matchedTerms,
        matchLocations,
        matchContexts,
        classificationSource: 'isCultTopicPrecise-rejected-ambiguousOnly',
        filtersChecked,
        filterResults,
        properNouns: [...properNouns],
        matchedAliases,
        classifiedAt: new Date().toISOString(),
      },
    };
  }

  // If coercive control is the only specific term and no other cult signals exist,
  // reject as likely domestic abuse/legislation context rather than cult context
  const isCoerciveControlOnly = (() => {
    if (matchedTerms.length !== 1) return false;
    const term = matchedTerms[0]?.toLowerCase();
    if (term !== 'coercive control') return false;
    // Check for other cult signals that would indicate actual cult context
    const combined = `${titleLower} ${bodyLeadLower}`;
    const religiousTerms = getReligiousGroupTermsForLanguage(language);
    const hasReligiousSignal = religiousTerms.some((t) => containsPhrase(combined, t));
    const hasGenericSignal = titleGenericSignal || bodyGenericSignal;
    return !hasReligiousSignal && !hasGenericSignal;
  })();

  if (isCoerciveControlOnly) {
    return {
      isCultRelated: false,
      audit: {
        matchedTerms,
        matchLocations,
        matchContexts,
        classificationSource: 'isCultTopicPrecise-rejected-coerciveControlOnly',
        filtersChecked,
        filterResults,
        properNouns: [...properNouns],
        matchedAliases,
        classifiedAt: new Date().toISOString(),
      },
    };
  }

  if (hasNonAmbiguousSpecific || urlSignal) {
    return {
      isCultRelated: true,
      audit: {
        matchedTerms,
        matchLocations,
        matchContexts,
        classificationSource: 'isCultTopicPrecise-specificOrUrl',
        filtersChecked,
        filterResults,
        properNouns: [...properNouns],
        matchedAliases,
        classifiedAt: new Date().toISOString(),
      },
    };
  }

  if (!titleGenericSignal && !bodyGenericSignal) {
    return {
      isCultRelated: false,
      audit: {
        matchedTerms,
        matchLocations,
        matchContexts,
        classificationSource: 'isCultTopicPrecise-rejected-noGenericSignal',
        filtersChecked,
        filterResults,
        properNouns: [...properNouns],
        matchedAliases,
        classifiedAt: new Date().toISOString(),
      },
    };
  }

  filtersChecked.push('commercialFigurative');
  const commercialFigurative = hasCommercialFigurativeCultUsage(titleLower, bodyLeadLower, language);
  filterResults['commercialFigurative'] = {
    passed: !commercialFigurative,
    reason: commercialFigurative ? 'Commercial/figurative cult usage detected' : 'No commercial figurative usage',
  };

  if (!hasNonAmbiguousSpecific && commercialFigurative) {
    return {
      isCultRelated: false,
      audit: {
        matchedTerms,
        matchLocations,
        matchContexts,
        classificationSource: 'isCultTopicPrecise-rejected-commercialFigurative',
        filtersChecked,
        filterResults,
        properNouns: [...properNouns],
        matchedAliases,
        classifiedAt: new Date().toISOString(),
      },
    };
  }

  filtersChecked.push('figurativeUsage');
  const combinedLead = `${titleLower} ${bodyLeadLower}`;
  const figurativeUsage = hasFigurativeCultUsage(combinedLead, language);
  const substantiveCultSubject =
    figurativeUsage && hasSubstantiveCultSubjectMatter(`${titleLower} ${text.slice(0, 8000)}`, language);
  filterResults['figurativeUsage'] = {
    passed: !figurativeUsage || substantiveCultSubject,
    reason: figurativeUsage
      ? substantiveCultSubject
        ? 'Figurative genre language but substantive cult subject matter'
        : 'Figurative cult usage in entertainment context'
      : 'No figurative usage detected',
  };

  return {
    isCultRelated: !figurativeUsage || substantiveCultSubject,
    audit: {
      matchedTerms,
      matchLocations,
      matchContexts,
      classificationSource:
        figurativeUsage && !substantiveCultSubject
          ? 'isCultTopicPrecise-rejected-figurative'
          : substantiveCultSubject
            ? 'isCultTopicPrecise-passed-substantiveCultSubject'
            : 'isCultTopicPrecise-passed',
      filtersChecked,
      filterResults,
      properNouns: [...properNouns],
      matchedAliases,
      classifiedAt: new Date().toISOString(),
    },
  };
}

function isCultTopicPrecise(title: string, text: string, url: string, language?: string): boolean {
  return isCultTopicPreciseWithAudit(title, text, url, language).isCultRelated;
}

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, '');
}

function isGoogleNewsWrapperUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return normalizeHost(parsed.hostname) === 'news.google.com' && parsed.pathname.startsWith('/rss/articles/');
  } catch {
    return false;
  }
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

function previewPlainText(text: string, maxLen: number): string {
  return text
    .slice(0, maxLen)
    .replace(/\s+/g, ' ')
    .trim();
}

function createDraft(
  title: string,
  text: string,
  sourceLine: string,
  region: 'UK' | 'Europe',
  confidence: number,
  source: PipelineResult['source'],
  audit?: DraftPayload['classificationAudit']
): DraftPayload {
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
    classificationAudit: audit,
  };
}

async function fetchBestArchiveResponse(
  url: string,
): Promise<Awaited<ReturnType<typeof fetchTextResilient>> | undefined> {
  const mirrorUrls = [
    `https://archive.ph/newest/${url}`,
    `https://archive.is/newest/${url}`,
  ];
  let best: Awaited<ReturnType<typeof fetchTextResilient>> | undefined;

  for (const mirrorUrl of mirrorUrls) {
    const archiveResponse = await fetchTextResilient(mirrorUrl);
    if (!archiveResponse.ok) continue;
    const archivePlain = htmlToPlainArticleText(archiveResponse.text, 2500);
    if (!archivePlain.trim() || looksLikeBlockedFetchPage(archivePlain)) continue;
    if (!best || archivePlain.length > htmlToPlainArticleText(best.text, 2500).length) {
      best = archiveResponse;
    }
  }

  return best;
}

export async function runPipeline(
  url: string,
  allowedHosts: Set<string>,
  options: RunPipelineOptions = {},
  archiveFallbackHosts: Set<string> = new Set(),
): Promise<PipelineResult> {
  if (isGoogleNewsWrapperUrl(url)) {
    const now = new Date().toISOString();
    return {
      status: 'rejected',
      source: {
        url,
        publisher: 'Google News',
        host: 'news.google.com',
        retrievedAt: now,
        reliabilityScore: 0,
        reliabilityReasons: ['Unresolved Google News RSS wrapper URL'],
      },
      relevance: {
        accepted: false,
        region: 'Unknown',
        confidence: 0,
        reasons: ['Article URL could not be resolved from Google News wrapper'],
      },
      reason: 'Unresolved Google News wrapper URL',
    };
  }

  let effectiveUrl = url;
  let contentMirrorUrl: string | undefined;
  let response = await fetchTextResilient(effectiveUrl);

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
        const archiveResponse = await fetchBestArchiveResponse(effectiveUrl);
        if (archiveResponse?.ok) {
          response = archiveResponse;
          contentMirrorUrl = archiveResponse.url;
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

  if (!contentMirrorUrl) {
    try {
      const originalHost = normalizeHost(new URL(url).hostname);
      const shouldTryArchive = Array.from(archiveFallbackHosts).some(
        (h) => originalHost === h || originalHost.endsWith(`.${h}`),
      );
      if (shouldTryArchive && looksLikePartialPaywall(htmlToPlainArticleText(html, 2500))) {
        const archiveResponse = await fetchBestArchiveResponse(url);
        if (archiveResponse?.ok) {
          const archivePlain = htmlToPlainArticleText(archiveResponse.text, 2500);
          const directPlain = htmlToPlainArticleText(html, 2500);
          if (archivePlain.length > directPlain.length + 400) {
            response = archiveResponse;
            contentMirrorUrl = archiveResponse.url;
            html = archiveResponse.text;
          }
        }
      }
    } catch {
      // Keep direct fetch when archive retry fails.
    }
  }

  effectiveUrl = response.url;
  const canonicalUrl = getCanonicalArticleUrl(url);

  if (options.requiresUrlResolution || Boolean(getResolverForUrl(effectiveUrl))) {
    const resolver = getResolverForUrl(effectiveUrl);
    const resolvedUrl = resolver?.(html, effectiveUrl);
    if (resolvedUrl && resolvedUrl !== effectiveUrl) {
      try {
        const resolvedResponse = await fetchTextResilient(resolvedUrl);

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

  const pageMeta = extractPageMetadataFromHtml(html);
  const publishedAt = pageMeta.publishedAt;
  const reliabilityUrl = isArchiveMirrorHost(new URL(effectiveUrl).hostname) ? canonicalUrl : effectiveUrl;
  const source = {
    ...evaluateSourceReliability(reliabilityUrl, allowedHosts, publishedAt),
    url: getCanonicalArticleUrl(reliabilityUrl),
    ...(contentMirrorUrl ? { contentMirrorUrl } : {}),
  };
  const missingAllowlistOnly =
    source.reliabilityReasons.includes('Source host is not on reliability allowlist') &&
    !source.reliabilityReasons.includes('Non-HTTPS source URL') &&
    !source.reliabilityReasons.includes('No publication date detected');

  if (source.reliabilityScore < 70 && !missingAllowlistOnly) {
    const title = pageMeta.title ?? 'Untitled source story';
    const textPreview = htmlToPlainArticleText(html, 420);
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
      title,
      textPreview,
    };
  }

  const language = detectLanguageFromHtml(html);
  const title = pageMeta.title ?? 'Untitled source story';
  const text = htmlToPlainArticleText(html, 15000);
  const relevance = evaluateRelevance(`${title} ${text}`, language);
  const leadRegionSignal = hasConfiguredRegionalSignalInText(`${title} ${text.slice(0, 2800)}`);

  const textPreview = previewPlainText(text, 420);

  // Get cult classification with audit trail
  const cultClassification = isCultTopicPreciseWithAudit(title, text, source.url, language);
  if (!cultClassification.isCultRelated) {
    return {
      status: 'rejected',
      source,
      relevance,
      reason: 'Story failed strict cult-topic precision checks',
      title,
      textPreview,
    };
  }

  if (!relevance.accepted || (relevance.region !== 'UK' && relevance.region !== 'Europe')) {
    return {
      status: 'rejected',
      source,
      relevance,
      reason: 'Story does not meet UK/EU cult-topic relevance threshold',
      title,
      textPreview,
    };
  }

  if (!isLikelyConfiguredRegionalHost(source.host) && !leadRegionSignal) {
    return {
      status: 'rejected',
      source,
      relevance,
      reason: 'Story does not have a configured regional source or configured regional geographic signal',
      title,
      textPreview,
    };
  }

  const sourceLine = `${source.publisher} (${source.url})`;
  const draft = createDraft(title, text, sourceLine, relevance.region, relevance.confidence, source, cultClassification.audit);

  return {
    status: 'drafted',
    source,
    relevance,
    draft,
  };
}
