import { readFileSync } from 'node:fs';

type StringArray = string[];

function loadStringArrayFromJson(path: string): StringArray {
  const fileUrl = new URL(path, import.meta.url);
  const raw = readFileSync(fileUrl, 'utf-8');
  const parsed = JSON.parse(raw) as unknown;

  if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === 'string')) {
    throw new Error(`Expected a JSON string array in ${path}`);
  }

  return parsed;
}

function loadPatternsByLanguage(path: string): Record<string, RegExp[]> {
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

export const STRICT_CULT_TERM_EXTENSIONS = loadStringArrayFromJson('../data/strict-cult-term-extensions.json');
export const GENERIC_CULT_TERMS = loadStringArrayFromJson('../data/generic-cult-terms.json');
export const FIGURATIVE_CULT_CONTEXT_TERMS = loadStringArrayFromJson('../data/figurative-cult-context-terms.json');
export const FIGURATIVE_CULT_PHRASES = loadStringArrayFromJson('../data/figurative-cult-phrases.json');
export const EXCLUDED_SOURCE_HOSTS = loadStringArrayFromJson('../data/excluded-source-hosts.json');
export const FIGURATIVE_CULT_PATTERNS_BY_LANGUAGE = loadPatternsByLanguage('../data/figurative-cult-patterns-by-language.json');
