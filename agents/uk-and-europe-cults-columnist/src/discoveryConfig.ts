import { readFileSync } from 'node:fs';

type DiscoveryConfig = {
  googleNewsGenericQueries?: unknown;
  googleNewsQueryDefinitions?: unknown;
  newsdataCountryCodes?: unknown;
  newsdataLanguages?: unknown;
  newsdataQueries?: unknown;
  regionTerms?: unknown;
  regionalHostSuffixes?: unknown;
  focusSignalTerms?: unknown;
};

type GoogleNewsQueryDefinitions = {
  groups?: unknown;
  templates?: unknown;
  rawQueries?: unknown;
  /** Same length as `templates`: hl subtags (e.g. en, fr) or arrays of subtags; `null` = all europe locales. */
  templateLocaleHlPrefixes?: unknown;
};

/**
 * A query template contributed by a locale group file.
 * `hlPin`: hl subtag(s) to pin to — defaults to the file's `language` field.
 */
type LocaleQueryTemplate = { template: string; hlPin: string[] };

export type GoogleNewsTemplateQuerySpec = {
  query: string;
  googleNewsLocaleIds?: string[];
};

type GoogleNewsLocaleRow = { id: string; hl: string };

function loadGoogleNewsEuropeLocaleRows(): GoogleNewsLocaleRow[] {
  const configUrl = new URL('../data/google-news-europe-locales.json', import.meta.url);
  const raw = readFileSync(configUrl, 'utf-8');
  const parsed = JSON.parse(raw) as { locales?: unknown };
  if (!parsed.locales || !Array.isArray(parsed.locales)) {
    return [];
  }
  const out: GoogleNewsLocaleRow[] = [];
  for (const item of parsed.locales) {
    if (
      item &&
      typeof item === 'object' &&
      typeof (item as GoogleNewsLocaleRow).id === 'string' &&
      typeof (item as GoogleNewsLocaleRow).hl === 'string'
    ) {
      out.push(item as GoogleNewsLocaleRow);
    }
  }
  return out;
}

/** Primary BCP47 language subtag for matching templateLocaleHlPrefixes (en-GB → en). */
function primaryGoogleNewsHlSubtagForConfig(hl: string): string {
  const h = hl.trim().toLowerCase();
  if (h === 'en-gb' || h.startsWith('en-')) {
    return 'en';
  }
  return (h.split('-')[0] ?? h).trim() || 'en';
}

function localeIdsForHlSubtags(rows: GoogleNewsLocaleRow[], hlSubtags: string[]): string[] {
  const want = new Set(hlSubtags.map((s) => s.trim().toLowerCase()).filter(Boolean));
  if (want.size === 0) {
    return [];
  }
  const ids: string[] = [];
  for (const row of rows) {
    const sub = primaryGoogleNewsHlSubtagForConfig(row.hl).toLowerCase();
    if (want.has(sub)) {
      ids.push(row.id);
    }
  }
  return ids;
}

function expectStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`discovery-config.json field '${field}' must be a string array`);
  }
  return value;
}

function expectString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`discovery-config.json field '${field}' must be a string`);
  }
  return value;
}

function expectStringRecordOfArrays(value: unknown, field: string): Record<string, string[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`discovery-config.json field '${field}' must be an object of string arrays`);
  }

  const entries = Object.entries(value as Record<string, unknown>);
  const output: Record<string, string[]> = {};

  for (const [key, nested] of entries) {
    output[key] = expectStringArray(nested, `${field}.${key}`);
  }

  return output;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function formatGroupExpression(values: string[]): string {
  return `(${values.join(' OR ')})`;
}

