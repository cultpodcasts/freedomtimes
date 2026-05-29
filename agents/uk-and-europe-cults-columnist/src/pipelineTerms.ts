import { readdirSync, readFileSync } from 'node:fs';
import { normalizeCultLanguageCode } from './cultTerms.ts';

/**
 * Interface for subject-aliases.json
 * Maps canonical subject names to their aliases in different languages
 */
export interface SubjectAlias {
  /** Canonical (English) name of the subject */
  canonical: string;
  /** Array of aliases, optionally with language codes */
  aliases: SubjectAliasEntry[];
}

export interface SubjectAliasEntry {
  /** The alias text */
  text: string;
  /** Optional ISO 639-1 language code (e.g., 'fr', 'de', 'it') */
  lang?: string;
}

function loadSubjectAliases(): SubjectAlias[] {
  const fileUrl = new URL('../data/subject-aliases.json', import.meta.url);
  const raw = readFileSync(fileUrl, 'utf-8');
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error('subject-aliases.json must be an array');
  }
  return parsed as SubjectAlias[];
}

const SUBJECT_ALIASES = loadSubjectAliases();

function getReligiousEntityTermsForLanguage(language: string | undefined): string[] {
  const code = normalizeCultLanguageCode(language);
  const terms: string[] = [];
  
  for (const { canonical, aliases } of SUBJECT_ALIASES) {
    // Add canonical (English) term
    terms.push(canonical);
    
    // Add language-specific aliases
    for (const alias of aliases) {
      if (!alias.lang || alias.lang === code) {
        terms.push(alias.text);
      }
    }
  }
  
  return Array.from(new Set(terms));
}

function loadStringArrayFromJson(path: string): string[] {
  const fileUrl = new URL(path, import.meta.url);
  const raw = readFileSync(fileUrl, 'utf-8');
  const parsed = JSON.parse(raw) as unknown;

  if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === 'string')) {
    throw new Error(`Expected a JSON string array in ${path}`);
  }

  return parsed;
}


export const EXCLUDED_SOURCE_HOSTS = loadStringArrayFromJson('../data/excluded-source-hosts.json');

function loadFigurativeTermFieldFromDiscoveryLangFiles(
  field: 'figurativeCultPhrases' | 'figurativeCultContextTerms' | 'figurativeCultCommercialContextTerms',
): Record<string, string[]> {
  const langDirUrl = new URL('../data/discovery/lang/', import.meta.url);
  const names = readdirSync(langDirUrl).filter((n) => n.endsWith('.json'));
  const result: Record<string, string[]> = {};

  for (const name of names) {
    const fileUrl = new URL(name, langDirUrl);
    const raw = readFileSync(fileUrl, 'utf-8');
    const parsed = JSON.parse(raw) as { language?: unknown } & Record<string, unknown>;
    const fromFileName = name.replace(/\.json$/i, '').toLowerCase();
    const lang =
      typeof parsed.language === 'string' && parsed.language.trim()
        ? parsed.language.trim().toLowerCase()
        : fromFileName;

    const terms = parsed[field];
    if (terms === undefined) {
      result[lang] = [];
      continue;
    }
    if (!Array.isArray(terms) || !terms.every((t) => typeof t === 'string')) {
      throw new Error(`data/discovery/lang/${name}: ${field} must be a string array when present`);
    }
    result[lang] = terms as string[];
  }

  return result;
}

function loadFigurativeRegexFieldFromDiscoveryLangFiles(): Record<string, RegExp[]> {
  const langDirUrl = new URL('../data/discovery/lang/', import.meta.url);
  const names = readdirSync(langDirUrl).filter((n) => n.endsWith('.json'));
  const result: Record<string, RegExp[]> = {};

  for (const name of names) {
    const fileUrl = new URL(name, langDirUrl);
    const raw = readFileSync(fileUrl, 'utf-8');
    const parsed = JSON.parse(raw) as { language?: unknown; figurativeCultRegexPatterns?: unknown };
    const fromFileName = name.replace(/\.json$/i, '').toLowerCase();
    const lang =
      typeof parsed.language === 'string' && parsed.language.trim()
        ? parsed.language.trim().toLowerCase()
        : fromFileName;

    const patterns = parsed.figurativeCultRegexPatterns;
    if (patterns === undefined) {
      result[lang] = [];
      continue;
    }
    if (!Array.isArray(patterns) || !patterns.every((p) => typeof p === 'string')) {
      throw new Error(`data/discovery/lang/${name}: figurativeCultRegexPatterns must be a string array when present`);
    }
    result[lang] = (patterns as string[]).map((p) => new RegExp(p, 'iu'));
  }

  return result;
}


