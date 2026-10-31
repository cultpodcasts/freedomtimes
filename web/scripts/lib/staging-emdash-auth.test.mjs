// node --test web/scripts/lib/staging-emdash-auth.test.mjs   (#161; node built-ins only, no network)
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	AUTH_JSON_SOURCE,
	STAGING_DEFAULT_URL,
	STAGING_TOKEN_ENV_KEYS,
	StagingAuthError,
	checkStagingAuth,
	isAuthRejectionStatus,
	resolveStagingToken,
	stagingTokenMissingError,
	stagingTokenRejectedError,
} from "./staging-emdash-auth.mjs";

const SECRET = "ec_pat_fake_secret_value_never_logged";
const noAuthJson = () => null;
const fakeFetch = (status, calls = []) => async (url, init) => {
	calls.push({ url, init });
	return { status, ok: status >= 200 && status < 300 };
};

describe("resolveStagingToken", () => {
	it("prefers EMDASH_STAGING_PAT, then EMDASH_STAGING_TOKEN, then auth.json", () => {
		assert.deepEqual(STAGING_TOKEN_ENV_KEYS, ["EMDASH_STAGING_PAT", "EMDASH_STAGING_TOKEN"]);
		const auth = () => ({ [STAGING_DEFAULT_URL]: { accessToken: "from-auth-json" } });
		assert.deepEqual(
			resolveStagingToken(STAGING_DEFAULT_URL, { env: { EMDASH_STAGING_PAT: " pat ", EMDASH_STAGING_TOKEN: "tok" }, readAuthJson: auth }),
			{ token: "pat", source: "EMDASH_STAGING_PAT" },
		);
		assert.deepEqual(
			resolveStagingToken(STAGING_DEFAULT_URL, { env: { EMDASH_STAGING_PAT: "  ", EMDASH_STAGING_TOKEN: "tok" }, readAuthJson: auth }),
			{ token: "tok", source: "EMDASH_STAGING_TOKEN" },
		);
		assert.deepEqual(resolveStagingToken(STAGING_DEFAULT_URL, { env: {}, readAuthJson: auth }), {
			token: "from-auth-json",
			source: AUTH_JSON_SOURCE,
		});
	});

	it("matches auth.json with or without a trailing slash and reports none when absent", () => {
		const auth = () => ({ [STAGING_DEFAULT_URL]: { accessToken: "a" } });
		assert.equal(resolveStagingToken(`${STAGING_DEFAULT_URL}/`, { env: {}, readAuthJson: auth }).token, "a");
		assert.deepEqual(resolveStagingToken(STAGING_DEFAULT_URL, { env: {}, readAuthJson: noAuthJson }), {
			token: "",
			source: null,
		});
	});

	it("ignores production token variables", () => {
		const env = { EMDASH_PRODUCTION_PAT: "prod", EMDASH_PRODUCTION_TOKEN: "prod" };
		assert.equal(resolveStagingToken(STAGING_DEFAULT_URL, { env, readAuthJson: noAuthJson }).token, "");
	});
});

describe("staging auth errors", () => {
	it("missing names every variable and the .env.dev fix", () => {
		const e = stagingTokenMissingError(STAGING_DEFAULT_URL);
		assert.ok(e instanceof StagingAuthError);
		assert.equal(e.kind, "staging_token_missing");
		for (const k of STAGING_TOKEN_ENV_KEYS) assert.match(e.message, new RegExp(k));
		assert.match(e.message, /\.env\.dev/);
		assert.match(e.message, /-SkipStagingCompare/);
		const r = e.toReport();
		assert.equal(r.pass, false);
		assert.equal(r.error, "staging_token_missing");
	});

	it("rejected names the source variable and the HTTP status", () => {
		const e = stagingTokenRejectedError(STAGING_DEFAULT_URL, 401, "EMDASH_STAGING_PAT");
		assert.equal(e.kind, "staging_token_rejected");
		assert.match(e.message, /EMDASH_STAGING_PAT is expired, revoked or not a staging token/);
		assert.match(e.message, /HTTP 401/);
		assert.deepEqual(
			{ status: e.toReport().stagingStatus, source: e.toReport().stagingTokenSource },
			{ status: 401, source: "EMDASH_STAGING_PAT" },
		);
		assert.match(stagingTokenRejectedError(STAGING_DEFAULT_URL, 403, AUTH_JSON_SOURCE).message, /probably expired/);
	});

	it("only 401 and 403 count as a rejected token", () => {
		assert.equal(isAuthRejectionStatus(401), true);
		assert.equal(isAuthRejectionStatus(403), true);
		assert.equal(isAuthRejectionStatus(404), false);
		assert.equal(isAuthRejectionStatus(500), false);
	});
});

