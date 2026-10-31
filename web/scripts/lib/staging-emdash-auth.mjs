/**
 * Staging EmDash API token for the production backup's staging compare (#161).
 *
 * verify-production-emdash-backup.mjs --compare-staging reads staging's published posts with
 * GET <staging>/_emdash/api/content/posts and a bearer token. This module resolves that token
 * and checks it, so a missing or rejected token is reported by VARIABLE NAME (never the value)
 * with a fix, instead of a bare "VERIFY FAILED".
 *
 * Token order (first non-empty wins; unchanged from before #161):
 *   1. EMDASH_STAGING_PAT   (process env; backup-production-emdash.ps1 fills it from .env.dev)
 *   2. EMDASH_STAGING_TOKEN (process env; same)
 *   3. ~/.config/emdash/auth.json accessToken for the staging origin (`npx emdash login`;
 *      these expire, so a PAT is preferred)
 *
 * Results carry the token's source NAME only. Never log or return the token in a report.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

export const STAGING_DEFAULT_URL = "https://staging.freedomtimes.news";
export const STAGING_TOKEN_ENV_KEYS = Object.freeze(["EMDASH_STAGING_PAT", "EMDASH_STAGING_TOKEN"]);
export const AUTH_JSON_SOURCE = "~/.config/emdash/auth.json";

export const STAGING_TOKEN_FIX =
	"Fix: put EMDASH_STAGING_PAT=<staging EmDash API token (ec_pat_...)> in the repo-root .env.dev " +
	"(create the token in the staging EmDash admin under API tokens; it is the same token the staging " +
	"EmDash MCP uses, which scripts/set-emdash-mcp-tokens.ps1 saves as a user env var), then re-run. " +
	"backup-production-emdash.ps1 -SkipStagingCompare backs up without the staging compare.";

function defaultReadAuthJson() {
	try {
		return JSON.parse(readFileSync(path.join(homedir(), ".config", "emdash", "auth.json"), "utf8"));
	} catch {
		return null;
	}
}

export function normaliseOrigin(baseUrl) {
	return String(baseUrl || "").replace(/\/+$/, "");
}

/**
 * Resolve the staging EmDash API token.
 * @returns {{ token: string, source: string | null }} source is an env var name or AUTH_JSON_SOURCE.
 */
export function resolveStagingToken(
	baseUrl = STAGING_DEFAULT_URL,
	{ env = process.env, readAuthJson = defaultReadAuthJson } = {},
) {
	for (const key of STAGING_TOKEN_ENV_KEYS) {
		const v = env[key]?.trim();
		if (v) return { token: v, source: key };
	}
	const auth = readAuthJson();
	const entry = auth?.[baseUrl] ?? auth?.[normaliseOrigin(baseUrl)];
	const t = typeof entry?.accessToken === "string" ? entry.accessToken.trim() : "";
	if (t) return { token: t, source: AUTH_JSON_SOURCE };
	return { token: "", source: null };
}

/** A staging token that is missing, rejected, or could not be checked. */
export class StagingAuthError extends Error {
	constructor(kind, message, { status = null, tokenSource = null } = {}) {
		super(message);
		this.name = "StagingAuthError";
		this.kind = kind;
		this.status = status;
		this.tokenSource = tokenSource;
	}

	/** Report shape for --metadata-out and the one-line JSON error (no token value). */
	toReport() {
		return {
			pass: false,
			error: this.kind,
			message: this.message,
			stagingStatus: this.status,
			stagingTokenSource: this.tokenSource,
		};
	}
}

export function stagingTokenMissingError(baseUrl) {
	return new StagingAuthError(
		"staging_token_missing",
		`The staging compare needs a staging EmDash token for ${normaliseOrigin(baseUrl)}, but none of ` +
			`${STAGING_TOKEN_ENV_KEYS.join(", ")} is set and ${AUTH_JSON_SOURCE} has no token for it. ${STAGING_TOKEN_FIX}`,
	);
}

export function stagingTokenRejectedError(baseUrl, status, tokenSource) {
	const why =
		tokenSource === AUTH_JSON_SOURCE
			? "The `npx emdash login` token in auth.json has probably expired."
			: `${tokenSource} is expired, revoked or not a staging token.`;
	return new StagingAuthError(
		"staging_token_rejected",
		`Staging EmDash rejected the token from ${tokenSource} (HTTP ${status} from ${normaliseOrigin(baseUrl)}). ` +
			`${why} ${STAGING_TOKEN_FIX}`,
		{ status, tokenSource },
	);
}

export function isAuthRejectionStatus(status) {
	return status === 401 || status === 403;
}

/**
 * Read-only check that the staging token works: GET one published post.
 * Resolves { ok: true, tokenSource, status } or throws StagingAuthError.
 */
export async function checkStagingAuth(
	baseUrl = STAGING_DEFAULT_URL,
	{ env = process.env, readAuthJson = defaultReadAuthJson, fetchImpl = globalThis.fetch } = {},
) {
	const { token, source } = resolveStagingToken(baseUrl, { env, readAuthJson });
	if (!token) throw stagingTokenMissingError(baseUrl);
	const url = `${normaliseOrigin(baseUrl)}/_emdash/api/content/posts?status=published&limit=1`;
	let r;
	try {
		r = await fetchImpl(url, {
			headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
			redirect: "manual",
		});
	} catch (e) {
		throw new StagingAuthError(
			"staging_unreachable",
			`Could not reach staging EmDash at ${normaliseOrigin(baseUrl)} to check ${source}: ${e?.message ?? e}`,
			{ tokenSource: source },
		);
	}
	if (isAuthRejectionStatus(r.status)) throw stagingTokenRejectedError(baseUrl, r.status, source);
	if (r.status < 200 || r.status >= 300) {
		throw new StagingAuthError(
			"staging_unreachable",
			`Staging EmDash answered HTTP ${r.status} at ${url} while checking ${source}; the staging compare cannot run.`,
			{ status: r.status, tokenSource: source },
		);
	}
	return { ok: true, tokenSource: source, status: r.status };
}
