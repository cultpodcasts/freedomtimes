import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DEPLOY_PROVENANCE_PATH,
  buildDeployProvenancePayload,
  isDeployProvenanceRequestAuthorized,
  libsqlHostname,
  tursoHostProvenanceHash,
} from '../src/lib/deploy-provenance.ts';

// Shared vector: scripts/test-deploy-cloud-agent-guards.ps1 asserts the same hex for the same host.
const HOST = 'freedomtimes-emdash-production-org.aws-eu-west-1.turso.io';
const HOST_HASH = '642dfdbffe3ada3de0c2611f4095b3cae12e30b36886b7619fa5251c4e2f52bb';
const DR_HOST = 'freedomtimes-emdash-production-dr-org.aws-eu-west-1.turso.io';

describe('deploy provenance (#142)', () => {
  it('normalises libsql URLs like Get-DeployLibsqlHostname', () => {
    assert.equal(libsqlHostname(`libsql://${HOST}`), HOST);
    assert.equal(libsqlHostname(`  LIBSQL://${HOST.toUpperCase()}/?tls=1 `), HOST);
    assert.equal(libsqlHostname(`https://user@${HOST}//`), HOST);
    assert.equal(libsqlHostname(''), '');
    assert.equal(libsqlHostname(undefined), '');
  });

  it('hashes the host with the shared domain-separated vector', async () => {
    assert.equal(await tursoHostProvenanceHash(HOST), HOST_HASH);
    assert.equal(await tursoHostProvenanceHash(HOST.toUpperCase()), HOST_HASH);
    assert.notEqual(await tursoHostProvenanceHash(DR_HOST), HOST_HASH);
    assert.equal(await tursoHostProvenanceHash(''), null);
  });

  it('payload carries only schema, commit and hash (never the hostname or URL)', async () => {
    const payload = await buildDeployProvenancePayload({
      tursoDatabaseUrl: `libsql://${HOST}`,
      commitSha: 'abc1234',
    });
    assert.deepEqual(Object.keys(payload).sort(), ['commitSha', 'schema', 'tursoHostSha256']);
    assert.equal(payload.tursoHostSha256, HOST_HASH);
    assert.equal(JSON.stringify(payload).includes('turso.io'), false);
    const missing = await buildDeployProvenancePayload({ tursoDatabaseUrl: undefined, commitSha: 'x' });
    assert.equal(missing.tursoHostSha256, null);
  });

  it('optional bearer gate', () => {
    assert.equal(isDeployProvenanceRequestAuthorized(undefined, null), true);
    assert.equal(isDeployProvenanceRequestAuthorized('', 'Bearer anything'), true);
    assert.equal(isDeployProvenanceRequestAuthorized('s3cret-value', null), false);
    assert.equal(isDeployProvenanceRequestAuthorized('s3cret-value', 'Bearer wrong'), false);
    assert.equal(isDeployProvenanceRequestAuthorized('s3cret-value', 'Bearer '), false);
    assert.equal(isDeployProvenanceRequestAuthorized('s3cret-value', 'bearer s3cret-value'), true);
  });

  it('route is production-public (locked staging still needs Auth0) and never cacheable', () => {
    // auth.ts imports cloudflare:workers (not loadable under node), so check its source.
    const auth = readFileSync(fileURLToPath(new URL('../src/lib/auth.ts', import.meta.url)), 'utf8');
    const readerPaths = auth.match(/PUBLIC_READER_PATHS\b[^=]*=\s*\[([\s\S]*?)\]/);
    assert.ok(readerPaths, 'PUBLIC_READER_PATHS not found in auth.ts');
    assert.ok(readerPaths[1].includes(`'${DEPLOY_PROVENANCE_PATH}'`));
    const route = readFileSync(
      fileURLToPath(new URL('../src/pages/api/deploy-provenance.json.ts', import.meta.url)),
      'utf8',
    );
    assert.match(route, /authorizeReaderApiRequest/);
    assert.match(route, /'cache-control': 'no-store'/);
    assert.match(route, /runtimeEnv\.TURSO_DATABASE_URL/);
  });
});
