/**
 * Cursor MCP stdio bridge for EmDash HTTP MCP (Windows-safe auth).
 *
 * Resolves bearer tokens from PAT env vars or ~/.config/emdash/auth.json, then
 * runs local `mcp-remote` with EmDash-required headers. Use in `.cursor/mcp.json`
 * instead of direct HTTP when `${env:...}` header interpolation fails.
 *
 * Usage: node emdash-mcp-cursor-bridge.mjs <staging|production>
 */
import { spawn, execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BRIDGE_DIR = dirname(fileURLToPath(import.meta.url));
const MCP_REMOTE_PROXY = join(BRIDGE_DIR, "../node_modules/mcp-remote/dist/proxy.js");

const TARGETS = {
	staging: {
		url: "https://staging.freedomtimes.news/_emdash/api/mcp",
		origin: "https://staging.freedomtimes.news",
		envKeys: ["EMDASH_STAGING_PAT", "EMDASH_STAGING_TOKEN", "EMDASH_MCP_TOKEN"],
	},
	production: {
		url: "https://freedomtimes.news/_emdash/api/mcp",
		origin: "https://freedomtimes.news",
		envKeys: ["EMDASH_PRODUCTION_PAT", "EMDASH_PRODUCTION_TOKEN", "EMDASH_MCP_TOKEN"],
	},
};

function tokenFromAuth(origin) {
	const authPath = join(homedir(), ".config", "emdash", "auth.json");
	if (!existsSync(authPath)) return null;
	const auth = JSON.parse(readFileSync(authPath, "utf8"));
	return auth[origin]?.accessToken?.trim() || null;
}

function readWindowsUserEnv(name) {
	if (process.platform !== "win32") return null;
	try {
		const value = execSync(
			`powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('${name}', 'User')"`,
			{ encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
		).trim();
		return value || null;
	} catch {
		return null;
	}
}

function resolveToken(target) {
	for (const key of target.envKeys) {
		const value = process.env[key]?.trim() || readWindowsUserEnv(key)?.trim();
		if (value) return value;
	}
	return tokenFromAuth(target.origin);
}

function main() {
	const name = process.argv[2]?.trim();
	const target = TARGETS[name];
	if (!target) {
		console.error("Usage: node emdash-mcp-cursor-bridge.mjs <staging|production>");
		process.exit(1);
	}

	if (!existsSync(MCP_REMOTE_PROXY)) {
		console.error(`Missing ${MCP_REMOTE_PROXY}. Run: cd web && npm install`);
		process.exit(1);
	}

	const token = resolveToken(target);
	if (!token) {
		console.error(
			`No EmDash token for ${name}. Set ${target.envKeys[0]} (user env) or run: cd web && npx emdash login`,
		);
		process.exit(1);
	}

	const child = spawn(
		process.execPath,
		[
			MCP_REMOTE_PROXY,
			target.url,
			"--header",
			"Authorization:${EMDASH_AUTH}",
			"--header",
			"X-EmDash-Request:${EMDASH_REQUEST}",
			"--header",
			"Accept:${EMDASH_ACCEPT}",
		],
		{
			stdio: "inherit",
			env: {
				...process.env,
				EMDASH_AUTH: `Bearer ${token}`,
				EMDASH_ACCEPT: "application/json, text/event-stream",
				EMDASH_REQUEST: "1",
			},
			shell: false,
		},
	);

	child.on("error", (err) => {
		console.error(`Failed to start mcp-remote: ${err.message}`);
		process.exit(1);
	});

	child.on("exit", (code, signal) => {
		if (signal) process.kill(process.pid, signal);
		process.exit(code ?? 1);
	});
}

main();
