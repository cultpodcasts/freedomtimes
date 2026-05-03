import { readdirSync, readFileSync } from 'node:fs';
import { normalizeCultLanguageCode } from './cultTerms.js';

function loadStringArrayFromJson(path: string): string[] {
  const fileUrl = new URL(path, import.meta.url);
  const raw = readFileSync(fileUrl, 'utf-8');
  const parsed = JSON.parse(raw) as unknown;

  if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === 'string')) {
    throw new Error(`Expected a JSON string array in ${path}`);
  }

  return parsed;
}

function loadStringArraysByLanguage(path: string): Record<string, string[]> {
  const fileUrl = new URL(path, import.meta.url);
  const raw = readFileSync(fileUrl, 'utf-8');
  const parsed = JSON.parse(raw) as unknown;

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Expected a JSON object in ${path}`);
  }

  const result: Record<string, string[]> = {};
  for (const [lang, terms] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(terms) || !terms.every((t) => typeof t === 'string')) {
      throw new Error(`Expected a string array for language "${lang}" in ${path}`);
    }
    result[lang] = terms as string[];
  }
  return result;
}

function loadRegexPatternsByLanguage(path: string): Record<string, RegExp[]> {
  const fileUrl = new URL(path, import.meta.url);
  const raw = readFileSync(fileUrl, 'utf-8');
  const parsed = JSON.parse(raw) as unknown;

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Expected a JSON object in ${path}`);
  }

  const result: Record<string, RegExp[]> = {};
  for (const [lang, patterns] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(patterns) || !patterns.every((p) => typeof p === 'string')) {
      throw new Error(`Expected a string array for language "${lang}" in ${path}`);
    }
    result[lang] = (patterns as string[]).map((p) => new RegExp(p, 'iu'));
  }
  return result;
}

export const EXCLUDED_SOURCE_HOSTS = loadStringArrayFromJson('../data/excluded-source-hosts.json');

export const FIGURATIVE_CULT_CONTEXT_TERMS_BY_LANGUAGE = loadStringArraysByLanguage('../data/figurative-cult-context-terms.json');
export const FIGURATIVE_CULT_COMMERCIAL_CONTEXT_TERMS_BY_LANGUAGE = loadStringArraysByLanguage('../data/figurative-cult-commercial-context-terms.json');
export const FIGURATIVE_CULT_PHRASES_BY_LANGUAGE = loadStringArraysByLanguage('../data/figurative-cult-phrases.json');
function loadGenericCultTermsFromDiscoveryLangFiles(): Record<string, string[]> {
  const langDirUrl = new URL('../data/discovery/lang/', import.meta.url);
  const names = readdirSync(langDirUrl).filter((n) => n.endsWith('.json'));
  const result: Record<string, string[]> = {};

  for (const name of names) {
    const fileUrl = new URL(name, langDirUrl);
    const raw = readFileSync(fileUrl, 'utf-8');
    const parsed = JSON.parse(raw) as { language?: unknown; genericCultTerms?: unknown };
    const fromFileName = name.replace(/\.json$/i, '').toLowerCase();
    const lang =
      typeof parsed.language === 'string' && parsed.language.trim()
        ? parsed.language.trim().toLowerCase()
        : fromFileName;

    const terms = parsed.genericCultTerms;
    if (terms === undefined) {
      result[lang] = [];
      continue;
    }
    if (!Array.isArray(terms) || !terms.every((t) => typeof t === 'string')) {
      throw new Error(`data/discovery/lang/${name}: genericCultTerms must be a string array when present`);
    }
    result[lang] = terms as string[];
  }

  return result;
}

/** Weak cult/sect tokens per locale — from `data/discovery/lang/<code>.json`. */
export const GENERIC_CULT_TERMS_BY_LANGUAGE = loadGenericCultTermsFromDiscoveryLangFiles();

function loadStrictCultTermExtensionsFromDiscoveryLangFiles(): Record<string, string[]> {
  const langDirUrl = new URL('../data/discovery/lang/', import.meta.url);
  const names = readdirSync(langDirUrl).filter((n) => n.endsWith('.json'));
  const result: Record<string, string[]> = {};

  for (const name of names) {
    const fileUrl = new URL(name, langDirUrl);
    const raw = readFileSync(fileUrl, 'utf-8');
    const parsed = JSON.parse(raw) as { language?: unknown; strictCultTermExtensions?: unknown };
    const fromFileName = name.replace(/\.json$/i, '').toLowerCase();
    const lang =
      typeof parsed.language === 'string' && parsed.language.trim()
        ? parsed.language.trim().toLowerCase()
        : fromFileName;

    const ext = parsed.strictCultTermExtensions;
    if (ext === undefined) {
      result[lang] = [];
      continue;
    }
    if (!Array.isArray(ext) || !ext.every((t) => typeof t === 'string')) {
      throw new Error(`data/discovery/lang/${name}: strictCultTermExtensions must be a string array when present`);
    }
    result[lang] = ext as string[];
  }

  return result;
}

/** Per-locale “harm / control” phrases for precise cult-topic matching — from `data/discovery/lang/<code>.json`. */
export const STRICT_CULT_TERM_EXTENSIONS_BY_LANGUAGE = loadStrictCultTermExtensionsFromDiscoveryLangFiles();

/** Strict “harm / control” phrases for precise cult-topic matching — only the article locale’s list (no cross-locale merge). */
export function getStrictCultTermExtensionsForLanguage(language: string | undefined): string[] {
  const code = normalizeCultLanguageCode(language);
  return STRICT_CULT_TERM_EXTENSIONS_BY_LANGUAGE[code] ?? [];
}

/** Flat deduplicated set of all generic cult/sect words across all languages — used for URL pattern matching. */
export const ALL_GENERIC_CULT_TERMS = Array.from(new Set(Object.values(GENERIC_CULT_TERMS_BY_LANGUAGE).flat()));

/** Explicit regex patterns per language from JSON (e.g. blanket German Kult- prefix). */
export const FIGURATIVE_CULT_REGEX_PATTERNS_BY_LANGUAGE = loadRegexPatternsByLanguage('../data/figurative-cult-patterns-by-language.json');
