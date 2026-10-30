/**
 * Deploy provenance for CI (issue #142).
 *
 * `deploy-worker.yml` backs up and migrates the production EmDash DB named by a GitHub
 * secret. That proves nothing about the DB the live production Worker actually reads (its own
 * `TURSO_DATABASE_URL` Worker secret). `GET /api/deploy-provenance.json` closes the gap: it
 * reports a SHA-256 of the Worker's Turso hostname, and the deploy refuses to migrate or
 * deploy unless that hash equals the hash of the backed-up `workerTursoHost`.
 *
 * Exposed: only the hash and the build commit. Never the hostname, URL or any token.
 * The hash is domain-separated so it is not a bare `sha256(hostname)` lookup value.
 *
 * Mirrored by `Get-DeployLibsqlHostname` + `Get-DeployTursoHostProvenanceHash` in
 * `scripts/Deploy-EnvironmentCommon.ps1`. Keep both in step: the shared test vector in
 * `web/scripts/test-deploy-provenance.mts` and `scripts/test-deploy-cloud-agent-guards.ps1`
 * must produce the same hex string.
 */

export const DEPLOY_PROVENANCE_PATH = '/api/deploy-provenance.json';

/** Prefix hashed in front of the hostname. Bump the version if the format ever changes. */
export const TURSO_HOST_HASH_DOMAIN = 'freedomtimes-turso-host-v1:';

export const DEPLOY_PROVENANCE_SCHEMA = 1;

/**
 * Hostname of a libsql/https Turso URL, lower-cased. Same rules as the PowerShell
 * `Get-DeployLibsqlHostname`: strip `libsql://` / `https://`, the query string, any
 * `user@` prefix and trailing slashes. Empty string when there is no URL.
 */
export function libsqlHostname(url: string | null | undefined): string {
  if (typeof url !== 'string' || url.trim() === '') {
    return '';
  }
  let host = url.trim().replace(/^libsql:\/\//i, '').replace(/^https:\/\//i, '');
  host = host.split('?')[0] ?? '';
  const at = host.lastIndexOf('@');
  if (at >= 0) {
    host = host.slice(at + 1);
  }
  return host.replace(/\/+$/, '').toLowerCase();
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Lower-case hex SHA-256 of `TURSO_HOST_HASH_DOMAIN + host`, or null for an empty host. */
export async function tursoHostProvenanceHash(host: string): Promise<string | null> {
  const normalized = host.trim().toLowerCase();
  if (normalized === '') {
    return null;
  }
  const bytes = new TextEncoder().encode(`${TURSO_HOST_HASH_DOMAIN}${normalized}`);
  return toHex(await crypto.subtle.digest('SHA-256', bytes));
}

function timingSafeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

/**
 * Optional bearer gate. When the Worker has a `DEPLOY_PROVENANCE_TOKEN` secret, the request
 * must send `Authorization: Bearer <that token>`. Without the secret the endpoint is open
 * (production only; locked staging still needs an Auth0 session), because it only returns a hash.
 */
export function isDeployProvenanceRequestAuthorized(
  expectedToken: string | null | undefined,
  authorizationHeader: string | null | undefined,
): boolean {
  const expected = (expectedToken ?? '').trim();
  if (expected === '') {
    return true;
  }
  const match = /^Bearer\s+(.+)$/i.exec((authorizationHeader ?? '').trim());
  const presented = match?.[1]?.trim() ?? '';
  return presented !== '' && timingSafeEqual(presented, expected);
}

export type DeployProvenancePayload = {
  schema: number;
  commitSha: string;
  /** null when the Worker has no `TURSO_DATABASE_URL` (CI treats that as a failure). */
  tursoHostSha256: string | null;
};

export async function buildDeployProvenancePayload(params: {
  tursoDatabaseUrl: string | null | undefined;
  commitSha: string;
}): Promise<DeployProvenancePayload> {
  return {
    schema: DEPLOY_PROVENANCE_SCHEMA,
    commitSha: params.commitSha,
    tursoHostSha256: await tursoHostProvenanceHash(libsqlHostname(params.tursoDatabaseUrl)),
  };
}
