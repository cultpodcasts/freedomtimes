/// <reference types="node" />
/**
 * Migrate all lang files to the LocaleLangFile interface.
 * Maps locale-prefixed group keys to well-known interface keys, promotes them
 * to top-level fields, and removes queryTemplates (runtime generates from strategy).
 *
 * Run once:
 *   npx tsx scripts/migrate-lang-files-to-interface.mts
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = resolve(new URL('../', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
const LANG_DIR = join(ROOT, 'data', 'discovery', 'lang');

/** Top-level keys from LocaleLangFile that should NOT be touched. */
const INTERFACE_KEYS = new Set([
  'language', 'cultTerms', 'religiousGroupTerms', 'harmSignals',
  'journalismSignals', 'justiceSignals', 'victimSignals', 'mediaSignals',
  'europeCountryOr', 'focusGeo', 'queryStrategy',
  'strictCultTermExtensions', 'genericCultTerms', 'coerciveHarmTerms',
  'groupStopwords', 'groups', '_docs',
]);

/** Suffix → interface key mapping (longest suffix wins if multiple match). */
const SUFFIX_MAP: [suffix: string, key: string][] = [
  ['ReligiousGroupTerms', 'religiousGroupTerms'],
  ['HarmSignals',         'harmSignals'],
  ['JournalismSignals',   'journalismSignals'],
  ['JusticeSignals',      'justiceSignals'],
  ['VictimSignals',       'victimSignals'],
  ['MediaSignals',        'mediaSignals'],
  ['EuropeCountryOr',     'europeCountryOr'],
  ['Terms',               'cultTerms'],   // xxTerms, xxBeTerms, grTerms etc.
  ['WatchlistTerms',      'cultTerms'],   // enWatchlistTerms
  ['Geo',                 'focusGeo'],    // frFranceBelgGeo, ukGeo, elGreeceGeo etc.
];

function resolveInterfaceKey(groupKey: string): string | null {
  // Sort by suffix length descending so longer suffixes take priority
  const sorted = [...SUFFIX_MAP].sort((a, b) => b[0].length - a[0].length);
  for (const [suffix, key] of sorted) {
    if (groupKey.endsWith(suffix)) return key;
  }
  return null;
}

const files = readdirSync(LANG_DIR).filter((f) => f.endsWith('.json')).sort();

for (const file of files) {
  const hl = file.replace('.json', '');
  const path = join(LANG_DIR, file);
  const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;

  // Already migrated (has interface keys) — skip.
  if (raw['cultTerms'] || raw['europeCountryOr']) {
    console.log(`  ${hl}: already migrated — skipping`);
    continue;
  }

  const groups = raw['groups'] as Record<string, unknown> | undefined;
  if (!groups || Object.keys(groups).length === 0) {
    console.log(`  ${hl}: no groups — skipping`);
    continue;
  }

  // Collect interface key → merged terms (some locales merge multiple groups into one key)
  const interfaceFields: Record<string, string[]> = {};
  const remainingGroups: Record<string, unknown> = {};

  for (const [groupKey, values] of Object.entries(groups)) {
    if (!Array.isArray(values)) {
      remainingGroups[groupKey] = values;
      continue;
    }
    const interfaceKey = resolveInterfaceKey(groupKey);
    if (!interfaceKey) {
      remainingGroups[groupKey] = values;
      continue;
    }
    // Merge (e.g. en has enWatchlistTerms AND enHarmSignals both mapping to cultTerms-ish,
    // but enWatchlistTerms → cultTerms and enHarmSignals → harmSignals so no collision).
    if (!interfaceFields[interfaceKey]) {
      interfaceFields[interfaceKey] = [];
    }
    for (const v of values as string[]) {
      if (!interfaceFields[interfaceKey]!.includes(v)) {
        interfaceFields[interfaceKey]!.push(v);
      }
    }
    // Keep the original named group for watchlist/template backward compat.
    remainingGroups[groupKey] = values;
  }

  if (Object.keys(interfaceFields).length === 0) {
    console.log(`  ${hl}: no mappable groups — skipping`);
    continue;
  }

  // Build the new file: interface keys first, then other top-level fields, groups last.
  const ordered: Record<string, unknown> = {};
  ordered['language'] = raw['language'];
  for (const key of Object.keys(interfaceFields).sort()) {
    ordered[key] = interfaceFields[key];
  }
  // Carry over any existing top-level non-interface, non-groups keys
  for (const [k, v] of Object.entries(raw)) {
    if (!INTERFACE_KEYS.has(k) && k !== 'queryTemplates') {
      ordered[k] = v;
    }
  }
  // Preserve these top-level data fields
  for (const k of ['strictCultTermExtensions', 'genericCultTerms', 'coerciveHarmTerms', 'groupStopwords']) {
    if (raw[k]) ordered[k] = raw[k];
  }
  // groups last (for watchlist compat), without the migrated keys
  if (Object.keys(remainingGroups).length > 0) {
    ordered['groups'] = remainingGroups;
  }

  writeFileSync(path, JSON.stringify(ordered, null, 2) + '\n', 'utf-8');
  console.log(`  ${hl}: migrated ${Object.keys(interfaceFields).join(', ')}`);
}

console.log('\nDone.');
