import { loadConfig } from './config.js';
import { PRIORITY_WATCHLIST_HOSTS } from './discoveryConfig.js';
import { type DiscoveredStory, discoverCandidateStories } from './discoverStories.js';
import { createDraftViaMcp } from './mcpClient.js';
import { ARCHIVE_FALLBACK_HOSTS } from './http-cache/config.js';
import { runPipeline } from './pipeline.js';

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

function parsePositiveNumber(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
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

function logProgress(stage: string, data: Record<string, unknown>): void {
  console.log(`[agent][progress] ${JSON.stringify({ scope: 'pipeline', stage, ...data })}`);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const url = getArg('url');
  const maxApproved = parsePositiveInt(getArg('max'), 8);
  const discoveryPoolMultiplier = parsePositiveNumber(process.env.DISCOVERY_POOL_MULTIPLIER, 20);
  const discoveryPoolMin = parsePositiveInt(process.env.DISCOVERY_POOL_MIN, 300);
  const discoveryPoolMax = parsePositiveInt(process.env.DISCOVERY_POOL_MAX, 0);
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
    maxApproved,
  });

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
  } else {
    let discoveryPoolSize = Math.max(Math.ceil(maxApproved * discoveryPoolMultiplier), discoveryPoolMin);
    if (discoveryPoolMax > 0) {
      discoveryPoolSize = Math.min(discoveryPoolSize, discoveryPoolMax);
    }

    const discovered = await discoverCandidateStories(discoveryPoolSize, config.allowedSourceHosts);
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

    console.log('[agent] discovered candidate stories', {
      count: discovered.length,
      targetApproved: maxApproved,
      discoveryPoolSize,
      discoveryPoolMultiplier,
      discoveryPoolMin,
      discoveryPoolMax: discoveryPoolMax > 0 ? discoveryPoolMax : null,
      feedsScanned: true,
      sourceCounts,
      watchlistHitCount: watchlistHits.length,
      watchlistHitUrls: watchlistHits.map((item) => item.url),
      candidateScoreDetails: JSON.stringify(
        discovered.map((item) => ({
          url: item.url,
          score: item.discoveryScore ?? null,
          scoreBreakdown: item.discoveryScoreBreakdown ?? null,
          sourceFeed: item.sourceFeed,
        })),
      ),
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

  logProgress('processing-start', {
    candidatePool: totalCandidates,
    targetApproved: maxApproved,
    concurrency,
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

        if (processed === 1 || processed % 10 === 0 || processed === totalCandidates) {
          logProgress('processing-running', {
            processed,
            totalCandidates,
            completionPct: Number(((processed / totalCandidates) * 100).toFixed(1)),
            accepted,
            drafted,
            rejected,
            errored,
            skippedBlockedHost,
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
        } else {
          accepted += 1;

          if (drafted >= maxApproved) {
            acceptedNotDrafted += 1;
          } else {
            drafted += 1;

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

        console.warn('[agent] candidate processing failed', {
          url: candidate.url,
          message,
          candidateHost: candidateHost ?? null,
          blockedHost: candidateHost ? blockedHosts.has(candidateHost) : false,
        });
      } finally {
        processed += 1;

        if (processed === 1 || processed % 10 === 0 || processed === totalCandidates) {
          logProgress('processing-running', {
            processed,
            totalCandidates,
            completionPct: Number(((processed / totalCandidates) * 100).toFixed(1)),
            accepted,
            drafted,
            rejected,
            errored,
            skippedBlockedHost,
          });
        }
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  console.log('[agent] run summary', {
    processed,
    candidatePool: candidatesByUrl.size,
    draftCap: maxApproved,
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
