import { getAgentByName, routeAgentRequest } from 'agents';
import type { Env } from './types';
import { requireEditor } from './lib/auth';
import {
  getCandidateArticleEntryById,
  getCandidateExtractResults,
  getFeedFetchCacheEntryById,
  getFeedFetchCacheEntryByRequestUrl,
  getFeedFetchResults,
  getStageEvents,
} from './lib/db';
import { createFetchHandler, type FetchDeps } from './httpHandler';
import { CultAgentOrchestrator } from './orchestrator';
import { handleCandidateFetchQueue } from './queueConsumer';
import { RunProgressHub } from './progressHub';

export { CultAgentOrchestrator };
export { RunProgressHub };

const defaultFetchDeps: FetchDeps = {
  routeRequest: routeAgentRequest,
  getAgent: (env) => getAgentByName<Env, CultAgentOrchestrator>(env.ORCHESTRATOR, 'global'),
  requireEditor,
  getStageEvents,
  getFeedFetchResults,
  getCandidateExtractResults,
  getCandidateArticleEntryById,
  getFeedFetchCacheEntryByRequestUrl,
  getFeedFetchCacheEntryById,
};

export { createFetchHandler };

const fetchHandler = createFetchHandler(defaultFetchDeps);

async function fetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/ui/ws/candidate-progress') {
    const runId = url.searchParams.get('runId');
    if (!runId) {
      return new Response('Missing runId', { status: 400 });
    }

    const hubId = env.RUN_PROGRESS_HUB.idFromName(runId);
    const stub = env.RUN_PROGRESS_HUB.get(hubId);
    const forwardUrl = new URL('https://run-progress-hub/subscribe');
    forwardUrl.searchParams.set('runId', runId);

    const candidateId = url.searchParams.get('candidateId');
    if (candidateId) {
      forwardUrl.searchParams.set('candidateId', candidateId);
    }

    const forwardedRequest = new Request(forwardUrl.toString(), request);
    return stub.fetch(forwardedRequest);
  }

  return fetchHandler(request, env);
}

export default {
  fetch,
  queue: handleCandidateFetchQueue,
};
