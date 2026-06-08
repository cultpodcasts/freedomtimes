import { loadFinalizedArticlePlan, type FinalizedArticlePlan } from './articlePlan.ts';
import {
  extractImageCandidatesFromHtml,
  pickSuggestedCandidate,
  type UnitImageCandidates,
} from './roundupImageCandidates.ts';
import { isWatchlistHost, loadWatchlistHosts } from './watchlistHosts.ts';

export type RoundupImageCandidatesFile = {
  slug: string;
  collectedAt: string;
  units: UnitImageCandidates[];
};

export type RoundupImageSelectionsFile = {
  slug: string;
  savedAt: string;
  units: Array<{
    unitId: string;
    selectedUrl: string | null;
    alt: string;
    skip: boolean;
    /** Editor override: show this unit under ## Beyond Europe (default false until set in /draft-images). */
    beyondEurope?: boolean;
  }>;
};

async function fetchHtml(url: string): Promise<string> {
  const r = await fetch(url, {
    headers: { 'User-Agent': 'FreedomTimesBot/1.0 (+https://freedomtimes.news)' },
    redirect: 'follow',
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

export async function collectRoundupImageCandidates(
  slug: string,
  plan?: FinalizedArticlePlan | null,
): Promise<RoundupImageCandidatesFile> {
  const finalized = plan ?? loadFinalizedArticlePlan();
  if (!finalized?.articles?.[0]) {
    throw new Error('No finalized article plan');
  }
  const article = finalized.articles[0];
  const byUnit = new Map<string, typeof article.stories>();
  for (const s of article.stories) {
    byUnit.set(s.unitId, [...(byUnit.get(s.unitId) ?? []), s]);
  }

  const watchlist = loadWatchlistHosts();
  const units: UnitImageCandidates[] = [];

  for (const unitId of article.unitIds) {
    const stories = byUnit.get(unitId) ?? [];
    if (stories.length === 0) continue;

    const first = stories[0]!;
    const unitLabel = first.unitLabel ?? unitId;
    const allCandidates = [];

    // Every story in the unit — no fixed outlet list; corpus changes weekly via article-plan.json.
    for (const story of stories) {
      try {
        const html = await fetchHtml(story.url);
        const batch = extractImageCandidatesFromHtml(html, story.url, story.host ?? '');
        for (const c of batch) {
          if (isWatchlistHost(c.storyHost, watchlist)) {
            c.score += 5;
          }
        }
        allCandidates.push(...batch);
      } catch {
        // skip failed story fetch
      }
      await new Promise((r) => setTimeout(r, 300));
    }

    const deduped = new Map<string, (typeof allCandidates)[0]>();
    for (const c of allCandidates.sort((a, b) => b.score - a.score)) {
      if (!deduped.has(c.url)) deduped.set(c.url, c);
    }
    const candidates = [...deduped.values()].slice(0, 8);
    const suggested = pickSuggestedCandidate(candidates);

    units.push({
      unitId,
      unitLabel,
      beyondEurope: false,
      stories: stories.map((s) => ({ url: s.url, host: s.host ?? '', title: s.title })),
      candidates,
      suggestedUrl: suggested?.url,
      suggestedAlt: suggested?.altHint ?? unitLabel.replace(/\s+/g, ' ').trim().slice(0, 120),
    });
  }

  return { slug, collectedAt: new Date().toISOString(), units };
}

export function mergeCandidatesWithSelections(
  candidates: RoundupImageCandidatesFile,
  selections: RoundupImageSelectionsFile | null,
): Array<
  UnitImageCandidates & { selectedUrl?: string | null; skip?: boolean; alt?: string; beyondEurope?: boolean }
> {
  const selByUnit = new Map(selections?.units.map((u) => [u.unitId, u]) ?? []);
  return candidates.units.map((unit) => {
    const sel = selByUnit.get(unit.unitId);
    return {
      ...unit,
      selectedUrl: sel?.selectedUrl ?? unit.suggestedUrl,
      skip: sel?.skip ?? false,
      alt: sel?.alt ?? unit.suggestedAlt,
      beyondEurope: sel?.beyondEurope ?? unit.beyondEurope ?? false,
    };
  });
}