function parseTemplateLocaleHlPrefixes(raw: unknown, templateCount: number): (string[] | null)[] {
  if (raw === undefined) {
    return Array.from({ length: templateCount }, () => null);
  }
  if (!Array.isArray(raw) || raw.length !== templateCount) {
    throw new Error(
      `googleNewsQueryDefinitions.templateLocaleHlPrefixes must be an array with the same length as templates (${templateCount})`,
    );
  }
  const out: (string[] | null)[] = [];
  for (const item of raw) {
    if (item === null) {
      out.push(null);
    } else if (typeof item === 'string') {
      out.push([item]);
    } else if (Array.isArray(item) && item.every((x) => typeof x === 'string')) {
      out.push(item as string[]);
    } else {
      throw new Error(
        'googleNewsQueryDefinitions.templateLocaleHlPrefixes entries must be null, a string, or string[]',
      );
    }
  }
  return out;
}

function pinKeyForSpecs(ids: string[] | undefined): string {
  if (!ids || ids.length === 0) {
    return 'ALL';
  }
  return [...ids].sort().join(',');
}

function buildGoogleNewsTemplateQuerySpecs(
  definitionsValue: unknown,
  fallbackQueries: string[] | undefined,
  localeRows: GoogleNewsLocaleRow[],
): GoogleNewsTemplateQuerySpec[] {
  if (definitionsValue === undefined) {
    return (fallbackQueries ?? [])
      .map((q) => normalizeWhitespace(q))
      .filter(Boolean)
      .map((query) => ({ query }));
  }

  if (!definitionsValue || typeof definitionsValue !== 'object' || Array.isArray(definitionsValue)) {
    throw new Error("discovery-config.json field 'googleNewsQueryDefinitions' must be an object");
  }

  const definitions = definitionsValue as GoogleNewsQueryDefinitions;
  const groups = expectStringRecordOfArrays(definitions.groups, 'googleNewsQueryDefinitions.groups');
  const templates = expectStringArray(definitions.templates, 'googleNewsQueryDefinitions.templates');
  const rawQueries =
    definitions.rawQueries === undefined
      ? []
      : expectStringArray(definitions.rawQueries, 'googleNewsQueryDefinitions.rawQueries');

  const pinSpecs = parseTemplateLocaleHlPrefixes(definitions.templateLocaleHlPrefixes, templates.length);

  const expanded: GoogleNewsTemplateQuerySpec[] = templates.map((template, idx) => {
    const query = template.replace(/\{\{\s*([a-zA-Z0-9_-]+)\s*\}\}/g, (_match, groupName: string) => {
      const groupValues = groups[groupName];
      if (!groupValues) {
        throw new Error(
          `discovery-config.json template references unknown group '${groupName}' in googleNewsQueryDefinitions.templates`,
        );
      }
      return formatGroupExpression(groupValues);
    });

    const normalized = normalizeWhitespace(query);
    const pin = pinSpecs[idx] ?? null;
    const googleNewsLocaleIds =
      pin === null || pin.length === 0
        ? undefined
        : localeIdsForHlSubtags(localeRows, pin);
    return {
      query: normalized,
      googleNewsLocaleIds:
        googleNewsLocaleIds && googleNewsLocaleIds.length > 0 ? googleNewsLocaleIds : undefined,
    };
  });

  for (const raw of rawQueries) {
    expanded.push({ query: normalizeWhitespace(raw) });
  }

  const seen = new Set<string>();
  const ordered: GoogleNewsTemplateQuerySpec[] = [];
  for (const spec of expanded) {
    if (!spec.query) {
      continue;
    }
    const k = `${spec.query}|||${pinKeyForSpecs(spec.googleNewsLocaleIds)}`;
    if (seen.has(k)) {
      continue;
    }
    seen.add(k);
    ordered.push(spec);
  }

  if (ordered.length === 0 && fallbackQueries?.length) {
    return fallbackQueries
      .map((q) => normalizeWhitespace(q))
      .filter(Boolean)
      .map((query) => ({ query }));
  }

  return ordered;
}

function loadWatchlistSites(): string[] {
  const configUrl = new URL('../watchlist-sites.json', import.meta.url);
  const raw = readFileSync(configUrl, 'utf-8');
  const parsed = JSON.parse(raw) as unknown;
  return expectStringArray(parsed, 'watchlist-sites');
}

