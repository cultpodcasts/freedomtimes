/**
 * Replays pipeline evaluation for URLs from last-run.log (candidateScoreDetails)
 * and writes an HTML review for selected rejection reasons. Uses HTTP cache when warm.
 *
 * Usage:
 *   npx tsx scripts/replay-rejection-review-from-log.ts
 *   npx tsx scripts/replay-rejection-review-from-log.ts --candidates=reports/last-run-candidates.json
 *   npx tsx scripts/replay-rejection-review-from-log.ts --log=last-run.log --concurrency=10
 *
 * Prefer `reports/last-run-candidates.json` (written by the agent) — `last-run.log` truncates long lines on some consoles.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.ts';
import { ARCHIVE_FALLBACK_HOSTS } from '../src/http-cache/config.ts';
import { runPipeline } from '../src/pipeline.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const TARGET_REASONS = new Set([
  'Source failed reliability checks',
  'Story does not meet UK/EU cult-topic relevance threshold',
  'Story does not have a configured regional source or configured regional geographic signal',
]);

function getArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 1 ? n : fallback;
}

/**
 * Pull candidate URLs from the huge `candidateScoreDetails` log field without parsing the full JSON
 * (Node's log line can be megabytes; bracket matching is brittle if the payload is truncated).
 */
function extractCandidateUrlsFromLog(logText: string): string[] {
  const marker = "candidateScoreDetails:";
  const idx = logText.indexOf(marker);
  if (idx < 0) {
    throw new Error(`Could not find ${marker} in log (need a full agent run with discovered candidates).`);
  }
  const tail = logText.slice(idx);
  /** Candidate URLs in this log are always https and do not contain raw double quotes. */
  const urlRe = /"url"\s*:\s*"(https:\/\/[^"]+)"/g;
  const urls: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = urlRe.exec(tail)) !== null) {
    urls.push(m[1]!);
  }
  if (urls.length === 0) {
    throw new Error('No "url" fields found after candidateScoreDetails (log format changed?)');
  }
  return urls;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

type MatchRow = {
  candidateUrl: string;
  reason: string;
  effectiveUrl: string;
  title?: string;
  textPreview?: string;
  reliabilityScore: number;
  reliabilityReasons: string[];
  relevance: {
    accepted: boolean;
    region: string;
    confidence: number;
    reasons: string[];
  };
};

