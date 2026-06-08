/**
 * Insert approved images into draft markdown after section headings.
 *
 * Usage: npx tsx scripts/inject-roundup-images.mts [slug]
 *
 * Reads:
 *   reports/drafts/{slug}.md
 *   reports/drafts/{slug}-images-uploaded.json
 *   reports/drafts/{slug}-image-candidates.json (unit order + beyondEurope)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  RoundupImageCandidatesFile,
  RoundupImageSelectionsFile,
} from '../src/collectRoundupImageCandidates.ts';

const agentRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const draftsDir = join(agentRoot, 'reports', 'drafts');
const slug = process.argv[2] ?? 'weekly-summary-8-june-2026';

const mdPath = join(draftsDir, `${slug}.md`);
const uploads = JSON.parse(
  readFileSync(join(draftsDir, `${slug}-images-uploaded.json`), 'utf8'),
) as Array<{ unitId: string; alt: string; fileUrl: string }>;
const candidates = JSON.parse(
  readFileSync(join(draftsDir, `${slug}-image-candidates.json`), 'utf8'),
) as RoundupImageCandidatesFile;

let selections: RoundupImageSelectionsFile | null = null;
const selectionsPath = join(draftsDir, `${slug}-image-selections.json`);
try {
  selections = JSON.parse(readFileSync(selectionsPath, 'utf8')) as RoundupImageSelectionsFile;
} catch {
  // optional — beyondEurope defaults false
}

const uploadByUnit = new Map(uploads.map((u) => [u.unitId, u]));
const unitOrder = candidates.units.map((u) => u.unitId);
const selByUnit = new Map(selections?.units.map((u) => [u.unitId, u]) ?? []);
const beyondSet = new Set(
  candidates.units
    .filter((u) => selByUnit.get(u.unitId)?.beyondEurope ?? u.beyondEurope ?? false)
    .map((u) => u.unitId),
);
const beyondUnitIds = unitOrder.filter((id) => beyondSet.has(id));

let lines = readFileSync(mdPath, 'utf8').split('\n');

// Strip intro: keep title, drop paragraphs before first ##
const title = lines[0] ?? '# Draft';
const firstH2 = lines.findIndex((l) => l.startsWith('## '));
if (firstH2 > 0) {
  lines = [title, '', ...lines.slice(firstH2)];
}

// Remove existing image lines after headings
lines = lines.filter((l, i, arr) => {
  if (!l.startsWith('![')) return true;
  const prev = arr[i - 1]?.trim() ?? '';
  const prev2 = arr[i - 2]?.trim() ?? '';
  return !(prev === '' && (prev2.startsWith('## ') || prev2.startsWith('### ')));
});

// Map section headings to unitIds in plan order
const sectionHeadings: Array<{ lineIndex: number; level: number; unitId: string }> = [];
let unitIdx = 0;
let beyondIdx = 0;
let inBeyond = false;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i] ?? '';
  if (line === '## Beyond Europe') {
    inBeyond = true;
    continue;
  }
  if (line.startsWith('## Source citations')) break;

  const h2 = line.match(/^## (.+)$/);
  const h3 = line.match(/^### (.+)$/);
  if (!h2 && !h3) continue;
  if (h2 && line === '## Beyond Europe') continue;

  let unitId: string | undefined;
  if (inBeyond && h3) {
    unitId = beyondUnitIds[beyondIdx];
    beyondIdx++;
  } else if (!inBeyond && h2) {
    while (unitIdx < unitOrder.length && beyondSet.has(unitOrder[unitIdx]!)) unitIdx++;
    unitId = unitOrder[unitIdx];
    unitIdx++;
  }
  if (unitId) {
    sectionHeadings.push({ lineIndex: i, level: h3 ? 3 : 2, unitId });
  }
}

// Insert images (reverse order to preserve indices)
const insertions: Array<{ after: number; markdown: string }> = [];
for (const { lineIndex, unitId } of sectionHeadings) {
  const up = uploadByUnit.get(unitId);
  if (!up) continue;
  const alt = up.alt.replace(/[\[\]]/g, '');
  insertions.push({ after: lineIndex, markdown: `\n![${alt}](${up.fileUrl})` });
}

insertions.sort((a, b) => b.after - a.after);
for (const { after, markdown } of insertions) {
  lines.splice(after + 1, 0, markdown);
}

writeFileSync(mdPath, lines.join('\n'));
console.log('injected', insertions.length, 'images into', mdPath);
