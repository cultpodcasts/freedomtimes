/// <reference types="node" />
/**
 * One-shot migration script: moves locale-pinned templates from
 * discovery-config.json into each lang file's queryTemplates array,
 * then strips them (and their templateLocaleHlPrefixes entries) from
 * discovery-config.json.
 *
 * Run once:
 *   npx tsx scripts/migrate-templates-to-lang-files.mts
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = resolve(new URL('../', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
const CONFIG_PATH = join(ROOT, 'discovery-config.json');
const LANG_DIR = join(ROOT, 'data', 'discovery', 'lang');

const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as {
  googleNewsQueryDefinitions: {
    groupFiles?: string[];
    templates: string[];
    templateLocaleHlPrefixes: (string | string[] | null)[];
    rawQueries?: string[];
  };
  [key: string]: unknown;
};

const { templates, templateLocaleHlPrefixes } = config.googleNewsQueryDefinitions;

if (templates.length !== templateLocaleHlPrefixes.length) {
  throw new Error(`templates (${templates.length}) vs prefixes (${templateLocaleHlPrefixes.length}) mismatch`);
}

// Normalise a prefix entry to string[] | null
function normPin(p: string | string[] | null): string[] | null {
  if (p === null) return null;
  if (Array.isArray(p)) return p;
  return [p];
}

// Collect templates per single-locale hl pin (skip multi-locale and null pins — leave those in config)
const perLocale = new Map<string, string[]>();
const keepInConfig: { template: string; pin: string | string[] | null }[] = [];

for (let i = 0; i < templates.length; i++) {
  const template = templates[i]!;
  const pin = normPin(templateLocaleHlPrefixes[i]!);

  if (pin !== null && pin.length === 1) {
    const hl = pin[0]!;
    if (!perLocale.has(hl)) perLocale.set(hl, []);
    perLocale.get(hl)!.push(template);
  } else {
    keepInConfig.push({ template, pin: templateLocaleHlPrefixes[i]! });
  }
}

console.log(`Templates to migrate: ${templates.length - keepInConfig.length}`);
console.log(`Templates staying in config: ${keepInConfig.length}`);
console.log(`Locales receiving templates: ${[...perLocale.keys()].sort().join(', ')}`);

// For each lang file that already has some templates migrated (de), skip adding duplicates
const langFiles = readdirSync(LANG_DIR).filter((f) => f.endsWith('.json'));

for (const file of langFiles) {
  const hl = file.replace('.json', '');
  const newTemplates = perLocale.get(hl);
  if (!newTemplates || newTemplates.length === 0) continue;

  const langPath = join(LANG_DIR, file);
  const langData = JSON.parse(readFileSync(langPath, 'utf-8')) as {
    language?: string;
    queryTemplates?: string[];
    [key: string]: unknown;
  };

  const existing: string[] = langData.queryTemplates ?? [];
  const existingSet = new Set(existing);
  const toAdd = newTemplates.filter((t) => !existingSet.has(t));

  if (toAdd.length === 0) {
    console.log(`  ${hl}: all ${newTemplates.length} templates already present — skipping`);
    continue;
  }

  langData.queryTemplates = [...existing, ...toAdd];

  // Ensure queryTemplates appears near the top (after 'language' if present)
  const ordered: Record<string, unknown> = {};
  if (langData.language) ordered.language = langData.language;
  ordered.queryTemplates = langData.queryTemplates;
  for (const [k, v] of Object.entries(langData)) {
    if (k !== 'language' && k !== 'queryTemplates') ordered[k] = v;
  }

  writeFileSync(langPath, JSON.stringify(ordered, null, 2) + '\n', 'utf-8');
  console.log(`  ${hl}: added ${toAdd.length} templates (${existing.length} already existed)`);
}

// Rewrite discovery-config.json with only the kept templates
config.googleNewsQueryDefinitions.templates = keepInConfig.map((e) => e.template);
config.googleNewsQueryDefinitions.templateLocaleHlPrefixes = keepInConfig.map((e) => e.pin);

writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf-8');
console.log(`\ndiscovery-config.json updated: ${keepInConfig.length} templates remain`);
