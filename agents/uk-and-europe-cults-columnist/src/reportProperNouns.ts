import { readFileSync } from 'node:fs';
import { clusterStopwordsForLanguage } from './clusterStopwords.ts';
import { extractQuotedSpans } from './quotePatterns.ts';
import { stripPublisherBoilerplate } from './publisherBoilerplate.ts';

const SUBJECT_ALIASES: Array<{ canonical: string; aliases: Array<{ text: string; lang?: string }> }> =
  JSON.parse(readFileSync(new URL('../data/subject-aliases.json', import.meta.url), 'utf-8'));

const NAV_UI_JUNK = new Set([
  'share',
  'save',
  'add',
  'google',
  'menu',
  'site',
  'search',
  'subscribe',
  'comments',
  'reviews',
  'interviews',
  'videos',
  'features',
  'festivals',
  'hollywood',
  'indie',
  'international',
  'weird',
  'skip',
  'preferred',
  'days',
  'ago',
  'view',
  'images',
  'read',
  'copy',
  'citation',
  'here',
  'click',
  'report',
  'policy',
  'privacy',
  'advertise',
  'agreement',
  'bluesky',
  'facebook',
  'rss',
  'anarchist',
  'anarchy',
]);

const COMMON_SENTENCE_START_NOUNS = new Set([
  'workers',
  'skipper',
  'article',
  'five',
  'over',
  'during',
  'most',
  'looking',
  'directed',
  'attending',
  'soon',
  'from',
  'regrets',
  'thoughtful',
]);

const GENERIC_PHRASE_PREFIXES = ['bring me', 'watch ', 'read more', 'latest stories'];

const GENERIC_HEADLINE_WORDS = new Set([
  'bring',
  'beauties',
  'me',
  'the',
  'model',
  'cult',
  'review',
  'story',
  'stories',
  'latest',
  'news',
  'update',
  'watch',
  'video',
  'single',
  'album',
  'series',
  'episode',
  'episodes',
]);

function normalizeForMatch(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function containsPhrase(haystack: string, phrase: string): boolean {
  const normalizedHaystack = normalizeForMatch(haystack);
  const normalizedPhrase = normalizeForMatch(phrase);
  if (!normalizedPhrase) return false;
  return normalizedHaystack.includes(normalizedPhrase);
}

const FOOTER_PHRASE_MARKERS = [
  'privacy policy',
  'user agreement',
  'about screenanarchy',
  'subscribe to screen',
  'be anarchist',
  'recent posts',
  'leading voices',
  'around the internet',
  'stream bring me',
  'copy citations',
  'comments news by',
  'follow teessidelive',
  'whatsapp bring',
];

function isNavOrUiJunk(term: string): boolean {
  const lower = normalizeForMatch(term);
  if (!lower || lower.length < 3) return true;
  if (NAV_UI_JUNK.has(lower)) return true;
  if (/\bsite menu\b/.test(lower)) return true;
  if (/\bshare\s+save\b/.test(lower)) return true;
  if (FOOTER_PHRASE_MARKERS.some((marker) => lower.includes(marker))) return true;
  if (/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}\s+\d{4}\b/.test(lower)) {
    return true;
  }
  if (/\d{4}/.test(lower) && lower.split(/\s+/).length === 1) return true;
  return false;
}

function isMostlyStopwords(term: string, stopwords: Set<string>): boolean {
  const words = normalizeForMatch(term).split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const stopwordCount = words.filter((word) => stopwords.has(word)).length;
  return stopwordCount / words.length >= 0.85;
}

function addTerm(results: Set<string>, term: string, stopwords: Set<string>): void {
  const cleaned = normalizeForMatch(term);
  if (cleaned.length < 3) return;
  if (isNavOrUiJunk(cleaned)) return;
  if (isMostlyStopwords(cleaned, stopwords)) return;
  if (cleaned.split(/\s+/).length > 6) return;
  if (cleaned.length > 72) return;
  if (cleaned.split(/\s+/).length === 1 && GENERIC_HEADLINE_WORDS.has(cleaned)) return;
  const words = cleaned.split(/\s+/).filter(Boolean);
  const firstWord = words[0];
  if (firstWord && COMMON_SENTENCE_START_NOUNS.has(firstWord)) return;
  if (words.length >= 2 && words.every((word) => GENERIC_HEADLINE_WORDS.has(word) || stopwords.has(word))) {
    return;
  }
  if (GENERIC_PHRASE_PREFIXES.some((prefix) => cleaned.startsWith(prefix))) {
    return;
  }
  const MID_PHRASE_VERBS = new Set([
    'also',
    'propelled',
    'following',
    'said',
    'were',
    'has',
    'have',
    'managed',
    'reports',
    'essential',
    'fresh',
    'dropping',
  ]);
  if (
    words.length >= 3 &&
    words.some((word, index) => index > 0 && index < words.length - 1 && MID_PHRASE_VERBS.has(word))
  ) {
    return;
  }
  results.add(cleaned);
}

