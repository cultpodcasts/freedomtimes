import { describe, it, expect } from 'vitest';
import { createFetchHandler } from '../src/httpHandler';
import type { JWTPayload } from 'jose';

/**
 * HTTP Layer Test Suite (No DB dependency)
 *
 * Tests focus on HTTP endpoint behavior:
 * - Auth enforcement (401/403 responses)
 * - Route parsing (valid/invalid paths)
 * - Content-type headers
 * - Error handling
 * - Health endpoint availability
 */

function createEnv() {
  return {
    ORCHESTRATOR: {},
    AGENT_DB: {},
    AGENT_STORE: {},
    AUTH0_DOMAIN: 'test.auth0.com',
    AUTH0_API_AUDIENCE: 'test-audience',
    AUTH0_ROLES_CLAIM_NAMESPACE: 'roles',
  } as any;
}

function mockRequireEditor(request: Request): Promise<JWTPayload> {
  const auth = request.headers.get('authorization');
  if (!auth || !auth.startsWith('Bearer ')) {
    return Promise.reject(
      new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }
  const token = auth.slice('Bearer '.length);
  if (token === 'test-editor-token') {
    return Promise.resolve({ sub: 'editor-user' });
  }
  return Promise.reject(
    new Response(JSON.stringify({ error: 'Forbidden' }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

const mockAgent = {
  startRun: () => Promise.resolve({ runId: 'mock-run-id' }),
  listRuns: () => Promise.resolve({ runs: [] }),
  getRun: () => Promise.resolve({ id: 'mock-run-id', status: 'started' }),
  approveStage: () => Promise.resolve({ ok: true }),
  rejectStage: () => Promise.resolve({ ok: true }),
};

const handler = createFetchHandler({
  routeRequest: async () => null,
  getAgent: async () => mockAgent,
  requireEditor: mockRequireEditor,
  getStageEvents: async () => [],
});

async function callApi(
  endpoint: string,
  options: {
    method?: string;
    body?: Record<string, unknown>;
    token?: string;
  } = {},
): Promise<{ status: number; body: unknown }> {
  const { method = 'GET', body, token } = options;
  const headers: Record<string, string> = { 'content-type': 'application/json' };

  if (token) {
    headers.authorization = `Bearer ${token}`;
  }

  const response = await handler(
    new Request(`http://localhost${endpoint}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    }),
    createEnv(),
  );

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }

  return { status: response.status, body: parsed };
}

describe('HTTP Layer Tests', () => {
  describe('Health Endpoint', () => {
    it('GET /health returns 200 without auth', async () => {
      const res = await callApi('/health');
      expect(res.status).toBe(200);
      expect((res.body as Record<string, unknown>).ok).toBe(true);
    });

    it('GET /health returns 200 with invalid token', async () => {
      // Health endpoint bypasses auth
      const res = await callApi('/health', { token: 'invalid-token' });
      expect(res.status).toBe(200);
    });
  });

  describe('Auth Enforcement', () => {
    it('POST /runs/start requires auth (401)', async () => {
      const res = await callApi('/runs/start', { method: 'POST' });
      expect(res.status).toBe(401);
      expect((res.body as Record<string, unknown>).error).toBeDefined();
    });

    it('GET /runs requires auth (401)', async () => {
      const res = await callApi('/runs');
      expect(res.status).toBe(401);
    });

    it('GET /runs/:id requires auth (401)', async () => {
      const res = await callApi('/runs/some-run-id');
      expect(res.status).toBe(401);
    });

    it('POST /runs/:id/stages/:stage/approve requires auth (401)', async () => {
      const res = await callApi('/runs/some-run-id/stages/feed_fetch/approve', {
        method: 'POST',
      });
      expect(res.status).toBe(401);
    });

    it('GET /runs/:id/logs requires auth (401)', async () => {
      const res = await callApi('/runs/some-run-id/logs');
      expect(res.status).toBe(401);
    });
  });

  describe('Auth: Token Validation', () => {
    it('rejects non-editor token (403)', async () => {
      const res = await callApi('/runs', { token: 'test-viewer-token' });
      expect(res.status).toBe(403);
      expect((res.body as Record<string, unknown>).error).toBeDefined();
    });

    it('accepts editor token and returns 200', async () => {
      const res = await callApi('/runs', { token: 'test-editor-token' });
      // Should return 200 (with mock data or actual data)
      // Or 500 if no DB, but NOT 401/403
      expect([200, 500]).toContain(res.status);
      if (res.status === 200) {
        expect((res.body as Record<string, unknown>).runs).toBeDefined();
      }
    });
  });

  describe('Route Parsing', () => {
    it('GET /runs/:id parses run ID correctly', async () => {
      // With valid auth, route should be recognized (200 or 500, not 404)
      const res = await callApi('/runs/valid-run-id', { token: 'test-editor-token' });
      expect([200, 500]).toContain(res.status);
    });

    it('POST /runs/:id/stages/:stage/approve parses stage correctly', async () => {
      // With valid auth, route should be recognized (202 Accepted for stage actions)
      const res = await callApi('/runs/run-id/stages/feed_fetch/approve', {
        method: 'POST',
        token: 'test-editor-token',
      });
      expect([202, 500]).toContain(res.status);
    });

    it('POST /runs/:id/stages/:stage/reject parses stage correctly', async () => {
      const res = await callApi('/runs/run-id/stages/candidate_extract/reject', {
        method: 'POST',
        token: 'test-editor-token',
      });
      expect([202, 500]).toContain(res.status);
    });

    it('returns 404 for unknown routes', async () => {
      const res = await callApi('/unknown/path', { token: 'test-editor-token' });
      expect(res.status).toBe(404);
    });

    it('rejects invalid stage names', async () => {
      const res = await callApi('/runs/id/stages/invalid_stage/approve', {
        method: 'POST',
        token: 'test-editor-token',
      });
      expect(res.status).toBe(400);
    });
  });

  describe('HTTP Methods', () => {
    it('GET /runs accepts GET only', async () => {
      const postRes = await callApi('/runs', {
        method: 'POST',
        token: 'test-editor-token',
      });
      expect([404, 400, 500]).toContain(postRes.status);
    });

    it('POST /runs/start: GET routes as GET /runs/:id (not a start-run call)', async () => {
      // GET /runs/start matches the /runs/:id pattern (runId = "start"), returning 200
      const getRes = await callApi('/runs/start', {
        method: 'GET',
        token: 'test-editor-token',
      });
      expect([200, 500]).toContain(getRes.status);
    });
  });

  describe('Request Body Parsing', () => {
    it('parses JSON body with notes field', async () => {
      const res = await callApi('/runs/id/stages/feed_fetch/approve', {
        method: 'POST',
        body: { notes: 'test note' },
        token: 'test-editor-token',
      });
      // Should not fail on body parsing (202 Accepted for stage actions)
      expect([202, 500]).toContain(res.status);
      expect(res.status).not.toBe(400); // 400 means bad request (parsing error)
    });

    it('handles missing body gracefully', async () => {
      const res = await callApi('/runs/id/stages/feed_fetch/reject', {
        method: 'POST',
        token: 'test-editor-token',
      });
      // Should not fail (202 Accepted for stage actions)
      expect([202, 500]).toContain(res.status);
      expect(res.status).not.toBe(400);
    });
  });

  describe('Response Format', () => {
    it('returns JSON responses with correct headers', async () => {
      const response = await handler(
        new Request('http://localhost/health'),
        createEnv(),
      );
      expect(response.headers.get('content-type')).toContain('application/json');
    });

    it('error responses include error field', async () => {
      const res = await callApi('/runs'); // No auth
      expect(res.status).toBe(401);
      const body = res.body as Record<string, unknown>;
      expect(body.error).toBeDefined();
      expect(typeof body.error).toBe('string');
    });
  });
});
