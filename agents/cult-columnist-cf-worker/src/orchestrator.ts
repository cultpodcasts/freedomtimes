import { Agent, callable } from 'agents';
import type { Env, StageName } from './types';
import {
  countPendingCandidateFetchWorkItems,
  createRun,
  deleteRunData,
  getRunSummary,
  listPendingCandidateFetchWorkItems,
  logStageEvent,
  purgeExpiredHttpCache,
  recordStageReview,
  setRunStatus,
} from './lib/db';
import { runFeedFetchStage } from './stages/feedFetch';
import { runCandidateExtractStage } from './stages/candidateExtract';
import type { CandidateFetchQueueMessage } from './types';

type AgentState = {
  activeRunId: string | null;
};

type StageTransition = {
  current: StageName;
  next: StageName | null;
};

const STAGE_FLOW: Record<StageName, StageTransition> = {
  feed_fetch: {
    current: 'feed_fetch',
    next: 'candidate_extract',
  },
  candidate_extract: {
    current: 'candidate_extract',
    next: null,
  },
};

export class CultAgentOrchestrator extends Agent<Env, AgentState> {
  initialState: AgentState = { activeRunId: null };

  private async continueRunInBackground(runId: string, nextStage: StageName): Promise<void> {
    try {
      if (nextStage === 'candidate_extract') {
        const stageResult = await this.runFiber(`approve:${runId}:${nextStage}`, async (ctx) => {
          const seedResult = await runCandidateExtractStage(this.env.AGENT_DB, this.env.AGENT_STORE, runId, this.env);
          const pendingItems = await listPendingCandidateFetchWorkItems(this.env.AGENT_DB, runId);

          if (pendingItems.length === 0) {
            await setRunStatus(this.env.AGENT_DB, runId, 'awaiting_review_candidate_extract', nextStage);
            await logStageEvent(this.env.AGENT_DB, {
              runId,
              stage: nextStage,
              level: 'info',
              message: 'candidate_extract seeded with no pending candidate fetch jobs',
              data: seedResult,
            });

            ctx.stash({ runId, stage: nextStage, queued: 0 });
            return { ...seedResult, queued: 0, batches: 0 };
          }

          const batchSize = 50;
          let batches = 0;
          for (let i = 0; i < pendingItems.length; i += batchSize) {
            const slice = pendingItems.slice(i, i + batchSize);
            const messages: MessageSendRequest<CandidateFetchQueueMessage>[] = slice.map((item) => ({
              body: {
                runId,
                candidateId: item.candidateId,
                rawUrl: item.rawUrl,
                requiresUrlResolution: item.requiresUrlResolution,
              },
            }));

            await this.env.CANDIDATE_FETCH_QUEUE.sendBatch(messages);
            batches += 1;
          }

          await logStageEvent(this.env.AGENT_DB, {
            runId,
            stage: nextStage,
            level: 'info',
            message: 'candidate fetch jobs enqueued',
            data: { queued: pendingItems.length, batches },
          });

          ctx.stash({ runId, stage: nextStage, queued: pendingItems.length, batches });
          return { ...seedResult, queued: pendingItems.length, batches };
        });

        await logStageEvent(this.env.AGENT_DB, {
          runId,
          stage: 'orchestration',
          level: 'info',
          message: 'background stage seed/enqueue finished',
          data: { nextStage, stageResult },
        });
        return;
      }

      const stageResult = await this.runFiber(`approve:${runId}:${nextStage}`, async (ctx) => {
        const result = await this.runSingleStage(runId, nextStage);
        await logStageEvent(this.env.AGENT_DB, {
          runId,
          stage: nextStage,
          level: 'info',
          message: `${nextStage} completed`,
          data: result,
        });
        ctx.stash({ runId, stage: nextStage });
        return result;
      });

      await logStageEvent(this.env.AGENT_DB, {
        runId,
        stage: 'orchestration',
        level: 'info',
        message: 'background stage run finished',
        data: { nextStage, stageResult },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await logStageEvent(this.env.AGENT_DB, {
        runId,
        stage: nextStage,
        level: 'error',
        message: 'background stage run failed',
        data: { error: message },
      });
      await setRunStatus(this.env.AGENT_DB, runId, 'failed', nextStage);
    }
  }

  private async runSingleStage(runId: string, stage: StageName): Promise<Record<string, unknown>> {
    if (stage === 'feed_fetch') {
      const metrics = await runFeedFetchStage(this.env.AGENT_DB, this.env.AGENT_STORE, this.env);
      await setRunStatus(this.env.AGENT_DB, runId, 'awaiting_review_feed_fetch', stage);
      return { stage, ...metrics };
    }

    const metrics = await runCandidateExtractStage(this.env.AGENT_DB, this.env.AGENT_STORE, runId, this.env);
    await setRunStatus(this.env.AGENT_DB, runId, 'awaiting_review_candidate_extract', stage);
    return { stage, ...metrics };
  }

  @callable()
  async startRun(): Promise<Record<string, unknown>> {
    const runId = new Date().toISOString();

    const stageResult = await this.runFiber(`start-run:${runId}`, async (ctx) => {
      await createRun(this.env.AGENT_DB, runId);
      await logStageEvent(this.env.AGENT_DB, {
        runId,
        stage: 'orchestration',
        level: 'info',
        message: 'run started',
      });

      const purged = await purgeExpiredHttpCache(this.env.AGENT_DB, new Date().toISOString());
      await logStageEvent(this.env.AGENT_DB, {
        runId,
        stage: 'orchestration',
        level: 'info',
        message: 'expired cache purged',
        data: { purgedCount: purged },
      });

      const stage = await this.runSingleStage(runId, 'feed_fetch');
      await logStageEvent(this.env.AGENT_DB, {
        runId,
        stage: 'feed_fetch',
        level: 'info',
        message: 'feed_fetch completed',
        data: stage,
      });

      ctx.stash({ runId, stage: 'feed_fetch' });
      return { purgedExpiredHttpCache: purged, stage };
    });

    this.setState({ activeRunId: runId });
    return { runId, ...stageResult };
  }

  @callable()
  async listRuns(): Promise<Record<string, unknown>> {
    const rows = await this.env.AGENT_DB
      .prepare('SELECT id, status, current_stage, started_at, updated_at, error FROM runs ORDER BY started_at DESC LIMIT 50')
      .all();

    return { runs: rows.results ?? [] };
  }

  @callable()
  async getRun(runId: string): Promise<Record<string, unknown>> {
    return getRunSummary(this.env.AGENT_DB, runId);
  }

  @callable()
  async deleteRun(runId: string): Promise<Record<string, unknown>> {
    const deleted = await deleteRunData(this.env.AGENT_DB, runId);
    if (!deleted.existed) {
      return {
        runId,
        deleted: false,
        message: 'Run not found',
      };
    }

    let deletedR2Objects = 0;
    for (const key of deleted.articleR2Keys) {
      await this.env.AGENT_STORE.delete(key);
      deletedR2Objects += 1;
    }

    if (this.state.activeRunId === runId) {
      this.setState({ activeRunId: null });
    }

    return {
      runId,
      deleted: true,
      deletedCandidates: deleted.deletedCandidates,
      deletedReviews: deleted.deletedReviews,
      deletedLogs: deleted.deletedLogs,
      deletedGroups: deleted.deletedGroups,
      deletedRuns: deleted.deletedRuns,
      deletedR2Objects,
      retainedSharedFeedCache: true,
    };
  }

  @callable()
  async rejectStage(runId: string, stage: StageName, notes: string | null, reviewedBy: string | null): Promise<Record<string, unknown>> {
    await recordStageReview(this.env.AGENT_DB, {
      runId,
      stage,
      signal: 'reject',
      notes,
      reviewedBy,
    });

    await logStageEvent(this.env.AGENT_DB, {
      runId,
      stage,
      level: 'warn',
      message: 'stage rejected',
      data: { reviewedBy, notes },
    });

    await setRunStatus(this.env.AGENT_DB, runId, 'failed', stage);
    return { runId, stage, signal: 'reject', status: 'failed' };
  }

  @callable()
  async approveStage(runId: string, stage: StageName, notes: string | null, reviewedBy: string | null): Promise<Record<string, unknown>> {
    await recordStageReview(this.env.AGENT_DB, {
      runId,
      stage,
      signal: 'approve',
      notes,
      reviewedBy,
    });

    await logStageEvent(this.env.AGENT_DB, {
      runId,
      stage,
      level: 'info',
      message: 'stage approved',
      data: { reviewedBy, notes },
    });

    const transition = STAGE_FLOW[stage];
    if (!transition.next) {
      await setRunStatus(this.env.AGENT_DB, runId, 'published_draft', stage);
      await logStageEvent(this.env.AGENT_DB, {
        runId,
        stage: 'orchestration',
        level: 'info',
        message: 'run completed (final stage)',
      });
      return { runId, stage, signal: 'approve', status: 'published_draft' };
    }

    const nextStage = transition.next;
    await setRunStatus(this.env.AGENT_DB, runId, 'started', nextStage);

    if (nextStage === 'candidate_extract') {
      const pendingBefore = await countPendingCandidateFetchWorkItems(this.env.AGENT_DB, runId);
      await logStageEvent(this.env.AGENT_DB, {
        runId,
        stage: 'orchestration',
        level: 'info',
        message: 'candidate_extract async queue fan-out requested',
        data: { pendingBefore },
      });
    }

    await logStageEvent(this.env.AGENT_DB, {
      runId,
      stage: 'orchestration',
      level: 'info',
      message: 'background stage run queued',
      data: { nextStage },
    });

    void this.continueRunInBackground(runId, nextStage);

    return {
      runId,
      signal: 'approve',
      advancedTo: nextStage,
      accepted: true,
      processingMode: 'async',
    };
  }
}
