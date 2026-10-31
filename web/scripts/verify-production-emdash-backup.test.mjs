// node --test scripts/verify-production-emdash-backup.test.mjs   (from web/; needs web deps)
// #161: the verify CLI names a missing/rejected staging token and always writes a failure report.
// Local HTTP stub only; never calls staging, production or Turso.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const verifyScript = path.join(here, "verify-production-emdash-backup.mjs");
const SECRET = "ec_pat_fake_secret_value_never_logged";

let tmp;
let server;
let origin;
const statusFor = { value: 200 };

function run(args, extraEnv = {}) {
	// Clean env: no real tokens; HOME/USERPROFILE point at an empty dir so auth.json is absent.
	const env = {
		PATH: process.env.PATH,
		SystemRoot: process.env.SystemRoot,
		HOME: tmp,
		USERPROFILE: tmp,
		...extraEnv,
	};
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [verifyScript, ...args], { env });
		let out = "";
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (out += d));
		child.on("close", (code) => resolve({ code, out }));
	});
}

function lastJsonLine(out) {
	const lines = out.split(/\r?\n/).filter((l) => l.trim().startsWith("{") && l.trim().endsWith("}"));
	return JSON.parse(lines.at(-1));
}

before(async () => {
	tmp = mkdtempSync(path.join(tmpdir(), "ft-verify-161-"));
	server = createServer((req, res) => {
		res.writeHead(statusFor.value, { "content-type": "application/json" });
		res.end(JSON.stringify({ data: { items: [] } }));
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	origin = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
	server?.close();
	if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("--check-staging-auth", () => {
	it("missing token: exit 2, error staging_token_missing, names EMDASH_STAGING_PAT", async () => {
		const { code, out } = await run(["--check-staging-auth", "--staging-url", origin]);
		assert.equal(code, 2);
		const j = lastJsonLine(out);
		assert.equal(j.pass, false);
		assert.equal(j.error, "staging_token_missing");
		assert.match(j.message, /EMDASH_STAGING_PAT/);
	});

	it("rejected token (401): exit 2, error staging_token_rejected, token never printed", async () => {
		statusFor.value = 401;
		const { code, out } = await run(["--check-staging-auth", "--staging-url", origin], { EMDASH_STAGING_PAT: SECRET });
		assert.equal(code, 2);
		const j = lastJsonLine(out);
		assert.equal(j.error, "staging_token_rejected");
		assert.equal(j.stagingTokenSource, "EMDASH_STAGING_PAT");
		assert.ok(!out.includes(SECRET));
	});

	it("working token: exit 0 and the source name only", async () => {
		statusFor.value = 200;
		const { code, out } = await run(["--check-staging-auth", "--staging-url", origin], { EMDASH_STAGING_TOKEN: SECRET });
		assert.equal(code, 0);
		const j = lastJsonLine(out);
		assert.deepEqual(
			{ pass: j.pass, mode: j.mode, source: j.stagingTokenSource },
			{ pass: true, mode: "check-staging-auth", source: "EMDASH_STAGING_TOKEN" },
		);
		assert.ok(!out.includes(SECRET));
	});
});

describe("--metadata-out on failure", () => {
	it("writes { pass: false, error, message } when verify throws", async () => {
		const reportPath = path.join(tmp, "verify-report.json");
		const { code } = await run([
			"--backup-db",
			path.join(tmp, "does-not-exist.db"),
			"--live-url",
			"http://127.0.0.1:9",
			"--live-token",
			"fake",
			"--metadata-out",
			reportPath,
		]);
		assert.equal(code, 2);
		assert.ok(existsSync(reportPath), "failure report written");
		const report = JSON.parse(readFileSync(reportPath, "utf8"));
		assert.equal(report.pass, false);
		assert.equal(report.error, "verify_error");
		assert.ok(report.message.length > 0);
		assert.ok(report.verifiedAtUtc);
	});
});
