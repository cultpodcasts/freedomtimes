/**
 * Runs discovery only and writes reports/last-run-candidates.json (full URL list).
 * Same env as the agent: AGENT_ENV=staging, DISCOVERY_MAX_AGE_HOURS=168, etc.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.ts';
import { discoverCandidateStories } from '../src/discoverStories.ts';

const root = dirname(fileURLToPath(import.meta.url));
const outDir = join(root, '..', 'reports');

async function main(): Promise<void> {
  const config = loadConfig();
  console.log('[export-candidates] discovering…');
  const discovered = await discoverCandidateStories(config.allowedSourceHosts);
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, 'last-run-candidates.json');
  writeFileSync(
    outPath,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        count: discovered.length,
        urls: discovered.map((d) => d.url),
      },
      null,
      2,
    )}\n`,
    'utf-8',
  );
  console.log('[export-candidates] wrote', { path: outPath, count: discovered.length });
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
