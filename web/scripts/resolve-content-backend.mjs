#!/usr/bin/env node
/**
 * Resolve the content backend for a Worker environment and whether Turso steps are bypassed.
 * See scripts/lib/content-backend.mjs and web/docs/CONTENT_BACKEND.md.
 *
 *   node web/scripts/resolve-content-backend.mjs --env staging            # human output
 *   node web/scripts/resolve-content-backend.mjs --env production --json  # JSON on stdout (deploy scripts)
 *
 * On a bypass it always prints a WARNING to stderr. On GitHub Actions (GITHUB_ACTIONS=true) it also
 * emits a `::warning::` annotation, appends a job-summary block, and writes `backend` / `skip_turso`
 * to $GITHUB_OUTPUT. Exit 1 on a misconfiguration (unknown value, build/runtime disagreement).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	buildTursoBypassWarning,
	readWranglerContentBackend,
	resolveContentBackendDecision,
} from './lib/content-backend.mjs';

function arg(flag) {
	const i = process.argv.indexOf(flag);
	return i === -1 ? null : (process.argv[i + 1] ?? null);
}

const envName = arg('--env');
if (envName !== 'staging' && envName !== 'production') {
	console.error('Usage: node web/scripts/resolve-content-backend.mjs --env staging|production [--json]');
	process.exit(2);
}

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
	const wranglerText = fs.readFileSync(path.join(webDir, 'wrangler.jsonc'), 'utf8');
	const decision = resolveContentBackendDecision({
		envName,
		wranglerBackend: readWranglerContentBackend(wranglerText, envName),
		env: process.env,
	});
	const onActions = process.env.GITHUB_ACTIONS === 'true';
	const json = process.argv.includes('--json');
	const warning = decision.skipTurso ? buildTursoBypassWarning(decision) : null;
	if (warning) {
		console.error(`\n*** WARNING: ${warning.line}\n`);
		if (onActions) {
			// --json: stdout is machine-read, so the PowerShell caller emits the ::warning:: itself
			// (Write-DeployTursoBypassWarning) from warningTitle / warningLine.
			if (!json) console.log(`::warning title=${warning.title}::${warning.line}`);
			// One summary block per job: a workflow step reports first and marks the job env, so the
			// deploy script's own call (same job) does not repeat it.
			if (process.env.GITHUB_STEP_SUMMARY && process.env.FT_TURSO_BYPASS_REPORTED !== '1') {
				fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${warning.details}\n\n`);
				if (process.env.GITHUB_ENV) fs.appendFileSync(process.env.GITHUB_ENV, 'FT_TURSO_BYPASS_REPORTED=1\n');
			}
		}
	}
	if (onActions && process.env.GITHUB_OUTPUT) {
		fs.appendFileSync(
			process.env.GITHUB_OUTPUT,
			`backend=${decision.backend}\nskip_turso=${decision.skipTurso}\nforce_skip_turso=${decision.forced}\n`,
		);
	}
	if (json) {
		const payload = { ...decision, warningTitle: warning?.title ?? null, warningLine: warning?.line ?? null };
		process.stdout.write(`${JSON.stringify(payload)}\n`);
	} else {
		console.log(`FT_CONTENT_BACKEND (${envName}): ${decision.backend}; Turso steps ${decision.skipTurso ? 'BYPASSED' : 'enabled'}`);
	}
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	if (process.env.GITHUB_ACTIONS === 'true') console.log(`::error title=Content backend::${message}`);
	console.error(`ERROR: ${message}`);
	process.exit(1);
}


