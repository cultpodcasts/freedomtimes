/**
 * PR #198: content backend single source of truth (web/wrangler.jsonc) + Turso bypass decision.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
	buildTursoBypassWarning,
	isTruthyFlag,
	normalizeContentBackend,
	readWranglerContentBackend,
	resolveContentBackendDecision,
} from './lib/content-backend.mjs';

const wrangler = (envBlock: Record<string, unknown>) => JSON.stringify({ env: { staging: envBlock } });
const D1_BINDING = { d1_databases: [{ binding: 'EMDASH', database_id: 'x' }] };

describe('normalizeContentBackend', () => {
	it('accepts d1 / turso case-insensitively and treats blank as unset', () => {
		assert.equal(normalizeContentBackend(' D1 '), 'd1');
		assert.equal(normalizeContentBackend('Turso'), 'turso');
		assert.equal(normalizeContentBackend(''), null);
		assert.equal(normalizeContentBackend(undefined), null);
	});
	it('rejects anything else', () => {
		assert.throws(() => normalizeContentBackend('sqlite'), /must be "d1" or "turso"/);
	});
});

describe('isTruthyFlag', () => {
	it('only explicit truthy values enable FT_SKIP_TURSO', () => {
		for (const v of ['1', 'true', 'YES', 'on']) assert.equal(isTruthyFlag(v), true, v);
		for (const v of [undefined, '', '0', 'false', 'no']) assert.equal(isTruthyFlag(v), false, String(v));
	});
});

describe('readWranglerContentBackend', () => {
	it('defaults to turso when the env sets no FT_CONTENT_BACKEND var', () => {
		assert.equal(readWranglerContentBackend(wrangler({ vars: {} }), 'staging'), 'turso');
	});
	it('reads d1 when the EMDASH D1 binding exists', () => {
		assert.equal(readWranglerContentBackend(wrangler({ vars: { FT_CONTENT_BACKEND: 'd1' }, ...D1_BINDING }), 'staging'), 'd1');
	});
	it('fails closed for d1 without the EMDASH binding', () => {
		assert.throws(() => readWranglerContentBackend(wrangler({ vars: { FT_CONTENT_BACKEND: 'd1' } }), 'staging'), /no d1_databases binding "EMDASH"/);
	});
	it('fails for an unknown env', () => {
		assert.throws(() => readWranglerContentBackend(wrangler({}), 'production'), /no env\.production block/);
	});
	it('the committed wrangler.jsonc resolves for both deployed envs', () => {
		const text = readFileSync(fileURLToPath(new URL('../wrangler.jsonc', import.meta.url)), 'utf8');
		for (const env of ['staging', 'production']) {
			assert.match(readWranglerContentBackend(text, env), /^(d1|turso)$/);
		}
	});
});

describe('resolveContentBackendDecision', () => {
	it('turso backend without the flag runs every Turso step', () => {
		const d = resolveContentBackendDecision({ envName: 'staging', wranglerBackend: 'turso', env: {} });
		assert.deepEqual(d, { envName: 'staging', backend: 'turso', skipTurso: false, forced: false, reasons: [] });
	});
	it('d1 backend implies the bypass (content DB is not on Turso)', () => {
		const d = resolveContentBackendDecision({ envName: 'production', wranglerBackend: 'd1', env: {} });
		assert.equal(d.skipTurso, true);
		assert.equal(d.forced, false);
		assert.match(d.reasons[0], /FT_CONTENT_BACKEND=d1/);
	});
	it('FT_SKIP_TURSO=1 forces the bypass even on turso', () => {
		const d = resolveContentBackendDecision({ envName: 'staging', wranglerBackend: 'turso', env: { FT_SKIP_TURSO: '1' } });
		assert.equal(d.skipTurso, true);
		assert.equal(d.forced, true);
		assert.match(d.reasons.join(' '), /FT_SKIP_TURSO=1/);
	});
	it('an explicit FT_CONTENT_BACKEND that disagrees with wrangler fails closed', () => {
		assert.throws(
			() => resolveContentBackendDecision({ envName: 'staging', wranglerBackend: 'd1', env: { FT_CONTENT_BACKEND: 'turso' } }),
			/disagrees with web\/wrangler\.jsonc/,
		);
	});
	it('an explicit FT_CONTENT_BACKEND that agrees is accepted', () => {
		const d = resolveContentBackendDecision({ envName: 'staging', wranglerBackend: 'd1', env: { FT_CONTENT_BACKEND: 'D1' } });
		assert.equal(d.backend, 'd1');
	});
});

describe('buildTursoBypassWarning', () => {
	it('is loud and names what was skipped and why', () => {
		const w = buildTursoBypassWarning({ envName: 'staging', backend: 'd1', reasons: ['because'] });
		assert.equal(w.title, 'TURSO STEPS BYPASSED (staging)');
		assert.match(w.line, /no Turso backup/);
		assert.match(w.line, /Reason: because/);
		assert.match(w.details, /Time Travel/);
	});
	it('warns harder when the backend is still Turso', () => {
		const w = buildTursoBypassWarning({ envName: 'production', backend: 'turso', reasons: ['FT_SKIP_TURSO=1 is set'] });
		assert.match(w.details, /NO verified Turso backup/);
	});
});

describe('workflows call the resolver from a path that exists (PR #198 CI regression)', () => {
	const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
	for (const workflow of ['deploy-worker.yml', 'terraform-staging.yml', 'terraform-production.yml']) {
		it(workflow, () => {
			const text = readFileSync(`${repoRoot}.github/workflows/${workflow}`, 'utf8').replace(/\r\n/g, '\n');
			const steps = [...text.matchAll(/id: content_backend\n((?:\s+.*\n){1,3})/g)].map((m) => m[1]);
			assert.ok(steps.length >= 1, 'has a content_backend step');
			const defaultsDir = /defaults:\n\s+run:\n\s+working-directory: (\S+)/.exec(text)?.[1] ?? '.';
			for (const step of steps) {
				const dir = /working-directory: (\S+)/.exec(step)?.[1] ?? defaultsDir;
				const script = /run: node (\S+)/.exec(step)?.[1];
				assert.ok(script, step);
				readFileSync(`${repoRoot}${dir}/${script}`); // throws when the path does not resolve
			}
		});
	}
});