import {
  app,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from '@azure/functions';

type StubStory = {
  id: string;
  headline: string;
  status: 'draft' | 'published';
  author: string;
  updatedAt: string;
};

function getCorrelationId(request: HttpRequest, context: InvocationContext): string {
  return request.headers.get('x-correlation-id') ?? context.invocationId;
}

function responseWithCorrelation(
  status: number,
  jsonBody: Record<string, unknown>,
  correlationId: string,
): HttpResponseInit {
  return {
    status,
    jsonBody,
    headers: {
      'Content-Type': 'application/json',
      'X-Correlation-ID': correlationId,
      'Cache-Control': 'no-store',
    },
  };
}

const stubStories: StubStory[] = [
  {
    id: 'story-001',
    headline: 'Stub story from Azure Functions',
    status: 'draft',
    author: 'system',
    updatedAt: '2026-04-02T00:00:00.000Z',
  },
  {
    id: 'story-002',
    headline: 'Published story placeholder',
    status: 'published',
    author: 'system',
    updatedAt: '2026-04-02T00:00:00.000Z',
  },
];

app.http('editorialHealth', {
  route: 'health',
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> => {
    const correlationId = getCorrelationId(request, context);
    context.info('editorialHealth', {
      correlationId,
      method: request.method,
      url: request.url,
    });

    return responseWithCorrelation(
      200,
      {
        ok: true,
        stub: true,
        service: 'editorial-api',
        route: '/health',
        correlationId,
        timestamp: new Date().toISOString(),
      },
      correlationId,
    );
  },
});

app.http('editorialStoriesList', {
  route: 'stories',
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> => {
    const correlationId = getCorrelationId(request, context);
    context.info('editorialStoriesList', {
      correlationId,
      method: request.method,
      url: request.url,
    });

    return responseWithCorrelation(
      200,
      {
        stub: true,
        route: '/stories',
        count: stubStories.length,
        items: stubStories,
        correlationId,
      },
      correlationId,
    );
  },
});

app.http('editorialStoryById', {
  route: 'stories/{id}',
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> => {
    const correlationId = getCorrelationId(request, context);
    const { id = '' } = request.params;
    const story = stubStories.find((item) => item.id === id);

    context.info('editorialStoryById', {
      correlationId,
      id,
      method: request.method,
      url: request.url,
    });

    if (!story) {
      return responseWithCorrelation(
        404,
        {
          stub: true,
          route: `/stories/${id}`,
          message: 'Story not found in stub backend.',
          correlationId,
        },
        correlationId,
      );
    }

    return responseWithCorrelation(
      200,
      {
        stub: true,
        route: `/stories/${id}`,
        item: story,
        correlationId,
      },
      correlationId,
    );
  },
});

app.http('editorialStoriesSearch', {
  route: 'stories/search',
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> => {
    const correlationId = getCorrelationId(request, context);
    const query = request.query.get('q') ?? '';

    context.info('editorialStoriesSearch', {
      correlationId,
      query,
      method: request.method,
      url: request.url,
    });

    const items = query
      ? stubStories.filter((item) => item.headline.toLowerCase().includes(query.toLowerCase()))
      : stubStories;

    return responseWithCorrelation(
      200,
      {
        stub: true,
        route: '/stories/search',
        query,
        count: items.length,
        items,
        correlationId,
      },
      correlationId,
    );
  },
});
