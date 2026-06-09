/**
 * Collect image candidates per article-plan unit.
 * Usage: npx tsx scripts/collect-roundup-image-candidates.mts [slug]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectRoundupImageCandidates } from '../src/collectRoundupImageCandidates.ts';

const agentRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const draftsDir = join(agentRoot, 'reports', 'drafts');
mkdirSync(draftsDir, { recursive: true });

const args = process.argv.slice(2);
const skipProbe = args.includes('--skip-probe');
const slug = args.find((a) => !a.startsWith('--')) ?? 'weekly-summary-7-june-2026';

const result = await collectRoundupImageCandidates(slug, undefined, { skipProbe }, draftsDir);
const outPath = join(draftsDir, `${slug}-image-candidates.json`);
writeFileSync(outPath, JSON.stringify(result, null, 2));

for (const u of result.units) {
  const top = u.candidates[0];
  const q = top?.quality;
  const qualityHint = q ? `${q.tier} · ${q.recommendation}` : '(not probed)';
  console.log(
    u.unitLabel.slice(0, 40).padEnd(41),
    u.candidates.length,
    'cands',
    top ? `→ ${top.source}` : '(none)',
    qualityHint,
    q?.label ?? '',
  );
}
console.log('wrote', outPath);
