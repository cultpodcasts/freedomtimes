/**
 * Probe image quality on an existing candidates file (no HTML re-fetch).
 * Usage: npx tsx scripts/probe-roundup-image-candidates.mts [slug]
 */
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCandidatesFile, saveCandidatesFile } from '../src/draftImageStore.ts';
import { probeExistingRoundupImageCandidates } from '../src/collectRoundupImageCandidates.ts';

const agentRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const draftsDir = join(agentRoot, 'reports', 'drafts');
const slug = process.argv[2] ?? 'weekly-summary-7-june-2026';

const existing = loadCandidatesFile(draftsDir, slug);
if (!existing) {
  throw new Error(`Missing ${slug}-image-candidates.json — collect first`);
}

const result = await probeExistingRoundupImageCandidates(
  existing,
  {
    onProgress: (e) => {
      const pct = e.percent != null ? ` (${e.percent}%)` : '';
      console.log(e.level === 'error' ? '!' : '-', e.message + pct);
    },
  },
  draftsDir,
);

saveCandidatesFile(draftsDir, result);
console.log('updated', join(draftsDir, `${slug}-image-candidates.json`));
