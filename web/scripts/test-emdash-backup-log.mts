import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  BACKUP_LOG_SCHEMA_VERSION,
  buildBackupLog,
  normalizeLiveProvenanceCheck,
} from './write-emdash-backup-log.mjs';

const payload = {
  createdAtUtc: '2026-10-31T08:00:00.000Z',
  environment: 'production',
  sourceDatabase: 'freedomtimes-emdash-production',
  workerTursoHost: 'freedomtimes-emdash-production-org.aws-eu-west-1.turso.io',
  destination: { tursoBranch: 'prod-backup-20261031-080000', localFile: null },
  posts: { raw: 10, active: 9, published: 8, draft: 1, deleted: 1 },
  postCount: 8,
  weeklySlugsSample: ['weekly-1'],
  verificationPass: true,
  liveProvenanceCheck: 'match',
  resolveSource: 'worker-proxy',
  notes: 'test',
};
const opts = { environment: 'production', createdAtUtc: payload.createdAtUtc, fileName: 'prod-emdash-20261031-080000.json' };

describe('emdash backup agents log (#154)', () => {
  it('records liveProvenanceCheck and resolveSource (schemaVersion 2)', () => {
    const log = buildBackupLog(payload, opts);
    assert.equal(BACKUP_LOG_SCHEMA_VERSION, 2);
    assert.equal(log.schemaVersion, 2);
    assert.equal(log.liveProvenanceCheck, 'match');
    assert.equal(log.resolveSource, 'worker-proxy');
    assert.equal(log.verificationPass, true);
    assert.equal(log.destination.tursoBranch, 'prod-backup-20261031-080000');
  });

  it('keeps an unproven source visible (bootstrap / skipped)', () => {
    assert.equal(buildBackupLog({ ...payload, liveProvenanceCheck: 'bootstrap' }, opts).liveProvenanceCheck, 'bootstrap');
    assert.equal(buildBackupLog({ ...payload, liveProvenanceCheck: 'Skipped' }, opts).liveProvenanceCheck, 'skipped');
  });

  it('writes null when the payload has no provenance fields', () => {
    const { liveProvenanceCheck: _a, resolveSource: _b, ...old } = payload;
    const log = buildBackupLog(old, opts);
    assert.equal(log.liveProvenanceCheck, null);
    assert.equal(log.resolveSource, null);
  });

  it('refuses an unknown liveProvenanceCheck value', () => {
    assert.throws(() => normalizeLiveProvenanceCheck('proven'), /Invalid liveProvenanceCheck/);
    assert.throws(() => buildBackupLog({ ...payload, liveProvenanceCheck: 'yes' }, opts), /Invalid liveProvenanceCheck/);
    assert.equal(normalizeLiveProvenanceCheck(''), null);
  });

  it('still strips secret-looking keys', () => {
    const log = buildBackupLog({ ...payload, posts: { ...payload.posts, authToken: 'x' } }, opts) as Record<string, any>;
    assert.equal(JSON.stringify(log).includes('authToken'), false);
  });

  it('CLI writes both fields into data/backups', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ft-backup-log-'));
    try {
      const payloadPath = path.join(dir, 'payload.json');
      writeFileSync(payloadPath, JSON.stringify(payload));
      const script = fileURLToPath(new URL('./write-emdash-backup-log.mjs', import.meta.url));
      const out = execFileSync(process.execPath, [script, '--from-json', payloadPath, '--stamp', '20261031-080000', '--agents-dir', dir], {
        encoding: 'utf8',
      }).trim();
      assert.equal(path.basename(out), 'prod-emdash-20261031-080000.json');
      const written = JSON.parse(readFileSync(out, 'utf8'));
      assert.equal(written.liveProvenanceCheck, 'match');
      assert.equal(written.resolveSource, 'worker-proxy');
      assert.equal(written.schemaVersion, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
