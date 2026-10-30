import type { APIRoute } from 'astro';
import { env as cfEnv } from 'cloudflare:workers';

import { BUILD_COMMIT_SHA } from '../../lib/build-provenance';
import {
  buildDeployProvenancePayload,
  isDeployProvenanceRequestAuthorized,
} from '../../lib/deploy-provenance';
import { authorizeReaderApiRequest } from '../../lib/editorial-session';

export const prerender = false;

const HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
} as const;

/**
 * Deploy provenance (issue #142): a hash of the Turso host this Worker reads, so the
 * production deploy can prove it backed up and migrated the DB the live Worker uses.
 * Never returns the hostname, URL or any token. See src/lib/deploy-provenance.ts.
 */
export const GET: APIRoute = async ({ cookies, request, url }) => {
  // Locked staging: Auth0 session required, like every PUBLIC_READER_PATHS route.
  const auth = await authorizeReaderApiRequest({ cookies, request, url });
  if (auth instanceof Response) {
    return auth;
  }

  const runtimeEnv = cfEnv as Record<string, string | undefined>;
  if (!isDeployProvenanceRequestAuthorized(runtimeEnv.DEPLOY_PROVENANCE_TOKEN, request.headers.get('authorization'))) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: HEADERS });
  }

  // Same source the libsql shim prefers at runtime (src/shims/kysely-libsql.ts).
  const payload = await buildDeployProvenancePayload({
    tursoDatabaseUrl: runtimeEnv.TURSO_DATABASE_URL,
    commitSha: BUILD_COMMIT_SHA,
  });
  return new Response(JSON.stringify(payload), { status: 200, headers: HEADERS });
};
