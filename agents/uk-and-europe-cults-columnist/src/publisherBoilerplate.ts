import { readdirSync, readFileSync } from 'node:fs';

let cutPatternsCache: RegExp[] | undefined;

/** Paywall / subscription tail patterns from `data/discovery/lang/<code>.json` → `publisherBoilerplateCutPatterns`. */
function loadPublisherBoilerplateCutPatternStrings(): string[] {
  const langDirUrl = new URL('../data/discovery/lang/', import.meta.url);
  const names = readdirSync(langDirUrl).filter((n) => n.endsWith('.json'));
  const patterns = new Set<string>();

  for (const name of names) {
    const fileUrl = new URL(name, langDirUrl);
    const parsed = JSON.parse(readFileSync(fileUrl, 'utf-8')) as {
      publisherBoilerplateCutPatterns?: unknown;
    };
    const raw = parsed.publisherBoilerplateCutPatterns;
    if (raw === undefined) continue;
    if (!Array.isArray(raw) || !raw.every((entry) => typeof entry === 'string')) {
      throw new Error(
        `data/discovery/lang/${name}: publisherBoilerplateCutPatterns must be a string array when present`,
      );
    }
    for (const entry of raw) {
      const trimmed = entry.trim();
      if (trimmed) patterns.add(trimmed);
    }
  }

  return [...patterns];
}

function publisherBoilerplateCutPatterns(): RegExp[] {
  if (cutPatternsCache) return cutPatternsCache;
  cutPatternsCache = loadPublisherBoilerplateCutPatternStrings().map(
    (source) => new RegExp(source, 'iu'),
  );
  return cutPatternsCache;
}

/** Remove subscription / paywall chrome so similarity reflects story content, not publisher templates. */
export function stripPublisherBoilerplate(text: string): string {
  let cleaned = text;
  for (const pattern of publisherBoilerplateCutPatterns()) {
    cleaned = cleaned.replace(pattern, ' ');
  }
  return cleaned.replace(/\s+/g, ' ').trim();
}
