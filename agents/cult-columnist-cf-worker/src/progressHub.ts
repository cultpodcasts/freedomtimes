type Subscriber = {
  socket: WebSocket;
  runId: string;
  candidateId: number | null;
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json',
    },
  });
}

export class RunProgressHub {
  private state: DurableObjectState;
  private subscribers = new Set<Subscriber>();

  constructor(ctx: DurableObjectState, env: unknown) {
    this.state = ctx;
    void env;
  }

  private removeSocket(socket: WebSocket): void {
    for (const sub of this.subscribers) {
      if (sub.socket === socket) {
        this.subscribers.delete(sub);
      }
    }
  }

  private broadcast(payload: Record<string, unknown>): void {
    const message = JSON.stringify(payload);
    for (const sub of this.subscribers) {
      if (payload.runId !== sub.runId) {
        continue;
      }

      const payloadCandidateId = typeof payload.candidateId === 'number' ? payload.candidateId : null;
      if (sub.candidateId !== null && sub.candidateId !== payloadCandidateId) {
        continue;
      }

      try {
        sub.socket.send(message);
      } catch {
        this.subscribers.delete(sub);
      }
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/subscribe' && request.method === 'GET') {
      const runId = url.searchParams.get('runId');
      if (!runId) {
        return jsonResponse({ error: 'Missing runId' }, 400);
      }

      const upgrade = request.headers.get('Upgrade');
      if (!upgrade || upgrade.toLowerCase() !== 'websocket') {
        return new Response('Expected WebSocket upgrade', { status: 426 });
      }

      const candidateIdRaw = url.searchParams.get('candidateId');
      let candidateId: number | null = null;
      if (candidateIdRaw) {
        const parsed = Number.parseInt(candidateIdRaw, 10);
        if (Number.isFinite(parsed) && parsed > 0) {
          candidateId = parsed;
        }
      }

      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      server.accept();

      const sub: Subscriber = { socket: server, runId, candidateId };
      this.subscribers.add(sub);

      server.addEventListener('close', () => this.removeSocket(server));
      server.addEventListener('error', () => this.removeSocket(server));

      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === '/publish' && request.method === 'POST') {
      const body = (await request.json().catch(() => null)) as
        | { runId?: unknown; candidateId?: unknown; outcome?: unknown; pendingRemaining?: unknown; candidate?: unknown }
        | null;

      if (!body || typeof body.runId !== 'string' || typeof body.candidateId !== 'number') {
        return jsonResponse({ error: 'Invalid payload' }, 400);
      }

      this.broadcast({
        type: 'candidate-update',
        runId: body.runId,
        candidateId: body.candidateId,
        outcome: typeof body.outcome === 'string' ? body.outcome : 'unknown',
        pendingRemaining: typeof body.pendingRemaining === 'number' ? body.pendingRemaining : null,
        candidate: body.candidate ?? null,
        at: new Date().toISOString(),
      });

      return jsonResponse({ ok: true });
    }

    return jsonResponse({ error: 'Not found' }, 404);
  }
}
