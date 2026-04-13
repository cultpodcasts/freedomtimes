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

export const STRICT_CULT_TERM_EXTENSIONS = loadStringArrayFromJson('../data/strict-cult-term-extensions.json');
export const GENERIC_CULT_TERMS = loadStringArrayFromJson('../data/generic-cult-terms.json');
export const FIGURATIVE_CULT_CONTEXT_TERMS = loadStringArrayFromJson('../data/figurative-cult-context-terms.json');
export const FIGURATIVE_CULT_PHRASES = loadStringArrayFromJson('../data/figurative-cult-phrases.json');
export const EXCLUDED_SOURCE_HOSTS = loadStringArrayFromJson('../data/excluded-source-hosts.json');
