/**
 * Shared EmDash MCP bearer resolution for operator shell scripts.
 * Matches `emdash-mcp-cursor-bridge.mjs`: PAT env → TOKEN env → auth.json.
 */
import { existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const STAGING_DEFAULT = 'https://staging.freedomtimes.news';
export const PROD_DEFAULT = 'https://freedomtimes.news';

function readWindowsUserEnv(name) {
	if (process.platform !== 'win32') return null;
	try {
		const value = execSync(
			`powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('${name}', 'User')"`,
			{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
		).trim();
		return value || null;
	} catch {
		return null;
	}
}

function envOrUser(name) {
	return process.env[name]?.trim() || readWindowsUserEnv(name)?.trim() || null;
}

function tokenFromAuthJson(origin) {
	const authPath = join(homedir(), '.config', 'emdash', 'auth.json');
	if (!existsSync(authPath)) return null;
	const auth = JSON.parse(readFileSync(authPath, 'utf8'));
	const entry = auth[origin.replace(/\/$/, '')];
	const token = entry?.accessToken?.trim();
	if (!token) return null;
	if (entry?.expiresAt) {
		const exp = Date.parse(entry.expiresAt);
		if (Number.isFinite(exp) && exp <= Date.now()) {
			return { token: null, expired: true, expiresAt: entry.expiresAt };
		}
	}
	return { token, expired: false, expiresAt: entry?.expiresAt ?? null };
}

/**
 * @param {string} baseUrl Site origin
 * @returns {{ token: string, source: string }}
 */
export function resolveEmDashBearer(baseUrl) {
	const u = baseUrl.replace(/\/$/, '');
	const isStaging = u === STAGING_DEFAULT.replace(/\/$/, '');
	const isProd = u === PROD_DEFAULT.replace(/\/$/, '');

	const candidates = [
		['EMDASH_MCP_TOKEN', envOrUser('EMDASH_MCP_TOKEN')],
		...(isStaging
			? [
					['EMDASH_STAGING_PAT', envOrUser('EMDASH_STAGING_PAT')],
					['EMDASH_STAGING_TOKEN', envOrUser('EMDASH_STAGING_TOKEN')],
				]
			: []),
		...(isProd
			? [
					['EMDASH_PRODUCTION_PAT', envOrUser('EMDASH_PRODUCTION_PAT')],
					['EMDASH_PRODUCTION_TOKEN', envOrUser('EMDASH_PRODUCTION_TOKEN')],
				]
			: []),
	];

	for (const [source, value] of candidates) {
		if (value) return { token: value, source };
	}

	const fromAuth = tokenFromAuthJson(u);
	if (fromAuth?.token) {
		return { token: fromAuth.token, source: 'auth.json' };
	}

	const hints = [];
	if (isStaging) hints.push('EMDASH_STAGING_PAT', 'EMDASH_STAGING_TOKEN');
	if (isProd) hints.push('EMDASH_PRODUCTION_PAT', 'EMDASH_PRODUCTION_TOKEN');
	hints.push('EMDASH_MCP_TOKEN', `npx emdash login --url ${u}`);
	if (fromAuth?.expired) {
		throw new Error(
			`EmDash auth.json token for ${u} expired (${fromAuth.expiresAt}). ` +
				`Set a long-lived PAT (${hints.slice(0, 2).join(' / ')}) or re-login. ` +
				`See docs/CURSOR_EMDASH_MCP.md and scripts/set-emdash-mcp-tokens.ps1.`,
		);
	}
	throw new Error(
		`No EmDash bearer for ${u}. Tried: ${hints.join(', ')}.`,
	);
}

/** @deprecated use resolveEmDashBearer(baseUrl).token */
export function resolveEmDashToken(baseUrl) {
	return resolveEmDashBearer(baseUrl).token;
}

/**
 * @param {string[]} argv
 */
export function resolveBaseUrl(argv) {
	let url =
		process.env.EMDASH_MCP_URL?.replace(/\/$/, '') ||
		process.env.EMDASH_STAGING_URL?.replace(/\/$/, '') ||
		STAGING_DEFAULT;
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '--url' && argv[i + 1]) {
			url = argv[++i].replace(/\/$/, '');
		}
	}
	return url;
}