function loadRegionalPublisherSites(): string[] {
  const configUrl = new URL('../data/regional-publisher-sites.json', import.meta.url);
  const raw = readFileSync(configUrl, 'utf-8');
  const parsed = JSON.parse(raw) as unknown;
  return expectStringArray(parsed, 'data/regional-publisher-sites');
}

/**
 * Merge `googleNewsQueryDefinitions.groups` (optional, legacy) with each JSON file in `groupFiles`
 * (paths relative to the package root, same directory as `discovery-config.json`).
 */
function loadMergedGoogleNewsQueryGroups(
  parsed: DiscoveryConfig,
  packageRootUrl: URL,
): { groups: Record<string, string[]>; localeTemplates: LocaleQueryTemplate[] } {
  const definitions = parsed.googleNewsQueryDefinitions;
  if (!definitions || typeof definitions !== 'object' || Array.isArray(definitions)) {
    return { groups: {}, localeTemplates: [] };
  }

  const def = definitions as GoogleNewsQueryDefinitions & {
    groupFiles?: unknown;
    groups?: unknown;
  };

  const merged: Record<string, string[]> = {};
  const localeTemplates: LocaleQueryTemplate[] = [];

  if (def.groups && typeof def.groups === 'object' && !Array.isArray(def.groups)) {
    const inline = expectStringRecordOfArrays(def.groups, 'googleNewsQueryDefinitions.groups');
    for (const [k, v] of Object.entries(inline)) {
      merged[k] = v;
    }
  }

  if (!Array.isArray(def.groupFiles)) {
    return { groups: merged, localeTemplates };
  }

  for (const rel of def.groupFiles) {
    if (typeof rel !== 'string' || !rel.trim()) {
      continue;
    }
    const pathPart = rel.trim().replace(/^\/+/, '');
    const fileUrl = new URL(pathPart, packageRootUrl);
    let raw: string;
    try {
      raw = readFileSync(fileUrl, 'utf-8');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to read discovery group file '${rel}': ${message}`);
    }
    const fileParsed = JSON.parse(raw) as { groups?: unknown; language?: unknown; queryTemplates?: unknown };
    if (!fileParsed.groups || typeof fileParsed.groups !== 'object' || Array.isArray(fileParsed.groups)) {
      throw new Error(`Discovery group file '${rel}' must contain a "groups" object`);
    }
    const chunk = expectStringRecordOfArrays(fileParsed.groups, `${pathPart}.groups`);
    for (const [k, v] of Object.entries(chunk)) {
      if (Object.prototype.hasOwnProperty.call(merged, k)) {
        throw new Error(
          `Duplicate Google News query group '${k}' while merging '${rel}' into discovery config`,
        );
      }
      merged[k] = v;
    }

    // Collect locale-pinned query templates declared in this file.
    if (Array.isArray(fileParsed.queryTemplates) && fileParsed.queryTemplates.length > 0) {
      const fileHl = typeof fileParsed.language === 'string' ? fileParsed.language.trim() : '';
      for (const entry of fileParsed.queryTemplates) {
        if (typeof entry === 'string') {
          if (entry.trim() && fileHl) {
            localeTemplates.push({ template: entry.trim(), hlPin: [fileHl] });
          }
        } else if (
          entry &&
          typeof entry === 'object' &&
          typeof (entry as { template?: unknown }).template === 'string'
        ) {
          const e = entry as { template: string; hlPin?: unknown };
          const pin = Array.isArray(e.hlPin)
            ? (e.hlPin as unknown[]).filter((x): x is string => typeof x === 'string')
            : typeof e.hlPin === 'string'
              ? [e.hlPin]
              : fileHl
                ? [fileHl]
                : [];
          if (e.template.trim() && pin.length > 0) {
            localeTemplates.push({ template: e.template.trim(), hlPin: pin });
          }
        }
      }
    }
  }

  return { groups: merged, localeTemplates };
}

function loadDiscoveryConfig(): {
  googleNewsGenericQueries: string[];
  googleNewsGenericQuerySpecs: GoogleNewsTemplateQuerySpec[];
  googleNewsQueryGroups: Record<string, string[]>;
  newsdataCountryCodes: string;
  newsdataLanguages: string;
  newsdataQueries: string[];
  regionTerms: string[];
  regionalHostSuffixes: string[];
  focusSignalTerms: string[];
} {
  const packageRootUrl = new URL('../', import.meta.url);
  const configUrl = new URL('../discovery-config.json', import.meta.url);
  const raw = readFileSync(configUrl, 'utf-8');
  const parsed = JSON.parse(raw) as DiscoveryConfig;
  const { groups: mergedQueryGroups, localeTemplates } = loadMergedGoogleNewsQueryGroups(parsed, packageRootUrl);
  const fallbackGoogleQueries = parsed.googleNewsGenericQueries
    ? expectStringArray(parsed.googleNewsGenericQueries, 'googleNewsGenericQueries')
    : undefined;

  const definitions = parsed.googleNewsQueryDefinitions;
  const syntheticDefinitions =
    definitions && typeof definitions === 'object' && !Array.isArray(definitions)
      ? { ...(definitions as Record<string, unknown>), groups: mergedQueryGroups }
      : { groups: mergedQueryGroups };

  const localeRows = loadGoogleNewsEuropeLocaleRows();

  // Inject locale queryTemplates from lang files as synthetic template+prefix pairs.
  if (localeTemplates.length > 0) {
    const syn = syntheticDefinitions as {
      templates?: unknown;
      templateLocaleHlPrefixes?: unknown;
    };
    const existingTemplates: string[] = Array.isArray(syn.templates) ? (syn.templates as string[]) : [];
    const rawPrefixes: unknown[] = Array.isArray(syn.templateLocaleHlPrefixes)
      ? (syn.templateLocaleHlPrefixes as unknown[])
      : [];
    // Align to templates length — pad with null (all locales) or truncate as needed.
    const existingPrefixes: unknown[] = rawPrefixes.length === existingTemplates.length
      ? rawPrefixes
      : rawPrefixes.length < existingTemplates.length
        ? [...rawPrefixes, ...Array.from({ length: existingTemplates.length - rawPrefixes.length }, () => null)]
        : rawPrefixes.slice(0, existingTemplates.length);
    syn.templates = [
      ...existingTemplates,
      ...localeTemplates.map((lt) => lt.template),
    ];
    syn.templateLocaleHlPrefixes = [
      ...existingPrefixes,
      ...localeTemplates.map((lt) => (lt.hlPin.length === 1 ? lt.hlPin[0] : lt.hlPin)),
    ];
  }

  const googleNewsGenericQuerySpecs = buildGoogleNewsTemplateQuerySpecs(
    syntheticDefinitions,
    fallbackGoogleQueries,
    localeRows,
  );

  return {
    googleNewsGenericQueries: uniqueOrdered(googleNewsGenericQuerySpecs.map((s) => s.query)),
    googleNewsGenericQuerySpecs,
    googleNewsQueryGroups: mergedQueryGroups,
    newsdataCountryCodes: expectString(parsed.newsdataCountryCodes, 'newsdataCountryCodes'),
    newsdataLanguages: expectString(parsed.newsdataLanguages, 'newsdataLanguages'),
    newsdataQueries: expectStringArray(parsed.newsdataQueries, 'newsdataQueries'),
    regionTerms: expectStringArray(parsed.regionTerms, 'regionTerms'),
    regionalHostSuffixes: parsed.regionalHostSuffixes
      ? expectStringArray(parsed.regionalHostSuffixes, 'regionalHostSuffixes')
      : [],
    focusSignalTerms: parsed.focusSignalTerms
      ? expectStringArray(parsed.focusSignalTerms, 'focusSignalTerms')
      : [],
  };
}

function uniqueOrdered(values: string[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    ordered.push(normalized);
  }
  return ordered;
}

function mergeCsv(base: string, extra: string): string {
  const baseValues = base
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  const extraValues = extra
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  return uniqueOrdered([...baseValues, ...extraValues]).join(',');
}

type DiscoveryFocusInput = {
  googleNewsGenericQueries?: unknown;
  newsdataCountryCodes?: unknown;
  newsdataLanguages?: unknown;
  newsdataQueries?: unknown;
  regionTerms?: unknown;
  priorityWatchlistHosts?: unknown;
  googleNewsWatchlistSites?: unknown;
  regionalHostSuffixes?: unknown;
  focusSignalTerms?: unknown;
};

function mergeGoogleNewsGenericQuerySpecs(
  base: GoogleNewsTemplateQuerySpec[],
  extraQueries: string[] | undefined,
): GoogleNewsTemplateQuerySpec[] {
  if (!extraQueries?.length) {
    return base;
  }
  const seen = new Set(
    base.map((s) => `${s.query}|||${pinKeyForSpecs(s.googleNewsLocaleIds)}`),
  );
  const out = [...base];
  for (const q of uniqueOrdered(
    extraQueries.map((x) => normalizeWhitespace(x)).filter(Boolean),
  )) {
    const k = `${q}|||ALL`;
    if (seen.has(k)) {
      continue;
    }
    seen.add(k);
    out.push({ query: q });
  }
  return out;
}

function loadDiscoveryFocusInput(): DiscoveryFocusInput | null {
  const inline = process.env.DISCOVERY_FOCUS_JSON?.trim();
  const filePath = process.env.DISCOVERY_FOCUS_FILE?.trim();

  if (inline) {
    return JSON.parse(inline) as DiscoveryFocusInput;
  }

  if (filePath) {
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as DiscoveryFocusInput;
  }

  return null;
}

const DISCOVERY_CONFIG = loadDiscoveryConfig();
const WATCHLIST_SITES = loadWatchlistSites();
const REGIONAL_PUBLISHER_SITES = loadRegionalPublisherSites();
const DISCOVERY_FOCUS_INPUT = loadDiscoveryFocusInput();

const MERGED_DISCOVERY_CONFIG = (() => {
  if (!DISCOVERY_FOCUS_INPUT) {
    return DISCOVERY_CONFIG;
  }

  const googleNewsGenericQuerySpecs = mergeGoogleNewsGenericQuerySpecs(
    DISCOVERY_CONFIG.googleNewsGenericQuerySpecs,
    DISCOVERY_FOCUS_INPUT.googleNewsGenericQueries
      ? expectStringArray(
          DISCOVERY_FOCUS_INPUT.googleNewsGenericQueries,
          'focus.googleNewsGenericQueries',
        )
      : undefined,
  );

  return {
    googleNewsGenericQuerySpecs,
    googleNewsGenericQueries: uniqueOrdered(googleNewsGenericQuerySpecs.map((s) => s.query)),
    googleNewsQueryGroups: DISCOVERY_CONFIG.googleNewsQueryGroups,
    newsdataCountryCodes: DISCOVERY_FOCUS_INPUT.newsdataCountryCodes
      ? mergeCsv(
          DISCOVERY_CONFIG.newsdataCountryCodes,
          expectString(DISCOVERY_FOCUS_INPUT.newsdataCountryCodes, 'focus.newsdataCountryCodes'),
        )
      : DISCOVERY_CONFIG.newsdataCountryCodes,
    newsdataLanguages: DISCOVERY_FOCUS_INPUT.newsdataLanguages
      ? mergeCsv(
          DISCOVERY_CONFIG.newsdataLanguages,
          expectString(DISCOVERY_FOCUS_INPUT.newsdataLanguages, 'focus.newsdataLanguages'),
        )
      : DISCOVERY_CONFIG.newsdataLanguages,
    newsdataQueries: uniqueOrdered([
      ...DISCOVERY_CONFIG.newsdataQueries,
      ...(DISCOVERY_FOCUS_INPUT.newsdataQueries
        ? expectStringArray(DISCOVERY_FOCUS_INPUT.newsdataQueries, 'focus.newsdataQueries')
        : []),
    ]),
    regionTerms: uniqueOrdered([
      ...DISCOVERY_CONFIG.regionTerms,
      ...(DISCOVERY_FOCUS_INPUT.regionTerms
        ? expectStringArray(DISCOVERY_FOCUS_INPUT.regionTerms, 'focus.regionTerms')
        : []),
    ]),
    regionalHostSuffixes: uniqueOrdered([
      ...DISCOVERY_CONFIG.regionalHostSuffixes,
      ...(DISCOVERY_FOCUS_INPUT.regionalHostSuffixes
        ? expectStringArray(DISCOVERY_FOCUS_INPUT.regionalHostSuffixes, 'focus.regionalHostSuffixes')
        : []),
    ]),
    focusSignalTerms: uniqueOrdered([
      ...DISCOVERY_CONFIG.focusSignalTerms,
      ...(DISCOVERY_FOCUS_INPUT.focusSignalTerms
        ? expectStringArray(DISCOVERY_FOCUS_INPUT.focusSignalTerms, 'focus.focusSignalTerms')
        : []),
    ]),
  };
})();

const MERGED_WATCHLIST_SITES = (() => {
  const configuredSites = uniqueOrdered([...WATCHLIST_SITES, ...REGIONAL_PUBLISHER_SITES]);

  if (!DISCOVERY_FOCUS_INPUT) {
    return configuredSites;
  }

  const extraPriority = DISCOVERY_FOCUS_INPUT.priorityWatchlistHosts
    ? expectStringArray(DISCOVERY_FOCUS_INPUT.priorityWatchlistHosts, 'focus.priorityWatchlistHosts')
    : [];
  const extraGoogle = DISCOVERY_FOCUS_INPUT.googleNewsWatchlistSites
    ? expectStringArray(DISCOVERY_FOCUS_INPUT.googleNewsWatchlistSites, 'focus.googleNewsWatchlistSites')
    : [];

  return uniqueOrdered([...configuredSites, ...extraPriority, ...extraGoogle]);
})();

export const REGIONAL_PUBLISHER_HOSTS = REGIONAL_PUBLISHER_SITES;
export const PRIORITY_WATCHLIST_HOSTS = MERGED_WATCHLIST_SITES;
export const GOOGLE_NEWS_WATCHLIST_SITES = MERGED_WATCHLIST_SITES;
/** Expanded generic Google News `q=` strings with optional per-row locale pins (see `templateLocaleHlPrefixes` in discovery-config). */
export const GOOGLE_NEWS_GENERIC_QUERY_SPECS = MERGED_DISCOVERY_CONFIG.googleNewsGenericQuerySpecs;
export const GOOGLE_NEWS_GENERIC_QUERIES = MERGED_DISCOVERY_CONFIG.googleNewsGenericQueries;
/** Named OR-groups from `discovery-config.json` (`groupFiles` + optional inline `groups`); not expanded templates. */
export const GOOGLE_NEWS_QUERY_GROUPS = MERGED_DISCOVERY_CONFIG.googleNewsQueryGroups;
export const NEWSDATA_COUNTRY_CODES = MERGED_DISCOVERY_CONFIG.newsdataCountryCodes;
export const NEWSDATA_LANGUAGES = MERGED_DISCOVERY_CONFIG.newsdataLanguages;
export const NEWSDATA_QUERIES = MERGED_DISCOVERY_CONFIG.newsdataQueries;
export const REGION_TERMS = MERGED_DISCOVERY_CONFIG.regionTerms;
export const UK_REGION_TERMS = uniqueOrdered([
  ...(MERGED_DISCOVERY_CONFIG.googleNewsQueryGroups.ukGeo ?? []),
  ...(MERGED_DISCOVERY_CONFIG.googleNewsQueryGroups.ukGeoTight ?? []),
]);
export const EUROPE_REGION_TERMS = uniqueOrdered([
  ...MERGED_DISCOVERY_CONFIG.regionTerms,
  ...(MERGED_DISCOVERY_CONFIG.googleNewsQueryGroups.europeGeo ?? []),
]);
export const REGIONAL_HOST_SUFFIXES = MERGED_DISCOVERY_CONFIG.regionalHostSuffixes;
export const FOCUS_SIGNAL_TERMS = MERGED_DISCOVERY_CONFIG.focusSignalTerms;