function pruneSubsumedTerms(terms: string[]): string[] {
  const sorted = [...terms].sort((a, b) => b.length - a.length);
  const kept: string[] = [];
  for (const term of sorted) {
    if (kept.some((longer) => longer.includes(term) && longer !== term)) {
      continue;
    }
    kept.push(term);
  }
  return kept.sort((a, b) => b.length - a.length || a.localeCompare(b));
}

/** Proper nouns for review/summariser output — no nav tokens or quoted-sentence debris. */
export function extractReportProperNouns(text: string, language = 'en'): string[] {
  const stopwords = clusterStopwordsForLanguage(language);
  const cleaned = stripPublisherBoilerplate(text).slice(0, 5000);
  const results = new Set<string>();

  for (const entry of SUBJECT_ALIASES) {
    for (const alias of entry.aliases) {
      if (alias.lang && alias.lang !== language && language !== 'en') continue;
      if (containsPhrase(cleaned, alias.text)) {
        addTerm(results, entry.canonical, stopwords);
      }
    }
    if (containsPhrase(cleaned, entry.canonical)) {
      addTerm(results, entry.canonical, stopwords);
    }
  }

  const capitalizedWordPattern = /\b[A-Z][\p{L}'’-]{1,}\b/gu;
  const capitalizedWords: Array<{ word: string; index: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = capitalizedWordPattern.exec(cleaned)) !== null) {
    capitalizedWords.push({ word: match[0], index: match.index });
  }

  for (let i = 0; i < capitalizedWords.length; i += 1) {
    const current = capitalizedWords[i];
    if (!current) continue;

    addTerm(results, current.word, stopwords);

    let phrase = current.word;
    let phraseEnd = current.index + current.word.length;

    for (let j = i + 1; j < capitalizedWords.length; j += 1) {
      const next = capitalizedWords[j];
      if (!next) break;

      const between = cleaned.slice(phraseEnd, next.index).trim().toLowerCase();
      const betweenWords = between.split(/\s+/).filter(Boolean);
      const onlyStopwords =
        betweenWords.length === 0 || betweenWords.every((word) => stopwords.has(word));

      if (onlyStopwords && betweenWords.length <= 2) {
        phrase += ` ${between} ${next.word}`;
        phraseEnd = next.index + next.word.length;
        if (phrase.split(/\s+/).filter((w) => /^[A-Z]/.test(w)).length >= 2) {
          addTerm(results, phrase, stopwords);
        }
      } else {
        break;
      }
    }
  }

  for (const quoted of extractQuotedSpans(cleaned)) {
    const trimmed = quoted.trim();
    const wordCount = trimmed.split(/\s+/).length;
    if (wordCount < 2 || wordCount > 6) continue;
    if (!/[A-Z]/.test(trimmed)) continue;
    addTerm(results, trimmed, stopwords);
  }

  return pruneSubsumedTerms([...results]);
}

export function matchReportProperNounAliases(properNouns: string[]): string[] {
  const matched = new Set<string>();
  for (const noun of properNouns) {
    for (const entry of SUBJECT_ALIASES) {
      if (noun === normalizeForMatch(entry.canonical)) {
        matched.add(entry.canonical);
        continue;
      }
      for (const alias of entry.aliases) {
        if (noun === normalizeForMatch(alias.text)) {
          matched.add(entry.canonical);
        }
      }
    }
  }
  return [...matched].sort();
}

export function matchSubjectAliasesInText(text: string, language = 'en'): string[] {
  const properNouns = extractReportProperNouns(text, language);
  return matchReportProperNounAliases(properNouns);
}
