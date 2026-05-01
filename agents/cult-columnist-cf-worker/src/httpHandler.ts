import type { JWTPayload } from 'jose';
import type { Env, StageName } from './types';
import type { CandidateFetchQueueMessage } from './types';
import { runsListHtml, runDetailHtml, errorHtml } from './lib/ui';
import { listPendingCandidateFetchWorkItems, logStageEvent } from './lib/db';
import {
  ACCESS_TOKEN_COOKIE,
  UI_STATE_COOKIE,
  makeState,
  exchangeCodeForTokens,
  verifyAccessTokenForEditor,
  readCookieValue,
} from './lib/auth';

export type OrchestratorLike = {
  startRun(): Promise<Record<string, unknown>>;
  listRuns(): Promise<Record<string, unknown>>;
  getRun(runId: string): Promise<Record<string, unknown>>;
  deleteRun(runId: string): Promise<Record<string, unknown>>;
  approveStage(
    runId: string,
    stage: StageName,
    notes: string | null,
    reviewedBy: string | null,
  ): Promise<Record<string, unknown>>;
  rejectStage(
    runId: string,
    stage: StageName,
    notes: string | null,
    reviewedBy: string | null,
  ): Promise<Record<string, unknown>>;
};

export type FetchDeps = {
  routeRequest: (request: Request, env: Env) => Promise<Response | null | undefined>;
  getAgent: (env: Env) => Promise<OrchestratorLike>;
  requireEditor: (request: Request, env: Env) => Promise<JWTPayload>;
  getStageEvents: (database: Env['AGENT_DB'], runId: string) => Promise<unknown>;
  getFeedFetchResults: (database: Env['AGENT_DB']) => Promise<unknown>;
  getCandidateExtractResults: (database: Env['AGENT_DB'], runId: string) => Promise<unknown>;
  getCandidateArticleEntryById: (database: Env['AGENT_DB'], runId: string, candidateId: number) => Promise<{
    id: number;
    raw_url: string;
    resolved_url: string | null;
    title: string | null;
    article_r2_key: string | null;
  } | null>;
  getFeedFetchCacheEntryByRequestUrl: (database: Env['AGENT_DB'], requestUrl: string) => Promise<{
    feed_id: string;
    feed_title: string;
    feed_url: string;
    content_type: string | null;
    r2_key: string | null;
    fetched_at: string | null;
  } | null>;
  getFeedFetchCacheEntryById: (database: Env['AGENT_DB'], feedId: string) => Promise<{
    feed_id: string;
    feed_title: string;
    feed_url: string;
    content_type: string | null;
    r2_key: string | null;
    fetched_at: string | null;
  } | null>;
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get('origin')?.trim() ?? '';
  return {
    'access-control-allow-origin': origin || '*',
    'access-control-allow-credentials': 'true',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type,x-csrf-token,x-correlation-id',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
}

function withCors(response: Response, request: Request): Response {
  const headers = new Headers(response.headers);
  const cors = corsHeaders(request);
  for (const [k, v] of Object.entries(cors)) {
    headers.set(k, v);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function parseRunId(pathname: string): string | null {
  const m = pathname.match(/^\/runs\/([^/]+)$/i);
  return m?.[1] ? decodeURIComponent(m[1]) : null;
}

function parseRunDeletePath(pathname: string): string | null {
  const m = pathname.match(/^\/runs\/([^/]+)\/delete$/i);
  return m?.[1] ? decodeURIComponent(m[1]) : null;
}

function parseStageAction(pathname: string): { runId: string; stage: StageName; action: 'approve' | 'reject' } | null {
  const m = pathname.match(/^\/runs\/([^/]+)\/stages\/([^/]+)\/(approve|reject)$/i);
  if (!m || !m[1] || !m[2] || !m[3]) {
    return null;
  }

  const stageRaw = m[2].toLowerCase();
  if (stageRaw !== 'feed_fetch' && stageRaw !== 'candidate_extract') {
    return null;
  }

  return {
    runId: decodeURIComponent(m[1]),
    stage: stageRaw,
    action: m[3].toLowerCase() as 'approve' | 'reject',
  };
}

function parseLogsPath(pathname: string): string | null {
  const m = pathname.match(/^\/runs\/([^/]+)\/logs$/i);
  return m?.[1] ? decodeURIComponent(m[1]) : null;
}

function parseUiRunPath(pathname: string): string | null {
  // Must not match /ui/auth/* paths
  const m = pathname.match(/^\/ui\/([^/]+)$/i);
  const segment = m?.[1] ? decodeURIComponent(m[1]) : null;
  return segment === 'auth' ? null : segment;
}

function parseStageFeedFetchPath(pathname: string): string | null {
  const m = pathname.match(/^\/runs\/([^/]+)\/stages\/feed_fetch$/i);
  return m?.[1] ? decodeURIComponent(m[1]) : null;
}

function parseStageCandidateExtractPath(pathname: string): string | null {
  const m = pathname.match(/^\/runs\/([^/]+)\/stages\/candidate_extract$/i);
  return m?.[1] ? decodeURIComponent(m[1]) : null;
}

function parseStageFeedFetchCachePath(pathname: string): { runId: string; feedId: string } | null {
  const m = pathname.match(/^\/runs\/([^/]+)\/stages\/feed_fetch\/cache\/([^/]+)$/i);
  if (!m?.[1] || !m?.[2]) {
    return null;
  }
  return {
    runId: decodeURIComponent(m[1]),
    feedId: decodeURIComponent(m[2]),
  };
}

function isStageFeedFetchCacheByUrlPath(pathname: string): boolean {
  return /^\/runs\/[^/]+\/stages\/feed_fetch\/cache$/i.test(pathname);
}

function parseStageCandidateExtractCachePath(pathname: string): { runId: string; candidateId: number } | null {
  const m = pathname.match(/^\/runs\/([^/]+)\/stages\/candidate_extract\/cache\/([^/]+)$/i);
  if (!m?.[1] || !m?.[2]) {
    return null;
  }

  const candidateId = Number.parseInt(decodeURIComponent(m[2]), 10);
  if (!Number.isFinite(candidateId) || candidateId <= 0) {
    return null;
  }

  return {
    runId: decodeURIComponent(m[1]),
    candidateId,
  };
}

function setTokenCookie(response: Response, token: string, secure: boolean): Response {
  const headers = new Headers(response.headers);
  const cookieFlags = [
    `${ACCESS_TOKEN_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=1800',
    ...(secure ? ['Secure'] : []),
  ];
  headers.append('Set-Cookie', cookieFlags.join('; '));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function clearTokenCookie(response: Response, secure: boolean): Response {
  const headers = new Headers(response.headers);
  const cookieFlags = [
    `${ACCESS_TOKEN_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
    ...(secure ? ['Secure'] : []),
  ];
  headers.append('Set-Cookie', cookieFlags.join('; '));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function setStateCookie(response: Response, state: string, secure: boolean): Response {
  const headers = new Headers(response.headers);
  const cookieFlags = [
    `${UI_STATE_COOKIE}=${state}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=600',
    ...(secure ? ['Secure'] : []),
  ];
  headers.append('Set-Cookie', cookieFlags.join('; '));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function isProtectedOperationalEndpoint(pathname: string, method: string): boolean {
  if (pathname === '/runs/start' && method === 'POST') {
    return true;
  }

  if (pathname.startsWith('/runs/') && method === 'POST') {
    return true;
  }

  if (pathname === '/runs' && method === 'GET') {
    return true;
  }

  if (pathname.startsWith('/runs/') && method === 'GET') {
    return true;
  }

  if (pathname.includes('/stages/') && method === 'POST') {
    return true;
  }

  return false;
}

export function createFetchHandler(deps: FetchDeps) {
  return async function fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return withCors(new Response(null, { status: 204 }), request);
    }

    const respond = (response: Response): Response => withCors(response, request);

    const routed = await deps.routeRequest(request, env);
    if (routed) {
      return respond(routed);
    }

    function parseCandidateExtractRequeuePath(pathname: string): string | null {
      const m = pathname.match(/^\/runs\/([^/]+)\/stages\/candidate_extract\/requeue$/i);
      return m?.[1] ? decodeURIComponent(m[1]) : null;
    }
    try {
      const pathname = new URL(request.url).pathname;

      if (pathname === '/health' && request.method === 'GET') {
        return respond(json({ ok: true, runtime: 'agents-sdk' }));
      }

      // ── UI auth routes ──────────────────────────────────────────────────────
      const isSecure = new URL(request.url).protocol === 'https:';

          if (pathname.includes('/stages/candidate_extract/requeue') && request.method === 'POST') {
            const runId = parseCandidateExtractRequeuePath(pathname);
            if (!runId) {
              return respond(json({ error: 'Invalid requeue path' }, 400));
            }

            const pendingItems = await listPendingCandidateFetchWorkItems(env.AGENT_DB, runId);
            if (pendingItems.length === 0) {
              return respond(json({ runId, requeued: 0, batches: 0, message: 'No pending candidate jobs to requeue.' }));
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

              await env.CANDIDATE_FETCH_QUEUE.sendBatch(messages);
              batches += 1;
            }

            await logStageEvent(env.AGENT_DB, {
              runId,
              stage: 'candidate_extract',
              level: 'info',
              message: 'candidate requeue requested',
              data: {
                requeued: pendingItems.length,
                batches,
              },
            });

            return respond(json({ runId, requeued: pendingItems.length, batches }));
          }

      if (pathname === '/ui/auth/login' && request.method === 'GET') {
        if (!env.AUTH0_CLIENT_ID) {
          return errorHtml('AUTH0_CLIENT_ID is not configured.', 500);
        }
        const state = makeState();
        const redirectUri = new URL('/ui/auth/callback', request.url).toString();
        const authorizeUrl = new URL(`https://${env.AUTH0_DOMAIN}/authorize`);
        authorizeUrl.searchParams.set('response_type', 'code');
        authorizeUrl.searchParams.set('client_id', env.AUTH0_CLIENT_ID);
        authorizeUrl.searchParams.set('redirect_uri', redirectUri);
        authorizeUrl.searchParams.set('scope', 'openid');
        authorizeUrl.searchParams.set('audience', env.AUTH0_API_AUDIENCE);
        authorizeUrl.searchParams.set('connection', 'google-oauth2');
        authorizeUrl.searchParams.set('state', state);
        const redirect = Response.redirect(authorizeUrl.toString(), 302);
        return setStateCookie(redirect, state, isSecure);
      }

      if (pathname === '/ui/auth/callback' && request.method === 'GET') {
        const url = new URL(request.url);
        const code = url.searchParams.get('code');
        const stateParam = url.searchParams.get('state');
        const expectedState = readCookieValue(request, UI_STATE_COOKIE);

        if (!code || !stateParam || !expectedState || stateParam !== expectedState) {
          return errorHtml('Invalid or expired login attempt. Please try again.', 400);
        }

        try {
          const redirectUri = new URL('/ui/auth/callback', request.url).toString();
          const accessToken = await exchangeCodeForTokens({ code, redirectUri, env });
          await verifyAccessTokenForEditor(accessToken, env);
          const redirect = Response.redirect(new URL('/ui', request.url).toString(), 302);
          return setTokenCookie(redirect, accessToken, isSecure);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return errorHtml(`Login failed: ${msg}`, 403);
        }
      }

      if (pathname === '/ui/auth/logout' && request.method === 'GET') {
        const redirect = Response.redirect(new URL('/ui/auth/login', request.url).toString(), 302);
        return clearTokenCookie(redirect, isSecure);
      }

      // ── UI pages (auth guard) ───────────────────────────────────────────────
      if (pathname === '/ui' || pathname.startsWith('/ui/')) {
        const token = readCookieValue(request, ACCESS_TOKEN_COOKIE);
        if (!token) {
          const loginUrl = new URL('/ui/auth/login', request.url).toString();
          return Response.redirect(loginUrl, 302);
        }

        try {
          await verifyAccessTokenForEditor(token, env);
        } catch {
          const redirect = Response.redirect(new URL('/ui/auth/login', request.url).toString(), 302);
          return clearTokenCookie(redirect, isSecure);
        }

        if (pathname === '/ui' && request.method === 'GET') {
          return runsListHtml();
        }

        if (pathname.startsWith('/ui/') && request.method === 'GET') {
          const uiRunId = parseUiRunPath(pathname);
          if (!uiRunId) return respond(json({ error: 'Invalid UI path' }, 400));
          return runDetailHtml(uiRunId);
        }
      }

      const agent = await deps.getAgent(env);
      const needsAuth = isProtectedOperationalEndpoint(pathname, request.method);

      let reviewedBy: string | null = null;
      if (needsAuth) {
        const payload = await deps.requireEditor(request, env);
        reviewedBy = typeof payload.sub === 'string' ? payload.sub : null;
      }

      if (pathname === '/runs/start' && request.method === 'POST') {
        const result = await agent.startRun();
        return respond(json(result, 202));
      }

      if (pathname === '/runs' && request.method === 'GET') {
        const result = await agent.listRuns();
        return respond(json(result));
      }

      if (pathname.endsWith('/delete') && request.method === 'POST') {
        const runId = parseRunDeletePath(pathname);
        if (!runId) {
          return respond(json({ error: 'Invalid delete path' }, 400));
        }
        const result = await agent.deleteRun(runId);
        return respond(json(result));
      }

      if (pathname.includes('/logs') && request.method === 'GET') {
        const runId = parseLogsPath(pathname);
        if (!runId) {
          return respond(json({ error: 'Invalid logs path' }, 400));
        }
        const events = await deps.getStageEvents(env.AGENT_DB, runId);
        return respond(json({ runId, events }));
      }

      if (pathname.includes('/stages/feed_fetch/cache/') && request.method === 'GET') {
        const parsed = parseStageFeedFetchCachePath(pathname);
        if (!parsed) {
          return respond(json({ error: 'Invalid stage cache path' }, 400));
        }

        const cache = await deps.getFeedFetchCacheEntryById(env.AGENT_DB, parsed.feedId);
        if (!cache) {
          return respond(json({ error: 'Feed not found' }, 404));
        }
        if (!cache.r2_key) {
          return respond(json({ error: 'Feed has no cached payload yet' }, 404));
        }

        const object = await env.AGENT_STORE.get(cache.r2_key);
        if (!object?.body) {
          return respond(json({ error: 'Cached payload not found in object store' }, 404));
        }

        const headers = new Headers();
        headers.set('content-type', cache.content_type ?? 'application/xml; charset=utf-8');
        headers.set('content-disposition', `inline; filename="${cache.feed_id}.xml"`);
        headers.set('x-cache-source', 'r2');
        if (cache.fetched_at) {
          headers.set('x-cache-fetched-at', cache.fetched_at);
        }

        return respond(new Response(object.body, { status: 200, headers }));
      }

      if (isStageFeedFetchCacheByUrlPath(pathname) && request.method === 'GET') {
        const requestUrlRaw = new URL(request.url).searchParams.get('u');
        if (!requestUrlRaw) {
          return respond(json({ error: 'Missing request URL' }, 400));
        }

        let normalizedRequestUrl: string;
        try {
          normalizedRequestUrl = new URL(requestUrlRaw).toString();
        } catch {
          return respond(json({ error: 'Invalid request URL' }, 400));
        }

        const cache = await deps.getFeedFetchCacheEntryByRequestUrl(env.AGENT_DB, normalizedRequestUrl);
        if (!cache) {
          return respond(json({ error: 'Feed not found' }, 404));
        }
        if (!cache.r2_key) {
          return respond(json({ error: 'Feed has no cached payload yet' }, 404));
        }

        const object = await env.AGENT_STORE.get(cache.r2_key);
        if (!object?.body) {
          return respond(json({ error: 'Cached payload not found in object store' }, 404));
        }

        const headers = new Headers();
        headers.set('content-type', cache.content_type ?? 'application/xml; charset=utf-8');
        headers.set('content-disposition', `inline; filename="${cache.feed_id}.xml"`);
        headers.set('x-cache-source', 'r2');
        if (cache.fetched_at) {
          headers.set('x-cache-fetched-at', cache.fetched_at);
        }

        return respond(new Response(object.body, { status: 200, headers }));
      }

      if (pathname.includes('/stages/candidate_extract/cache/') && request.method === 'GET') {
        const parsed = parseStageCandidateExtractCachePath(pathname);
        if (!parsed) {
          return respond(json({ error: 'Invalid candidate cache path' }, 400));
        }

        const candidate = await deps.getCandidateArticleEntryById(env.AGENT_DB, parsed.runId, parsed.candidateId);
        if (!candidate) {
          return respond(json({ error: 'Candidate not found' }, 404));
        }
        if (!candidate.article_r2_key) {
          return respond(json({ error: 'Candidate has no cached article yet' }, 404));
        }

        const object = await env.AGENT_STORE.get(candidate.article_r2_key);
        if (!object?.body) {
          return respond(json({ error: 'Cached article not found in object store' }, 404));
        }

        const headers = new Headers();
        headers.set('content-type', object.httpMetadata?.contentType ?? 'text/html; charset=utf-8');
        headers.set('content-disposition', `inline; filename="candidate-${candidate.id}.html"`);
        headers.set('x-cache-source', 'r2');
        return respond(new Response(object.body, { status: 200, headers }));
      }

      if (pathname.includes('/stages/feed_fetch') && request.method === 'GET') {
        const runId = parseStageFeedFetchPath(pathname);
        if (!runId) {
          return respond(json({ error: 'Invalid stage path' }, 400));
        }
        const run = await agent.getRun(runId);
        const results = await deps.getFeedFetchResults(env.AGENT_DB);
        return respond(json({ runId, run, results }));
      }

      if (pathname.includes('/stages/candidate_extract') && request.method === 'GET') {
        const runId = parseStageCandidateExtractPath(pathname);
        if (!runId) {
          return respond(json({ error: 'Invalid stage path' }, 400));
        }
        const run = await agent.getRun(runId);
        const results = await deps.getCandidateExtractResults(env.AGENT_DB, runId);
        return respond(json({ runId, run, results }));
      }

      if (pathname.startsWith('/runs/') && request.method === 'GET') {
        const runId = parseRunId(pathname);
        if (!runId) {
          return respond(json({ error: 'Invalid run path' }, 400));
        }
        const result = await agent.getRun(runId);
        return respond(json(result));
      }

      if (pathname.includes('/stages/') && request.method === 'POST') {
        const parsed = parseStageAction(pathname);
        if (!parsed) {
          return respond(json({ error: 'Invalid stage path' }, 400));
        }

        const body = (await request.json().catch(() => ({}))) as { notes?: unknown };
        const notes = typeof body.notes === 'string' ? body.notes : null;

        if (parsed.action === 'approve') {
          const result = await agent.approveStage(parsed.runId, parsed.stage, notes, reviewedBy);
          return respond(json(result, 202));
        }

        const result = await agent.rejectStage(parsed.runId, parsed.stage, notes, reviewedBy);
        return respond(json(result, 202));
      }

      return respond(json({ error: 'Not found' }, 404));
    } catch (error) {
      if (error instanceof Response) {
        return respond(error);
      }
      const message = error instanceof Error ? error.message : String(error);
      return respond(json({ error: message }, 500));
    }
  };
}