describe("checkStagingAuth", () => {
	it("passes on 200 with a read-only GET carrying the bearer token", async () => {
		const calls = [];
		const r = await checkStagingAuth(STAGING_DEFAULT_URL, {
			env: { EMDASH_STAGING_PAT: SECRET },
			readAuthJson: noAuthJson,
			fetchImpl: fakeFetch(200, calls),
		});
		assert.deepEqual(r, { ok: true, tokenSource: "EMDASH_STAGING_PAT", status: 200 });
		assert.equal(calls.length, 1);
		assert.equal(calls[0].url, `${STAGING_DEFAULT_URL}/_emdash/api/content/posts?status=published&limit=1`);
		assert.equal(calls[0].init.method, undefined);
		assert.equal(calls[0].init.headers.Authorization, `Bearer ${SECRET}`);
	});

	it("throws staging_token_missing without calling staging", async () => {
		const calls = [];
		await assert.rejects(
			checkStagingAuth(STAGING_DEFAULT_URL, { env: {}, readAuthJson: noAuthJson, fetchImpl: fakeFetch(200, calls) }),
			(e) => e.kind === "staging_token_missing",
		);
		assert.equal(calls.length, 0);
	});

	for (const status of [401, 403]) {
		it(`throws staging_token_rejected on ${status} and never puts the token in the report`, async () => {
			await assert.rejects(
				checkStagingAuth(STAGING_DEFAULT_URL, {
					env: { EMDASH_STAGING_TOKEN: SECRET },
					readAuthJson: noAuthJson,
					fetchImpl: fakeFetch(status),
				}),
				(e) => {
					assert.equal(e.kind, "staging_token_rejected");
					assert.equal(e.tokenSource, "EMDASH_STAGING_TOKEN");
					assert.ok(!JSON.stringify(e.toReport()).includes(SECRET));
					assert.ok(!e.message.includes(SECRET));
					return true;
				},
			);
		});
	}

	it("reports a 5xx, a redirect or a network error as staging_unreachable", async () => {
		const env = { EMDASH_STAGING_PAT: SECRET };
		for (const status of [500, 302]) {
			await assert.rejects(
				checkStagingAuth(STAGING_DEFAULT_URL, { env, readAuthJson: noAuthJson, fetchImpl: fakeFetch(status) }),
				(e) => e.kind === "staging_unreachable" && e.status === status,
			);
		}
		await assert.rejects(
			checkStagingAuth(STAGING_DEFAULT_URL, {
				env,
				readAuthJson: noAuthJson,
				fetchImpl: async () => {
					throw new Error("getaddrinfo ENOTFOUND");
				},
			}),
			(e) => e.kind === "staging_unreachable" && /ENOTFOUND/.test(e.message) && !e.message.includes(SECRET),
		);
	});
});

it("staging_unreachable says how to proceed (retry or -SkipStagingCompare)", async () => {
	const err = await checkStagingAuth("https://staging.example", {
		env: { EMDASH_STAGING_PAT: "ec_pat_secret" },
		readAuthJson: () => null,
		fetchImpl: async () => ({ status: 503, ok: false }),
	}).then(
		() => null,
		(e) => e,
	);
	assert.ok(err, "expected a throw");
	assert.equal(err.kind, "staging_unreachable");
	assert.match(err.message, /-SkipStagingCompare/);
	assert.doesNotMatch(err.message, /ec_pat_secret/);
});
