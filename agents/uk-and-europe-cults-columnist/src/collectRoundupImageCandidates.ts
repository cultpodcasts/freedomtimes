import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadFinalizedArticlePlan, type FinalizedArticlePlan } from './articlePlan.ts';
import { existsSync } from 'node:fs';
import {
  customImagePublicUrl,
  loadCandidatesFile,
  localCustomImagePathFromUrl,
  mimeForFilename,
  saveCandidatesFile,
  selectionsPath,
} from './draftImageStore.ts';
import {
  extractImageCandidatesFromHtml,
  pickSuggestedCandidate,
  scoreForSource,
  type ImageCandidate,
  type UnitImageCandidates,
} from './roundupImageCandidates.ts';
import { assessImageFromBuffer, probeImageQuality } from './imageQuality.ts';
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

export type CollectImageProgressEvent = {
  level: 'info' | 'done' | 'error';
  message: string;
  unitIndex?: number;
  totalUnits?: number;
  percent?: number;
};

export type CollectRoundupImageOptions = {
  /** Skip HTTP dimension probes (faster; quality tiers stay unknown). */
  skipProbe?: boolean;
  onProgress?: (event: CollectImageProgressEvent) => void;
};

function applyQualityToCandidate(c: ImageCandidate): void {
  const width = c.quality?.longEdge ?? c.quality?.width ?? c.estimatedWidth;
  c.score = scoreForSource(c.source, width);
  if (c.quality?.tier === 'poor') c.score -= 25;
  else if (c.quality?.tier === 'marginal') c.score -= 8;
  else if (c.quality?.tier === 'excellent') c.score += 5;
}

async function probeCandidate(
  c: ImageCandidate,
  draftsDir?: string,
): Promise<void> {
  const localPath = draftsDir ? localCustomImagePathFromUrl(c.url, draftsDir) : null;
  if (localPath) {
    const buf = readFileSync(localPath);
    c.quality = assessImageFromBuffer(buf, mimeForFilename(localPath));
  } else {
    c.quality = await probeImageQuality(c.url, {
      source: c.source,
      estimatedWidth: c.estimatedWidth,
    });
  }
  applyQualityToCandidate(c);
}

async function probeUnitCandidates(
  candidates: ImageCandidate[],
  options: CollectRoundupImageOptions,
  draftsDir?: string,
  unitIndex?: number,
  totalUnits?: number,
): Promise<void> {
  if (options.skipProbe) return;
  let i = 0;
  for (const c of candidates) {
    i++;
    options.onProgress?.({
      level: 'info',
      message: `Probing image ${i}/${candidates.length}…`,
      unitIndex,
      totalUnits,
    });
    await probeCandidate(c, draftsDir);
    await new Promise((r) => setTimeout(r, 200));
  }
  candidates.sort((a, b) => b.score - a.score);
}

export async function probeExistingRoundupImageCandidates(
  candidates: RoundupImageCandidatesFile,
  options: Pick<CollectRoundupImageOptions, 'onProgress' | 'skipProbe'> = {},
  draftsDir?: string,
): Promise<RoundupImageCandidatesFile> {
  const totalUnits = candidates.units.length;
  options.onProgress?.({
    level: 'info',
    message: `Probing quality for ${totalUnits} units…`,
    totalUnits,
    percent: 0,
  });

  for (let unitIndex = 0; unitIndex < candidates.units.length; unitIndex++) {
    const unit = candidates.units[unitIndex]!;
    options.onProgress?.({
      level: 'info',
      message: `[${unitIndex + 1}/${totalUnits}] ${unit.unitLabel}`,
      unitIndex,
      totalUnits,
      percent: Math.round((unitIndex / totalUnits) * 100),
    });
    await probeUnitCandidates(unit.candidates, options, draftsDir, unitIndex, totalUnits);
    const suggested = pickSuggestedCandidate(unit.candidates);
    unit.suggestedUrl = suggested?.url;
  }

  candidates.collectedAt = new Date().toISOString();
  options.onProgress?.({
    level: 'done',
    message: `Quality probe complete — ${totalUnits} units`,
    totalUnits,
    percent: 100,
  });
  return candidates;
}

