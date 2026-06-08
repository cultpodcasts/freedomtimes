/**
 * Upload editor-approved images to staging EmDash.
 * Requires: reports/drafts/{slug}-image-selections.json (from /draft-images UI)
 *
 * Usage: npx tsx scripts/upload-roundup-images.mts [slug] [--use-suggestions]
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RoundupImageCandidatesFile, RoundupImageSelectionsFile } from '../src/collectRoundupImageCandidates.ts';
import { localCustomImagePathFromUrl } from '../src/draftImageStore.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const agentRoot = join(__dirname, '..');
const repoRoot = join(agentRoot, '..', '..');
const webDir = join(repoRoot, 'web');
const draftsDir = join(agentRoot, 'reports', 'drafts');
const tmpDir = join(draftsDir, '_images');
mkdirSync(tmpDir, { recursive: true });

const slug = process.argv[2] ?? 'weekly-summary-8-june-2026';
const useSuggestions = process.argv.includes('--use-suggestions');
const forceReupload = process.argv.includes('--force');

function sanitizeAlt(raw: string): string {
  return raw
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/[|&<>%^]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

const token = process.env.EMDASH_STAGING_PAT;
if (!token) throw new Error('Set EMDASH_STAGING_PAT');

const candidatesPath = join(draftsDir, `${slug}-image-candidates.json`);
const selectionsPath = join(draftsDir, `${slug}-image-selections.json`);

if (!exists(candidatesPath)) {
  throw new Error(`Missing ${candidatesPath}. Run collect-roundup-image-candidates first.`);
}

function exists(p: string): boolean {
  try {
    readFileSync(p);
    return true;
  } catch {
    return false;
  }
}

const candidates = JSON.parse(readFileSync(candidatesPath, 'utf8')) as RoundupImageCandidatesFile;
let selections: RoundupImageSelectionsFile | null = null;
if (exists(selectionsPath)) {
  selections = JSON.parse(readFileSync(selectionsPath, 'utf8')) as RoundupImageSelectionsFile;
} else if (!useSuggestions) {
  throw new Error(
    `Missing ${selectionsPath}. Approve images at http://localhost:3000/draft-images?slug=${slug} or pass --use-suggestions`,
  );
}

const selByUnit = new Map(selections?.units.map((u) => [u.unitId, u]) ?? []);
const uploadsPath = join(draftsDir, `${slug}-images-uploaded.json`);
let existingUploads: Array<{ unitId: string }> = [];
try {
  existingUploads = JSON.parse(readFileSync(uploadsPath, 'utf8'));
} catch {
  // fresh run
}
const existingByUnit = new Map(existingUploads.map((u) => [u.unitId, u]));
const uploads: Array<{
  unitId: string;
  label: string;
  alt: string;
  sourceUrl: string;
  mediaId: string;
  fileUrl: string;
  quality?: { tier: string; recommendation: string; label: string; warnings: string[] };
}> = [];

for (const unit of candidates.units) {
  const sel = selByUnit.get(unit.unitId);
  const skip = sel?.skip ?? false;
  if (skip) continue;

  if (!forceReupload && existingByUnit.has(unit.unitId)) {
    uploads.push(existingByUnit.get(unit.unitId) as (typeof uploads)[0]);
    continue;
  }

  const url = sel?.selectedUrl ?? (useSuggestions ? unit.suggestedUrl : null);
  if (!url) {
    console.warn('no selection', unit.unitLabel);
    continue;
  }

  const candidate = unit.candidates.find((c) => c.url === url);
  const quality = candidate?.quality;
  if (quality?.recommendation === 'unsuitable' || quality?.recommendation === 'low-res') {
    console.warn('quality', quality.tier, quality.recommendation, unit.unitLabel.slice(0, 50), quality.label);
  }
  if (quality?.recommendation === 'reprocess') {
    console.warn('reprocess suggested', unit.unitLabel.slice(0, 50), quality.label, quality.warnings.join('; '));
  }

  const alt = sanitizeAlt(sel?.alt ?? unit.suggestedAlt ?? unit.unitLabel) || unit.unitLabel.slice(0, 120);
  const ext = url.includes('.png') ? 'png' : url.includes('.webp') ? 'webp' : 'jpg';
  const localPath = join(tmpDir, `${unit.unitId.replace(/[^a-z0-9]+/gi, '-').slice(0, 40)}.${ext}`);

  const customPath = localCustomImagePathFromUrl(url, draftsDir);
  if (customPath) {
    writeFileSync(localPath, readFileSync(customPath));
  } else {
    const imgRes = await fetch(url, {
      headers: { 'User-Agent': 'FreedomTimesBot/1.0' },
      redirect: 'follow',
    });
    if (!imgRes.ok) {
      console.warn('download failed', unit.unitLabel, imgRes.status);
      continue;
    }
    writeFileSync(localPath, Buffer.from(await imgRes.arrayBuffer()));
  }

  const up = spawnSync(
    'npx',
    ['emdash', 'media', 'upload', localPath, '--alt', alt, '-u', 'https://staging.freedomtimes.news', '-t', token, '--json'],
    { cwd: webDir, encoding: 'utf8', shell: false },
  );
  if (up.status !== 0) {
    console.warn('upload failed', unit.unitLabel, up.stderr || up.stdout);
    continue;
  }
  const media = JSON.parse(up.stdout) as { id: string; storageKey?: string };
  const storageKey = media.storageKey?.trim();
  if (!storageKey) {
    console.warn('upload missing storageKey', unit.unitLabel, media.id);
    continue;
  }
  uploads.push({
    unitId: unit.unitId,
    label: unit.unitLabel,
    alt,
    sourceUrl: url,
    mediaId: media.id,
    storageKey,
    fileUrl: `https://staging.freedomtimes.news/_emdash/api/media/file/${storageKey}`,
    quality: quality
      ? {
          tier: quality.tier,
          recommendation: quality.recommendation,
          label: quality.label,
          warnings: quality.warnings,
        }
      : undefined,
  });
  console.log('uploaded', unit.unitLabel.slice(0, 50), media.id);
  await new Promise((r) => setTimeout(r, 400));
}

writeFileSync(uploadsPath, JSON.stringify(uploads, null, 2));
console.log('wrote', uploads.length, 'uploads');
