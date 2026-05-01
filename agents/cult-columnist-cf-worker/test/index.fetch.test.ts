import { describe, expect, it, vi } from 'vitest';
import { createFetchHandler } from '../src/httpHandler';

function createEnv() {
  return {
    ORCHESTRATOR: {},
    AGENT_DB: {},
    AUTH0_DOMAIN: 'test.auth0.com',
    AUTH0_API_AUDIENCE: 'test-audience',
    AUTH0_ROLES_CLAIM_NAMESPACE: 'roles',
  } as any;
}

describe('createFetchHandler', () => {
  it('returns 403 and does not call listRuns when auth rejects the request', async () => {
    const listRuns = vi.fn().mockResolvedValue({ runs: [] });
    const handler = createFetchHandler({
      routeRequest: vi.fn().mockResolvedValue(null),
      getAgent: vi.fn().mockResolvedValue({
        startRun: vi.fn(),
        listRuns,
        getRun: vi.fn(),
        approveStage: vi.fn(),
        rejectStage: vi.fn(),
      }),
      requireEditor: vi.fn().mockRejectedValue(
        new Response(JSON.stringify({ error: 'Forbidden' }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        }),
      ),
      getStageEvents: vi.fn(),
    });

    const response = await handler(
      new Request('http://example.test/runs', {
        method: 'GET',
        headers: { authorization: 'Bearer test-viewer-token' },
      }),
      createEnv(),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: 'Forbidden' });
    expect(listRuns).not.toHaveBeenCalled();
  });

  it('calls listRuns for an authorized request', async () => {
    const listRuns = vi.fn().mockResolvedValue({ runs: [{ id: 'run-1' }] });
    const handler = createFetchHandler({
      routeRequest: vi.fn().mockResolvedValue(null),
      getAgent: vi.fn().mockResolvedValue({
        startRun: vi.fn(),
        listRuns,
        getRun: vi.fn(),
        approveStage: vi.fn(),
        rejectStage: vi.fn(),
      }),
      requireEditor: vi.fn().mockResolvedValue({ sub: 'editor-user' }),
      getStageEvents: vi.fn(),
    });

    const response = await handler(
      new Request('http://example.test/runs', {
        method: 'GET',
        headers: { authorization: 'Bearer test-editor-token' },
      }),
      createEnv(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ runs: [{ id: 'run-1' }] });
    expect(listRuns).toHaveBeenCalledTimes(1);
  });
});