export const FIGURATIVE_CULT_CONTEXT_TERMS_BY_LANGUAGE = loadFigurativeTermFieldFromDiscoveryLangFiles('figurativeCultContextTerms');
export const FIGURATIVE_CULT_COMMERCIAL_CONTEXT_TERMS_BY_LANGUAGE = loadFigurativeTermFieldFromDiscoveryLangFiles('figurativeCultCommercialContextTerms');
export const FIGURATIVE_CULT_PHRASES_BY_LANGUAGE = loadFigurativeTermFieldFromDiscoveryLangFiles('figurativeCultPhrases');

function loadNewsCoveragePrepositionsFromDiscoveryLangFiles(): Record<string, string[]> {
  const langDirUrl = new URL('../data/discovery/lang/', import.meta.url);
  const names = readdirSync(langDirUrl).filter((n) => n.endsWith('.json'));
  const result: Record<string, string[]> = {};

  for (const name of names) {
    const fileUrl = new URL(name, langDirUrl);
    const raw = readFileSync(fileUrl, 'utf-8');
    const parsed = JSON.parse(raw) as { language?: unknown; newsCoveragePrepositions?: unknown };
    const fromFileName = name.replace(/\.json$/i, '').toLowerCase();
    const lang =
      typeof parsed.language === 'string' && parsed.language.trim()
        ? parsed.language.trim().toLowerCase()
        : fromFileName;

    const prepositions = parsed.newsCoveragePrepositions;
    if (prepositions === undefined) {
      result[lang] = [];
      continue;
    }
    if (!Array.isArray(prepositions) || !prepositions.every((p) => typeof p === 'string')) {
      throw new Error(`data/discovery/lang/${name}: newsCoveragePrepositions must be a string array when present`);
    }
    result[lang] = prepositions as string[];
  }

  return result;
}

export const NEWS_COVERAGE_PREPOSITIONS_BY_LANGUAGE = loadNewsCoveragePrepositionsFromDiscoveryLangFiles();

function loadCultTermsFromDiscoveryLangFiles(): Record<string, string[]> {
  const langDirUrl = new URL('../data/discovery/lang/', import.meta.url);
  const names = readdirSync(langDirUrl).filter((n) => n.endsWith('.json'));
  const result: Record<string, string[]> = {};

  for (const name of names) {
    const fileUrl = new URL(name, langDirUrl);
    const raw = readFileSync(fileUrl, 'utf-8');
    const parsed = JSON.parse(raw) as { language?: unknown; cultTerms?: unknown };
    const fromFileName = name.replace(/\.json$/i, '').toLowerCase();
    const lang =
      typeof parsed.language === 'string' && parsed.language.trim()
        ? parsed.language.trim().toLowerCase()
        : fromFileName;

    const cultTerms = parsed.cultTerms;
    if (cultTerms === undefined) {
      result[lang] = [];
      continue;
    }
    if (!Array.isArray(cultTerms) || !cultTerms.every((t) => typeof t === 'string')) {
      throw new Error(`data/discovery/lang/${name}: cultTerms must be a string array when present`);
    }
    result[lang] = cultTerms as string[];
  }

  return result;
}

export const CULT_TERMS_BY_LANGUAGE = loadCultTermsFromDiscoveryLangFiles();
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

function loadTermFieldFromDiscoveryLangFiles(field: 'religiousGroupTerms' | 'coerciveHarmTerms'): Record<string, string[]> {
  const langDirUrl = new URL('../data/discovery/lang/', import.meta.url);
  const names = readdirSync(langDirUrl).filter((n) => n.endsWith('.json'));
  const result: Record<string, string[]> = {};

  for (const name of names) {
    const fileUrl = new URL(name, langDirUrl);
    const raw = readFileSync(fileUrl, 'utf-8');
    const parsed = JSON.parse(raw) as { language?: unknown } & Record<string, unknown>;
    const fromFileName = name.replace(/\.json$/i, '').toLowerCase();
    const lang =
      typeof parsed.language === 'string' && parsed.language.trim()
        ? parsed.language.trim().toLowerCase()
        : fromFileName;

    const terms = parsed[field];
    if (terms === undefined) {
      result[lang] = [];
      continue;
    }
    if (!Array.isArray(terms) || !terms.every((t) => typeof t === 'string')) {
      throw new Error(`data/discovery/lang/${name}: ${field} must be a string array when present`);
    }
    result[lang] = terms as string[];
  }

  return result;
}

