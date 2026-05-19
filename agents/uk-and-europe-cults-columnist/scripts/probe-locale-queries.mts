/// <reference types="node" />
/**
 * Probe Google News RSS for a specific locale without running the full pipeline.
 *
 * Usage:
 *   npx tsx scripts/probe-locale-queries.mts --locale=de
 *   npx tsx scripts/probe-locale-queries.mts --locale=de --watchlist-only
 *   npx tsx scripts/probe-locale-queries.mts --locale=de --generic-only
 */

const args = process.argv.slice(2);
const localeArg = args.find((a: string) => a.startsWith('--locale='))?.split('=')[1]?.trim();
const watchlistOnly = args.includes('--watchlist-only');
const genericOnly = args.includes('--generic-only');

if (!localeArg) {
  console.error('Usage: npx tsx scripts/probe-locale-queries.mts --locale=<code>  (e.g. de, fr, it)');
  process.exit(1);
}

// Pin Google News RSS fetches to only the requested locale's editions.
// loadEuropeGoogleNewsLocales() in discoverStories.ts reads this env var.
// The locale id format is e.g. DE-de, FR-fr — we match by the hl subtag.
const { default: localesRaw } = await import('../data/google-news-europe-locales.json', {
  assert: { type: 'json' },
});
const matchedLocaleIds: string[] = (localesRaw as { locales: Array<{ id: string; hl: string }> }).locales
  .filter((l) => l.hl.toLowerCase().startsWith(localeArg.toLowerCase()))
  .map((l) => l.id);

if (matchedLocaleIds.length === 0) {
  console.error(`No Google News locales found for hl prefix '${localeArg}'`);
  process.exit(1);
}

process.env.GOOGLE_NEWS_LOCALE_IDS = matchedLocaleIds.join(',');

console.log(`\n[probe] locale=${localeArg}  editions=${matchedLocaleIds.join(', ')}`);
if (watchlistOnly) console.log('[probe] mode: watchlist queries only');
else if (genericOnly) console.log('[probe] mode: generic queries only (no watchlist)');
else console.log('[probe] mode: all queries');
console.log('');

const {
  buildGenericQuerySpecsForRun,
  buildWatchlistQueries,
  discoverFromGoogleNewsQueries,
  resetGoogleNewsDiscoveryReporting,
} = await import('../src/discoverStories.js');

resetGoogleNewsDiscoveryReporting();

const allGenericSpecs = genericOnly || (!watchlistOnly) ? buildGenericQuerySpecsForRun() : [];
// Only run specs that are pinned to the target locale's editions — skip unpinned cross-locale specs
// so the probe only fires the locale-specific templates (much faster).
const genericSpecs = allGenericSpecs.filter(
  (s) => s.googleNewsLocaleIds?.some((id: string) => matchedLocaleIds.includes(id)),
);
const watchlistSpecs = watchlistOnly || (!genericOnly)
  ? buildWatchlistQueries().map((q: string) => ({ query: q }))
  : [];

const queriesToRun = [...watchlistSpecs, ...genericSpecs];
console.log(`[probe] running ${queriesToRun.length} queries (${watchlistSpecs.length} watchlist + ${genericSpecs.length} generic pinned to locale)\n`);

const stories = await discoverFromGoogleNewsQueries(queriesToRun, 'probe');
const filtered = stories;

if (filtered.length === 0) {
  console.log('[probe] No stories discovered for this locale.');
} else {
  console.log(`[probe] ${filtered.length} stories discovered:\n`);
  for (const story of filtered) {
    console.log(`  ${story.publishedAt?.slice(0, 10) ?? 'unknown'} | ${story.title}`);
    console.log(`           ${story.url}`);
  }
}
