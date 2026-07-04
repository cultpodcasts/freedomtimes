import type { APIRoute } from 'astro';

import { buildProvenancePayload } from '../../lib/build-provenance';
import { authorizeReaderApiRequest } from '../../lib/editorial-session';

export const prerender = false;

export const GET: APIRoute = async ({ cookies, request, url }) => {
  const auth = await authorizeReaderApiRequest({ cookies, request, url });
  if (auth instanceof Response) {
    return auth;
  }

  return new Response(JSON.stringify(buildProvenancePayload()), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=300',
    },
  });
};
