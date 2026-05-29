import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { loadConfig } from './config.ts';
import { PRIORITY_WATCHLIST_HOSTS } from './discoveryConfig.ts';
import { type DiscoveredStory, discoverCandidateStories } from './discoverStories.ts';
import { createDraftViaMcp } from './mcpClient.ts';
import { ARCHIVE_FALLBACK_HOSTS } from './http-cache/config.ts';
import { runPipeline, isCultTopicPreciseWithAudit } from './pipeline.ts';
import type { DraftPayload } from './types.ts';

export { isCultTopicPreciseWithAudit };

function getArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : undefined;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }

  return parsed;
}

function parseOptionalPositiveInt(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return undefined;
  }

  return parsed;
}

function parseCandidateHost(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

function incrementCount(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function mapToSortedEntries(map: Map<string, number>, limit: number): Array<{ key: string; count: number }> {
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, Math.max(0, limit))
    .map(([key, count]) => ({ key, count }));
}

const PIPELINE_PROGRESS_EVERY = Math.max(
  1,
  Number.parseInt(process.env.PIPELINE_PROGRESS_EVERY ?? '5', 10) || 5,
);

function logProgress(stage: string, data: Record<string, unknown>): void {
  console.log(
    `[agent][progress] ${JSON.stringify({ scope: 'pipeline', at: new Date().toISOString(), stage, ...data })}`,
  );
}

async function main(): Promise<void> {
  const config = loadConfig();
  const url = getArg('url');
  const maxApproved = parseOptionalPositiveInt(getArg('max'));
  const hostBackoffEnabled = (process.env.HOST_FETCH_BACKOFF_ENABLED ?? 'true').toLowerCase() !== 'false';
  const hostFailureThreshold = parsePositiveInt(process.env.HOST_FETCH_FAILURE_THRESHOLD, 3);
  const hostBackoffStatusCodes = new Set(
    (process.env.HOST_FETCH_BACKOFF_STATUS_CODES ?? '403,404')
      .split(',')
      .map((value) => Number.parseInt(value.trim(), 10))
      .filter((value) => Number.isFinite(value) && value >= 100),
  );
  const diagnosticsTopN = parsePositiveInt(process.env.DIAGNOSTICS_TOP_N, 10);
  const defaultConcurrency = Math.max(
    1,
    Number.parseInt(process.env.CANDIDATE_PROCESS_CONCURRENCY ?? '6', 10) || 6,
  );

  console.log('[agent] starting run', {
    env: config.env,
    dryRun: config.dryRun,
    url: url ?? null,
    maxApproved: maxApproved ?? 'unbounded',
  });

  const skipDiscovery = (process.env.SKIP_DISCOVERY ?? '').toLowerCase() === 'true';
  const candidatesByUrl = new Map<string, DiscoveredStory>();

  if (url) {
    candidatesByUrl.set(url, {
      url,
      title: 'Explicit URL input',
      sourceFeed: 'manual-url',
      sourceFormat: 'html',
      sourceCategory: 'web-page',
      requiresUrlResolution: false,
    });
  } else if (skipDiscovery) {
    const raw = JSON.parse(readFileSync('reports/last-run-candidates.json', 'utf-8')) as { urls: string[] };
    for (const u of raw.urls) {
      candidatesByUrl.set(u, {
        url: u,
        title: '',
        sourceFeed: 'last-run-candidates',
        sourceFormat: 'html',
        sourceCategory: 'web-page',
        requiresUrlResolution: u.includes('news.google.com'),
      });
    }
    console.log('[agent] skipped discovery, loaded candidates from last-run-candidates.json', { count: candidatesByUrl.size });
  } else {
    const discovered = await discoverCandidateStories(config.allowedSourceHosts);
    for (const item of discovered) {
      candidatesByUrl.set(item.url, item);
    }

    const sourceCounts = discovered.reduce<Record<string, number>>((acc, item) => {
      acc[item.sourceFeed] = (acc[item.sourceFeed] ?? 0) + 1;
      return acc;
    }, {});

    const watchlistHits = discovered.filter((item) => {
      try {
        const host = new URL(item.url).hostname.toLowerCase().replace(/^www\./, '');
        return PRIORITY_WATCHLIST_HOSTS.some((watchHost) => host === watchHost || host.endsWith(`.${watchHost}`));
      } catch {
        return false;
      }
    });

    mkdirSync('reports', { recursive: true });
    writeFileSync(
      'reports/last-run-candidates.json',
      `${JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          count: discovered.length,
          urls: discovered.map((item) => item.url),
        },
        null,
        2,
      )}\n`,
      'utf-8',
    );

    const scoreRows = discovered.map((item) => ({
      url: item.url,
      score: item.discoveryScore ?? null,
      scoreBreakdown: item.discoveryScoreBreakdown ?? null,
      sourceFeed: item.sourceFeed,
    }));
    const maxScoreDetailsRows = Math.max(0, Number.parseInt(process.env.LOG_CANDIDATE_SCORE_DETAILS_MAX ?? '80', 10) || 80);
    const includeScoreDetails = discovered.length <= maxScoreDetailsRows;

    console.log('[agent] discovered candidate stories', {
      count: discovered.length,
      targetApproved: maxApproved ?? 'unbounded',
      feedsScanned: true,
      sourceCounts,
      watchlistHitCount: watchlistHits.length,
      watchlistHitUrls: watchlistHits.map((item) => item.url),
      candidateListFile: 'reports/last-run-candidates.json',
      candidateScoreDetails: includeScoreDetails
        ? JSON.stringify(scoreRows)
        : `[omitted ${discovered.length} rows; set LOG_CANDIDATE_SCORE_DETAILS_MAX or read candidateListFile]`,
    });
  }

  if (candidatesByUrl.size === 0) {
    console.log('[agent] no candidate URLs found');
    return;
  }

  let drafted = 0;
  let accepted = 0;
  let acceptedNotDrafted = 0;
  let rejected = 0;
  let errored = 0;
  let skippedBlockedHost = 0;
  const totalCandidates = candidatesByUrl.size;
  const concurrency = Math.min(totalCandidates, parsePositiveInt(getArg('concurrency'), defaultConcurrency));
  let processed = 0;
  let nextIndex = 0;
  const candidates = Array.from(candidatesByUrl.values());
  const rejectReasonCounts = new Map<string, number>();
  const relevanceReasonCounts = new Map<string, number>();
  const sourceReliabilityReasonCounts = new Map<string, number>();
  const hostFailureCounts = new Map<string, number>();
  const blockedHosts = new Set<string>();
  const failedUrls: Array<{ url: string; host: string | null; errorMessage: string; timestamp: string }> = [];
  const pipelineRejections: Array<{
    candidateUrl: string;
    reason: string;
    effectiveUrl: string;
    title?: string;
    textPreview?: string;
    reliabilityScore: number;
    reliabilityReasons: string[];
    relevance: { accepted: boolean; region: string; confidence: number; reasons: string[] };
  }> = [];
  const runDrafts: DraftPayload[] = [];

  const pipelineStartedAt = Date.now();

  logProgress('processing-start', {
    candidatePool: totalCandidates,
    targetApproved: maxApproved ?? 'unbounded',
    concurrency,
    logEvery: PIPELINE_PROGRESS_EVERY,
  });

  async function worker(): Promise<void> {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;

      if (currentIndex >= candidates.length) {
        return;
      }

      const candidate = candidates[currentIndex];
      if (!candidate) {
        continue;
      }

      const candidateHost = parseCandidateHost(candidate.url);
      if (hostBackoffEnabled && candidateHost && blockedHosts.has(candidateHost)) {
        skippedBlockedHost += 1;
        processed += 1;

        if (processed === 1 || processed % PIPELINE_PROGRESS_EVERY === 0 || processed === totalCandidates) {
          const elapsedMs = Date.now() - pipelineStartedAt;
          const avgMs = processed > 0 ? elapsedMs / processed : 0;
          const remaining = totalCandidates - processed;
          const etaMs = remaining > 0 && avgMs > 0 ? Math.round(remaining * avgMs) : 0;
          logProgress('processing-running', {
            processed,
            totalCandidates,
            completionPct: Number(((processed / totalCandidates) * 100).toFixed(1)),
            accepted,
            drafted,
            rejected,
            errored,
            skippedBlockedHost,
            elapsedMs,
            etaMs,
          });
        }

        continue;
      }

      try {
        const result = await runPipeline(candidate.url, config.allowedSourceHosts, {
          requiresUrlResolution: candidate.requiresUrlResolution,
        }, ARCHIVE_FALLBACK_HOSTS);

        if (result.status === 'rejected') {
          rejected += 1;
          incrementCount(rejectReasonCounts, result.reason);
          for (const reason of result.relevance.reasons) {
            incrementCount(relevanceReasonCounts, reason);
          }
          for (const reason of result.source.reliabilityReasons) {
            incrementCount(sourceReliabilityReasonCounts, reason);
          }
          pipelineRejections.push({
            candidateUrl: candidate.url,
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
          });
        } else {
          accepted += 1;

          if (maxApproved !== undefined && drafted >= maxApproved) {
            acceptedNotDrafted += 1;
          } else {
            drafted += 1;
            runDrafts.push(result.draft);

            if (config.dryRun) {
              console.log('[agent] draft (dry-run)', result.draft);
            } else {
              const response = await createDraftViaMcp(result.draft);
              console.log('[agent] draft created via MCP', {
                url: candidate.url,
                response,
              });
            }
          }
        }
      } catch (error) {
        errored += 1;
        const message = error instanceof Error ? error.message : String(error);

        const statusMatch = message.match(/HTTP\s+(\d{3})/i);
        const statusToken = statusMatch?.[1];
        const statusCode = statusToken ? Number.parseInt(statusToken, 10) : undefined;
        if (
          hostBackoffEnabled &&
          candidateHost &&
          statusCode &&
          hostBackoffStatusCodes.has(statusCode)
        ) {
          const failureCount = (hostFailureCounts.get(candidateHost) ?? 0) + 1;
          hostFailureCounts.set(candidateHost, failureCount);

          if (failureCount >= hostFailureThreshold) {
            blockedHosts.add(candidateHost);
          }
        }

        failedUrls.push({
          url: candidate.url,
          host: candidateHost ?? null,
          errorMessage: message,
          timestamp: new Date().toISOString(),
        });

        console.warn('[agent] candidate processing failed', {
          url: candidate.url,
          message,
          candidateHost: candidateHost ?? null,
          blockedHost: candidateHost ? blockedHosts.has(candidateHost) : false,
        });
      } finally {
        processed += 1;

        if (processed === 1 || processed % PIPELINE_PROGRESS_EVERY === 0 || processed === totalCandidates) {
          const elapsedMs = Date.now() - pipelineStartedAt;
          const avgMs = processed > 0 ? elapsedMs / processed : 0;
          const remaining = totalCandidates - processed;
          const etaMs = remaining > 0 && avgMs > 0 ? Math.round(remaining * avgMs) : 0;
          logProgress('processing-running', {
            processed,
            totalCandidates,
            completionPct: Number(((processed / totalCandidates) * 100).toFixed(1)),
            accepted,
            drafted,
            rejected,
            errored,
            skippedBlockedHost,
            elapsedMs,
            etaMs,
          });
        }
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  mkdirSync('reports', { recursive: true });
  writeFileSync(
    'reports/last-run-drafts.json',
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        count: runDrafts.length,
        drafts: runDrafts,
      },
      null,
      2,
    )}\n`,
    'utf-8',
  );
  console.log('[agent] drafts written', {
    path: 'reports/last-run-drafts.json',
    count: runDrafts.length,
  });

  const ARCHIVE_PATH = 'reports/drafts-archive.json';
  const ARCHIVE_MAX_AGE_DAYS = Math.max(
    1,
    Number.parseInt(process.env.DRAFTS_ARCHIVE_MAX_AGE_DAYS ?? '14', 10) || 14,
  );
  const archiveCutoffMs = ARCHIVE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const now = Date.now();

  type ArchiveEntry = { firstSeenAt: string; draft: DraftPayload };
  const archive = new Map<string, ArchiveEntry>();

  if (existsSync(ARCHIVE_PATH)) {
    try {
      const existing = JSON.parse(readFileSync(ARCHIVE_PATH, 'utf-8')) as {
        entries?: Array<{ url: string; firstSeenAt: string; draft: DraftPayload }>;
      };
      for (const entry of existing.entries ?? []) {
        if (typeof entry.url === 'string' && entry.draft && entry.firstSeenAt) {
          const age = now - new Date(entry.firstSeenAt).getTime();
          if (age <= archiveCutoffMs) {
            archive.set(entry.url, { firstSeenAt: entry.firstSeenAt, draft: entry.draft });
          }
        }
      }
    } catch {
      console.warn('[agent] drafts-archive.json could not be parsed; starting fresh');
    }
  }

  for (const draft of runDrafts) {
    const url = draft.source?.url;
    if (typeof url === 'string' && url) {
      if (!archive.has(url)) {
        archive.set(url, { firstSeenAt: new Date().toISOString(), draft });
      }
    }
  }

  const archiveEntries = Array.from(archive.entries()).map(([url, { firstSeenAt, draft }]) => ({
    url,
    firstSeenAt,
    draft,
  }));
  writeFileSync(
    ARCHIVE_PATH,
    `${JSON.stringify(
      {
        updatedAt: new Date().toISOString(),
        maxAgeDays: ARCHIVE_MAX_AGE_DAYS,
        count: archiveEntries.length,
        entries: archiveEntries,
      },
      null,
      2,
    )}\n`,
    'utf-8',
  );
  console.log('[agent] drafts archive updated', {
    path: ARCHIVE_PATH,
    total: archiveEntries.length,
    newThisRun: runDrafts.length,
    maxAgeDays: ARCHIVE_MAX_AGE_DAYS,
  });

  if (pipelineRejections.length > 0) {
    mkdirSync('reports', { recursive: true });
    const rejectionOut = {
      generatedAt: new Date().toISOString(),
      candidatePool: candidatesByUrl.size,
      rows: pipelineRejections,
    };
    writeFileSync('reports/pipeline-rejections-latest.json', `${JSON.stringify(rejectionOut, null, 2)}\n`, 'utf-8');
    console.log('[agent] pipeline rejections written', {
      path: 'reports/pipeline-rejections-latest.json',
      count: pipelineRejections.length,
    });
  }

  if (failedUrls.length > 0) {
    mkdirSync('reports', { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const outPath = `reports/failed-urls-${ts}.json`;
    writeFileSync(outPath, `${JSON.stringify(failedUrls, null, 2)}\n`, 'utf-8');
    console.log('[agent] failed URLs written', { path: outPath, count: failedUrls.length });
  }

  console.log('[agent] run summary', {
    processed,
    candidatePool: candidatesByUrl.size,
    draftCap: maxApproved ?? 'unbounded',
    accepted,
    acceptedNotDrafted,
    drafted,
    rejected,
    errored,
    skippedBlockedHost,
    blockedHostCount: blockedHosts.size,
    blockedHosts: Array.from(blockedHosts.values()).sort(),
    topRejectReasons: mapToSortedEntries(rejectReasonCounts, diagnosticsTopN),
    topRelevanceReasons: mapToSortedEntries(relevanceReasonCounts, diagnosticsTopN),
    topSourceReliabilityReasons: mapToSortedEntries(sourceReliabilityReasonCounts, diagnosticsTopN),
    topFetchFailureHosts: mapToSortedEntries(hostFailureCounts, diagnosticsTopN),
  });
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error('[agent] failed', { message });
  process.exitCode = 1;
});
