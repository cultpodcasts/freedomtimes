import { loadConfig } from './config.js';
import { PRIORITY_WATCHLIST_HOSTS } from './discoveryConfig.js';
import { type DiscoveredStory, discoverCandidateStories } from './discoverStories.js';
import { createDraftViaMcp } from './mcpClient.js';
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

function logProgress(stage: string, data: Record<string, unknown>): void {
  console.log(`[agent][progress] ${JSON.stringify({ scope: 'pipeline', stage, ...data })}`);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const url = getArg('url');
  const maxApproved = parsePositiveInt(getArg('max'), 8);
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
    const discoveryPoolSize = Math.max(maxApproved * 20, 300);
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
  const totalCandidates = candidatesByUrl.size;
  const concurrency = Math.min(totalCandidates, parsePositiveInt(getArg('concurrency'), defaultConcurrency));
  let processed = 0;
  let nextIndex = 0;
  const candidates = Array.from(candidatesByUrl.values());

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

      try {
        const result = await runPipeline(candidate.url, config.allowedSourceHosts, {
          requiresUrlResolution: candidate.requiresUrlResolution,
        });

        if (result.status === 'rejected') {
          rejected += 1;
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
        console.warn('[agent] candidate processing failed', {
          url: candidate.url,
          message,
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
  });
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error('[agent] failed', { message });
  process.exitCode = 1;
});