export async function addEditorImageCandidate(
  draftsDir: string,
  slug: string,
  unitId: string,
  input: { url?: string; imageBase64?: string },
  serverOrigin: string,
): Promise<{ candidate: ImageCandidate; selectedUrl: string }> {
  const file = loadCandidatesFile(draftsDir, slug);
  if (!file) throw new Error(`No candidates file for ${slug}. Collect first.`);

  const unit = file.units.find((u) => u.unitId === unitId);
  if (!unit) throw new Error(`Unknown unitId: ${unitId}`);

  let publicUrl: string;
  let quality;

  if (input.imageBase64) {
    const match = input.imageBase64.match(/^data:(image\/[a-z+]+);base64,(.+)$/i);
    if (!match) throw new Error('Expected data:image/…;base64,…');
    const mime = match[1]!;
    const buf = Buffer.from(match[2]!, 'base64');
    const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
    const dir = join(draftsDir, '_custom', slug);
    mkdirSync(dir, { recursive: true });
    const filename = `${unitId.replace(/[^a-z0-9]+/gi, '-').slice(0, 32)}-${Date.now()}.${ext}`;
    const diskPath = join(dir, filename);
    writeFileSync(diskPath, buf);
    publicUrl = customImagePublicUrl(serverOrigin, slug, filename);
    quality = assessImageFromBuffer(buf, mime);
  } else if (input.url?.trim()) {
    publicUrl = input.url.trim();
    if (!/^https?:\/\//i.test(publicUrl)) {
      throw new Error('URL must start with http:// or https://');
    }
    quality = await probeImageQuality(publicUrl, { source: 'custom' });
  } else {
    throw new Error('Provide url or imageBase64');
  }

  const candidate: ImageCandidate = {
    url: publicUrl,
    source: 'custom',
    storyUrl: input.url?.trim() || publicUrl,
    storyHost: 'editor',
    score: scoreForSource('custom', quality.longEdge ?? quality.width),
    quality,
    altHint: unit.unitLabel.replace(/\s+/g, ' ').trim().slice(0, 120),
  };
  applyQualityToCandidate(candidate);

  const existing = unit.candidates.findIndex((c) => c.url === candidate.url);
  if (existing >= 0) unit.candidates.splice(existing, 1);
  unit.candidates.unshift(candidate);
  unit.candidates = unit.candidates.slice(0, 12);
  unit.suggestedUrl = candidate.url;

  saveCandidatesFile(draftsDir, file);

  const selPath = selectionsPath(draftsDir, slug);
  if (existsSync(selPath)) {
    const sel = JSON.parse(readFileSync(selPath, 'utf8')) as RoundupImageSelectionsFile;
    let row = sel.units.find((u) => u.unitId === unitId);
    if (!row) {
      row = {
        unitId,
        selectedUrl: candidate.url,
        alt: candidate.altHint ?? unit.unitLabel,
        skip: false,
      };
      sel.units.push(row);
    } else {
      row.selectedUrl = candidate.url;
      row.skip = false;
    }
    sel.savedAt = new Date().toISOString();
    writeFileSync(selPath, JSON.stringify(sel, null, 2), 'utf8');
  }

  return { candidate, selectedUrl: candidate.url };
}

export async function collectRoundupImageCandidates(
  slug: string,
  plan?: FinalizedArticlePlan | null,
  options: CollectRoundupImageOptions = {},
  draftsDir?: string,
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
  const unitIds = article.unitIds.filter((id) => (byUnit.get(id) ?? []).length > 0);
  const totalUnits = unitIds.length;

  options.onProgress?.({
    level: 'info',
    message: `Collecting images for ${totalUnits} units…`,
    totalUnits,
    percent: 0,
  });

  for (let unitIndex = 0; unitIndex < unitIds.length; unitIndex++) {
    const unitId = unitIds[unitIndex]!;
    const stories = byUnit.get(unitId) ?? [];
    if (stories.length === 0) continue;

    const first = stories[0]!;
    const unitLabel = first.unitLabel ?? unitId;
    const allCandidates = [];

    options.onProgress?.({
      level: 'info',
      message: `[${unitIndex + 1}/${totalUnits}] ${unitLabel} — ${stories.length} stories`,
      unitIndex,
      totalUnits,
      percent: Math.round((unitIndex / totalUnits) * 100),
    });

    // Every story in the unit — no fixed outlet list; corpus changes weekly via article-plan.json.
    for (let si = 0; si < stories.length; si++) {
      const story = stories[si]!;
      options.onProgress?.({
        level: 'info',
        message: `  Fetching ${story.host || 'story'} (${si + 1}/${stories.length})…`,
        unitIndex,
        totalUnits,
      });
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
        options.onProgress?.({
          level: 'info',
          message: `  Skipped (fetch failed): ${story.host || story.url}`,
          unitIndex,
          totalUnits,
        });
      }
      await new Promise((r) => setTimeout(r, 300));
    }

    const deduped = new Map<string, (typeof allCandidates)[0]>();
    for (const c of allCandidates.sort((a, b) => b.score - a.score)) {
      if (!deduped.has(c.url)) deduped.set(c.url, c);
    }
    let candidates = [...deduped.values()].slice(0, 8);

    await probeUnitCandidates(candidates, options, draftsDir, unitIndex, totalUnits);
    candidates = [...candidates].sort((a, b) => b.score - a.score);

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

  options.onProgress?.({
    level: 'done',
    message: `Collect complete — ${units.length} units`,
    totalUnits: units.length,
    percent: 100,
  });

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