function renderHtml(rowsByReason: Map<string, MatchRow[]>, generatedAt: string): string {
  const sections: string[] = [];
  for (const reason of TARGET_REASONS) {
    const rows = rowsByReason.get(reason) ?? [];
    const cards = rows
      .map((r) => {
        const title = r.title ? escapeHtml(r.title) : '(no title)';
        const prev = r.textPreview ? escapeHtml(r.textPreview) : '';
        const rel = escapeHtml(r.relevance.reasons.join('; ') || '—');
        const relHost = escapeHtml(r.reliabilityReasons.join('; ') || '—');
        const cand = escapeHtml(r.candidateUrl);
        const eff = escapeHtml(r.effectiveUrl);
        const same = r.candidateUrl === r.effectiveUrl;
        return `<article class="card">
  <h3 class="card-title"><a href="${cand}" target="_blank" rel="noopener">${title}</a></h3>
  <p class="meta"><strong>Candidate URL:</strong> <a href="${cand}" target="_blank" rel="noopener">${cand}</a></p>
  ${
    same
      ? ''
      : `<p class="meta"><strong>Effective URL:</strong> <a href="${eff}" target="_blank" rel="noopener">${eff}</a></p>`
  }
  <p class="meta"><strong>Reliability score:</strong> ${r.reliabilityScore} · <strong>Region:</strong> ${escapeHtml(
    r.relevance.region,
  )} · <strong>Relevance accepted:</strong> ${r.relevance.accepted}</p>
  <p class="meta small"><strong>Reliability reasons:</strong> ${relHost}</p>
  <p class="meta small"><strong>Relevance reasons:</strong> ${rel}</p>
  ${prev ? `<p class="preview">${prev}</p>` : ''}
</article>`;
      })
      .join('\n');

    sections.push(`<section class="reason-block" id="${escapeHtml(reason.replace(/\s+/g, '-').toLowerCase())}">
<h2>${escapeHtml(reason)} <span class="count">(${rows.length})</span></h2>
<div class="cards">${cards}</div>
</section>`);
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Pipeline rejection review</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 920px; margin: 24px auto; padding: 0 16px; color: #1a1a1a; }
    h1 { font-size: 1.35rem; }
    h2 { font-size: 1.1rem; margin-top: 2rem; border-bottom: 1px solid #ccc; padding-bottom: 6px; }
    .count { color: #555; font-weight: normal; }
    .toc { background: #f4f4f4; padding: 12px 16px; border-radius: 8px; margin: 16px 0; }
    .toc a { display: block; margin: 4px 0; }
    .card { border: 1px solid #ddd; border-radius: 8px; padding: 12px 14px; margin: 12px 0; background: #fff; }
    .card-title { margin: 0 0 8px; font-size: 1rem; }
    .card-title a { color: #0b5; }
    .meta { margin: 4px 0; font-size: 0.88rem; word-break: break-all; }
    .meta.small { color: #444; font-size: 0.82rem; }
    .preview { margin-top: 10px; font-size: 0.9rem; line-height: 1.45; color: #222; }
    .stamp { color: #666; font-size: 0.85rem; }
  </style>
</head>
<body>
  <h1>Pipeline rejection review</h1>
  <p class="stamp">Generated ${escapeHtml(generatedAt)} · Reasons: reliability, UK/EU relevance threshold, regional source/signal</p>
  <nav class="toc">
    ${[...TARGET_REASONS]
      .map(
        (r) =>
          `<a href="#${escapeHtml(r.replace(/\s+/g, '-').toLowerCase())}">${escapeHtml(r)} (${rowsByReason.get(r)?.length ?? 0})</a>`,
      )
      .join('\n    ')}
  </nav>
  ${sections.join('\n')}
</body>
</html>
`;
}

function loadUrlsFromCandidatesJson(path: string): string[] {
  const raw = JSON.parse(readFileSync(path, 'utf-8')) as { urls?: string[] };
  if (!Array.isArray(raw.urls)) {
    throw new Error(`${path} must contain a urls array`);
  }
  return raw.urls.filter((u) => typeof u === 'string' && u.length > 0);
}

async function main(): Promise<void> {
  const concurrency = parsePositiveInt(getArg('concurrency'), 8);
  const candidatesArg = getArg('candidates');
  if (candidatesArg && !existsSync(candidatesArg)) {
    throw new Error(`--candidates file not found: ${candidatesArg}`);
  }
  const defaultCandidates = join(root, 'reports', 'last-run-candidates.json');
  const candidatesPath =
    candidatesArg ?? (existsSync(defaultCandidates) ? defaultCandidates : undefined);

  let urls: string[];
  let sourceLabel: string;

  if (candidatesPath && existsSync(candidatesPath)) {
    urls = loadUrlsFromCandidatesJson(candidatesPath);
    sourceLabel = candidatesPath;
  } else {
    const logPath = getArg('log') ?? join(root, 'last-run.log');
    const logText = readFileSync(logPath, 'utf-8');
    const rawUrls = extractCandidateUrlsFromLog(logText);
    const seen = new Set<string>();
    urls = [];
    for (const url of rawUrls) {
      if (!seen.has(url)) {
        seen.add(url);
        urls.push(url);
      }
    }
    sourceLabel = logPath;
  }

  const seen = new Set<string>();
  urls = urls.filter((u) => {
    if (seen.has(u)) return false;
    seen.add(u);
    return true;
  });

  console.log('[replay] candidates', { source: sourceLabel, uniqueUrls: urls.length });

  const config = loadConfig();
  const rowsByReason = new Map<string, MatchRow[]>();
  for (const r of TARGET_REASONS) {
    rowsByReason.set(r, []);
  }

  let processed = 0;
  let nextIndex = 0;
  const matches: MatchRow[] = [];

  async function worker(): Promise<void> {
    while (true) {
      const i = nextIndex;
      nextIndex += 1;
      if (i >= urls.length) return;
      const url = urls[i]!;
      try {
        const result = await runPipeline(url, config.allowedSourceHosts, {}, ARCHIVE_FALLBACK_HOSTS);
        if (result.status === 'rejected' && TARGET_REASONS.has(result.reason)) {
          const row: MatchRow = {
            candidateUrl: url,
            reason: result.reason,
            effectiveUrl: result.source.url,
            title: result.title,
            textPreview: result.textPreview,
            reliabilityScore: result.source.reliabilityScore,
            reliabilityReasons: [...result.source.reliabilityReasons],
            relevance: {
              accepted: result.relevance.accepted,
              region: result.relevance.region,
              confidence: result.relevance.confidence,
              reasons: [...result.relevance.reasons],
            },
          };
          matches.push(row);
          rowsByReason.get(result.reason)!.push(row);
        }
      } catch (e) {
        console.warn('[replay] pipeline error', { url, message: e instanceof Error ? e.message : String(e) });
      } finally {
        processed += 1;
        if (processed % 200 === 0 || processed === urls.length) {
          console.log('[replay] progress', { processed, total: urls.length, matched: matches.length });
        }
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const generatedAt = new Date().toISOString();
  mkdirSync(join(root, 'reports'), { recursive: true });
  const jsonPath = join(root, 'reports', 'pipeline-rejection-review-latest.json');
  writeFileSync(
    jsonPath,
    `${JSON.stringify({ generatedAt, candidateSource: sourceLabel, uniqueCandidates: urls.length, rows: matches }, null, 2)}\n`,
    'utf-8',
  );

  const htmlPath = join(root, 'reports', 'pipeline-rejection-review-latest.html');
  const html = renderHtml(rowsByReason, generatedAt);
  writeFileSync(htmlPath, html, 'utf-8');

  console.log('[replay] wrote', { jsonPath, htmlPath, matched: matches.length });
  for (const r of TARGET_REASONS) {
    console.log('[replay] ', r, rowsByReason.get(r)?.length ?? 0);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
