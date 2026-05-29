/**
 * French-edition Google News RSS discovery only (no feeds, no pipeline).
 * Run with DISCOVERY_MAX_AGE_HOURS and GOOGLE_NEWS_LOCALE_IDS set, e.g.:
 *   $env:DISCOVERY_MAX_AGE_HOURS='168'; $env:GOOGLE_NEWS_LOCALE_IDS='FR-fr'; npx tsx scripts/verify-fr-google-news.ts
 */
import { discoverFromGoogleNews } from '../src/discoverStories.ts';

const franceinfoPattern = /franceinfo/i;
const mayorSectePattern = /maire|c[oô]tes-d.armor|secte/i;

async function main(): Promise<void> {
  const localeIds = process.env.GOOGLE_NEWS_LOCALE_IDS?.trim();
  console.log('[verify-fr-gn] GOOGLE_NEWS_LOCALE_IDS=', localeIds || '(unset — all locales)');
  console.log('[verify-fr-gn] DISCOVERY_MAX_AGE_HOURS=', process.env.DISCOVERY_MAX_AGE_HOURS ?? '(unset)');

  const stories = await discoverFromGoogleNews();
  const franceinfoStories = stories.filter(
    (s) => franceinfoPattern.test(s.url) || franceinfoPattern.test(s.title),
  );
  const mayorArmorSecte = franceinfoStories.filter(
    (s) => mayorSectePattern.test(s.title) || mayorSectePattern.test(s.url),
  );

  console.log('[verify-fr-gn] total Google News URLs:', stories.length);
  console.log('[verify-fr-gn] franceinfo matches:', franceinfoStories.length);
  console.log('[verify-fr-gn] franceinfo + maire/Côtes/secte heuristics:', mayorArmorSecte.length);

  for (const s of mayorArmorSecte.slice(0, 8)) {
    console.log('[verify-fr-gn] —', s.title);
    console.log('              ', s.url);
  }

  if (franceinfoStories.length > 0 && mayorArmorSecte.length === 0) {
    console.log('[verify-fr-gn] (other franceinfo items:)');
    for (const s of franceinfoStories.slice(0, 5)) {
      console.log('  ', s.title.slice(0, 140));
    }
  }

  const ok = franceinfoStories.length > 0;
  if (!ok) {
    console.error('[verify-fr-gn] FAIL: no franceinfo URLs in discovery set');
  } else {
    console.log('[verify-fr-gn] OK: at least one franceinfo story present');
  }

  process.exitCode = ok ? 0 : 1;
}

main().catch((error) => {
  console.error('[verify-fr-gn] error', error);
  process.exitCode = 1;
});
