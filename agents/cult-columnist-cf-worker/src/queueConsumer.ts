import type { Env, CandidateFetchQueueMessage } from './types';
import {
  countPendingCandidateFetchWorkItems,
  getCandidateExtractResultById,
  getCandidateFetchWorkItemById,
  logStageEvent,
  setRunStatus,
} from './lib/db';
import { processCandidateFetchWorkItem } from './stages/candidateExtract';

function isCandidateFetchQueueMessage(value: unknown): value is CandidateFetchQueueMessage {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<CandidateFetchQueueMessage>;
  return (
    typeof candidate.runId === 'string' &&
    typeof candidate.candidateId === 'number' &&
    Number.isFinite(candidate.candidateId) &&
    candidate.candidateId > 0 &&
    typeof candidate.rawUrl === 'string' &&
    typeof candidate.requiresUrlResolution === 'number'
  );
}

export async function handleCandidateFetchQueue(batch: MessageBatch<CandidateFetchQueueMessage>, env: Env): Promise<void> {
  const touchedRunIds = new Set<string>();

  for (const message of batch.messages) {
    const body = message.body;
    if (!isCandidateFetchQueueMessage(body)) {
      continue;
    }

    const row = await getCandidateFetchWorkItemById(env.AGENT_DB, body.runId, body.candidateId);
    if (!row) {
      continue;
    }
    if (row.articleStatus !== null) {
      touchedRunIds.add(body.runId);
      continue;
    }

    try {
      const outcome = await processCandidateFetchWorkItem(env.AGENT_DB, env.AGENT_STORE, {
        candidateId: row.candidateId,
        rawUrl: row.rawUrl,
        requiresUrlResolution: row.requiresUrlResolution,
      });

      const pendingRemaining = await countPendingCandidateFetchWorkItems(env.AGENT_DB, body.runId);
      const candidate = await getCandidateExtractResultById(env.AGENT_DB, body.runId, row.candidateId);
      try {
        const hubId = env.RUN_PROGRESS_HUB.idFromName(body.runId);
        const hub = env.RUN_PROGRESS_HUB.get(hubId);
        await hub.fetch('https://run-progress-hub/publish', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            runId: body.runId,
            candidateId: row.candidateId,
            outcome,
            pendingRemaining,
            candidate,
          }),
        });
      } catch {
        // Keep queue processing resilient even if progress notifications fail.
      }

      await logStageEvent(env.AGENT_DB, {
        runId: body.runId,
        stage: 'candidate_extract',
        level: 'info',
        message: 'candidate article processed',
        data: {
          candidateId: row.candidateId,
          outcome,
          decisionCode: candidate?.decision_code ?? null,
        },
      });
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      await logStageEvent(env.AGENT_DB, {
        runId: body.runId,
        stage: 'candidate_extract',
        level: 'error',
        message: 'candidate article processing failed',
        data: {
          candidateId: row.candidateId,
          error: messageText,
        },
      });
    }

    touchedRunIds.add(body.runId);
  }

  for (const runId of touchedRunIds) {
    const pending = await countPendingCandidateFetchWorkItems(env.AGENT_DB, runId);
    if (pending > 0) {
      continue;
    }

    await setRunStatus(env.AGENT_DB, runId, 'awaiting_review_candidate_extract', 'candidate_extract');
    await logStageEvent(env.AGENT_DB, {
      runId,
      stage: 'candidate_extract',
      level: 'info',
      message: 'candidate queue drained; stage awaiting review',
    });
  }
}
