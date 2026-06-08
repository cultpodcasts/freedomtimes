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

const slug = process.argv[2] ?? 'weekly-summary-8-june-2026';

const result = await collectRoundupImageCandidates(slug);
const outPath = join(draftsDir, `${slug}-image-candidates.json`);
writeFileSync(outPath, JSON.stringify(result, null, 2));

for (const u of result.units) {
  console.log(
    u.unitLabel.slice(0, 45).padEnd(46),
    u.candidates.length,
    'candidates',
    u.suggestedUrl ? `→ ${u.candidates[0]?.source}` : '(none)',
  );
}
console.log('wrote', outPath);
