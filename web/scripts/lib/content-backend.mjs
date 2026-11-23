/**
 * Content backend + Turso bypass resolution (PR #198, 23 Nov 2026 Turso outage).
 *
 * Single source of truth: `web/wrangler.jsonc` `env.<name>.vars.FT_CONTENT_BACKEND`
 * (`d1` | `turso`, default `turso`). The Astro build reads `process.env.FT_CONTENT_BACKEND`, so the
 * deploy scripts and CI export the value resolved here before `npm run build`; an explicit
 * `FT_CONTENT_BACKEND` that disagrees with wrangler fails closed (build/runtime split = 503).
 *
 * Turso steps (pre-migrate Turso backup/branch, EmDash core migrate apply/check against Turso,
 * production Turso provenance gates) are bypassed when either:
 *   - the environment's wrangler backend is `d1` (the content DB is not on Turso), or
 *   - `FT_SKIP_TURSO=1` is set (explicit operator/CI override, e.g. Turso account blocked).
 * Every bypass must be loud: callers print {@link buildTursoBypassWarning} to the console and, on
 * GitHub Actions, as a `::warning::` annotation and a job-summary block.
 *
 * Pure: no fs / process access, so it is unit-tested in scripts/test-content-backend.mts.
 */
import { parseJsonc } from './worker-placement-check.mjs';

export const CONTENT_BACKENDS = /** @type {const} */ (['d1', 'turso']);
export const DEFAULT_CONTENT_BACKEND = 'turso';
export const TURSO_BYPASS_FLAG = 'FT_SKIP_TURSO';

/** @param {unknown} raw */
export function normalizeContentBackend(raw) {
	if (raw == null) return null;
	const value = String(raw).trim().toLowerCase();
	if (value === '') return null;
	if (value === 'd1' || value === 'turso') return value;
	throw new Error(`FT_CONTENT_BACKEND must be "d1" or "turso" (got ${JSON.stringify(String(raw))}).`);
}

/** @param {unknown} raw */
export function isTruthyFlag(raw) {
	if (raw == null) return false;
	return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
}

/**
 * Backend the Worker for `envName` is configured for in wrangler.jsonc.
 * @param {string} wranglerText raw wrangler.jsonc
 * @param {string} envName e.g. `staging` | `production`
 * @returns {'d1' | 'turso'}
 */
export function readWranglerContentBackend(wranglerText, envName) {
	const config = parseJsonc(wranglerText);
	const envBlock = config?.env?.[envName];
	if (!envBlock) throw new Error(`web/wrangler.jsonc has no env.${envName} block.`);
	const backend = normalizeContentBackend(envBlock.vars?.FT_CONTENT_BACKEND) ?? DEFAULT_CONTENT_BACKEND;
	if (backend === 'd1') {
		const hasBinding = Array.isArray(envBlock.d1_databases)
			&& envBlock.d1_databases.some((/** @type {{ binding?: string }} */ db) => db?.binding === 'EMDASH');
		if (!hasBinding) {
			throw new Error(`web/wrangler.jsonc env.${envName} sets FT_CONTENT_BACKEND=d1 but has no d1_databases binding "EMDASH".`);
		}
	}
	return backend;
}

/**
 * @param {{ envName: string, wranglerBackend: 'd1' | 'turso', env: Record<string, string | undefined> }} input
 * `skipTurso`: bypass the content-DB Turso steps. `forced`: FT_SKIP_TURSO=1 was set explicitly, so
 * callers also bypass the other Turso databases (scheduler / subscriptions / tips SQL deploys).
 * @returns {{ envName: string, backend: 'd1' | 'turso', skipTurso: boolean, forced: boolean, reasons: string[] }}
 */
export function resolveContentBackendDecision({ envName, wranglerBackend, env }) {
	const explicit = normalizeContentBackend(env.FT_CONTENT_BACKEND);
	if (explicit && explicit !== wranglerBackend) {
		throw new Error(
			`FT_CONTENT_BACKEND=${explicit} disagrees with web/wrangler.jsonc env.${envName}.vars.FT_CONTENT_BACKEND=${wranglerBackend}. `
			+ 'The build and the deployed Worker must use the same backend; change wrangler.jsonc (single source of truth) or unset FT_CONTENT_BACKEND.',
		);
	}
	const reasons = [];
	if (wranglerBackend === 'd1') {
		reasons.push(`web/wrangler.jsonc env.${envName}.vars.FT_CONTENT_BACKEND=d1 (content DB is Cloudflare D1, not Turso)`);
	}
	const forced = isTruthyFlag(env[TURSO_BYPASS_FLAG]);
	if (forced) {
		reasons.push(`${TURSO_BYPASS_FLAG}=${String(env[TURSO_BYPASS_FLAG]).trim()} is set`);
	}
	return { envName, backend: wranglerBackend, skipTurso: reasons.length > 0, forced, reasons };
}

/**
 * Human warning for a Turso bypass. One line for annotations; `details` for the console/summary.
 * @param {{ envName: string, backend: string, reasons: string[] }} decision
 */
export function buildTursoBypassWarning(decision) {
	const title = `TURSO STEPS BYPASSED (${decision.envName})`;
	const line = `${title}: no Turso backup/branch, no EmDash core migrate apply/check against Turso, no Turso provenance gate. Content backend: ${decision.backend}. Reason: ${decision.reasons.join('; ')}.`;
	const details = [
		`### ⚠️ ${title}`,
		'',
		`- Content backend: \`${decision.backend}\``,
		...decision.reasons.map((reason) => `- Reason: ${reason}`),
		'- Skipped: Turso pre-migrate backup / rollback branch, EmDash core migrate apply + --check on Turso, production Turso host provenance (#142/#148).',
		decision.backend === 'd1'
			? '- Safety net: Cloudflare D1 Time Travel (30-day point-in-time restore) and the admin SQLite export at /admin/content-export. See web/docs/CONTENT_BACKEND.md.'
			: '- WARNING: the content backend is still Turso, so this deploy ran with NO verified Turso backup and NO migrate. Unset FT_SKIP_TURSO as soon as Turso is reachable.',
		'- Swap back: web/docs/CONTENT_BACKEND.md § Swap back to Turso.',
	];
	return { title, line, details: details.join('\n') };
}