function loadAmbiguousCultTermsFromDiscoveryLangFiles(): Record<string, string[]> {
  const langDirUrl = new URL('../data/discovery/lang/', import.meta.url);
  const names = readdirSync(langDirUrl).filter((n) => n.endsWith('.json'));
  const result: Record<string, string[]> = {};

  for (const name of names) {
    const fileUrl = new URL(name, langDirUrl);
    const raw = readFileSync(fileUrl, 'utf-8');
    const parsed = JSON.parse(raw) as { language?: unknown; ambiguousCultTerms?: unknown };
    const fromFileName = name.replace(/\.json$/i, '').toLowerCase();
    const lang =
      typeof parsed.language === 'string' && parsed.language.trim()
        ? parsed.language.trim().toLowerCase()
        : fromFileName;

    const terms = parsed.ambiguousCultTerms;
    if (terms === undefined) {
      result[lang] = [];
      continue;
    }
    if (!Array.isArray(terms) || !terms.every((t) => typeof t === 'string')) {
      throw new Error(`data/discovery/lang/${name}: ambiguousCultTerms must be a string array when present`);
    }
    result[lang] = terms as string[];
  }

  return result;
}

/** Weak cult/sect tokens per locale — from `data/discovery/lang/<code>.json`. */
export const AMBIGUOUS_CULT_TERMS_BY_LANGUAGE = loadAmbiguousCultTermsFromDiscoveryLangFiles();

/** Per-locale “harm / control” phrases for precise cult-topic matching — from `data/discovery/lang/<code>.json`. */
export const STRICT_CULT_TERM_EXTENSIONS_BY_LANGUAGE = loadStrictCultTermExtensionsFromDiscoveryLangFiles();

export const RELIGIOUS_GROUP_TERMS_BY_LANGUAGE = loadTermFieldFromDiscoveryLangFiles('religiousGroupTerms');
export const COERCIVE_HARM_TERMS_BY_LANGUAGE = loadTermFieldFromDiscoveryLangFiles('coerciveHarmTerms');

export function getStrictCultTermExtensionsForLanguage(language: string | undefined): string[] {
  const code = normalizeCultLanguageCode(language);
  return STRICT_CULT_TERM_EXTENSIONS_BY_LANGUAGE[code] ?? [];
}

export function getReligiousGroupTermsForLanguage(language: string | undefined): string[] {
  const code = normalizeCultLanguageCode(language);
  // Use cluster-entity-aliases.json as the source for religious entity terms
  // This includes canonical (English) terms and language-specific aliases
  const entityAliasTerms = getReligiousEntityTermsForLanguage(code);
  // Fall back to lang file religiousGroupTerms for any additional terms
  const localTerms = RELIGIOUS_GROUP_TERMS_BY_LANGUAGE[code] ?? [];
  const englishTerms = RELIGIOUS_GROUP_TERMS_BY_LANGUAGE.en ?? [];
  return Array.from(new Set([...entityAliasTerms, ...localTerms, ...englishTerms]));
}

export function getCoerciveHarmTermsForLanguage(language: string | undefined): string[] {
  const code = normalizeCultLanguageCode(language);
  const localTerms = COERCIVE_HARM_TERMS_BY_LANGUAGE[code] ?? [];
  const englishTerms = COERCIVE_HARM_TERMS_BY_LANGUAGE.en ?? [];
  return Array.from(new Set([...localTerms, ...englishTerms]));
}

/** Flat deduplicated set of all generic cult/sect words across all languages — used for URL pattern matching. */
export const ALL_GENERIC_CULT_TERMS = Array.from(new Set(Object.values(GENERIC_CULT_TERMS_BY_LANGUAGE).flat()));

/** Explicit regex patterns per language — from lang files (figurativeCultRegexPatterns field). */
export const FIGURATIVE_CULT_REGEX_PATTERNS_BY_LANGUAGE = loadFigurativeRegexFieldFromDiscoveryLangFiles();
