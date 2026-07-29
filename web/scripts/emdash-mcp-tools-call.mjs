/**
 * Invoke any EmDash MCP tool via HTTP JSON-RPC `tools/call` (same endpoint as
 * `.cursor/mcp.json`). Use this for **schema** and **content** reads/writes instead of
 * `npx emdash schema` / `npx emdash content` when you need true stored JSON (**AGENTS.md**).
 *
 * **Operators:** run manually from a terminal when you choose.
 * **AI agents:** Cursor MCP only — **Primary guardrails §1** in **AGENTS.md** — do NOT use this script when MCP tools fail in the session.
 *
 * Usage (from repo root):
 *   node web/scripts/emdash-mcp-tools-call.mjs [--url <origin>] <toolName> [argumentsJson]
 *
 * Token resolution (same as emdash-mcp-cursor-bridge.mjs):
 *   EMDASH_MCP_TOKEN → EMDASH_STAGING_PAT / EMDASH_PRODUCTION_PAT →
 *   EMDASH_STAGING_TOKEN / EMDASH_PRODUCTION_TOKEN → ~/.config/emdash/auth.json
 *   (process env, then Windows User env on win32)
 */
import { emdashMcpToolsCall } from './emdash-mcp-client.mjs';
import {
	resolveBaseUrl,
	resolveEmDashBearer,
	STAGING_DEFAULT,
} from './lib/emdash-mcp-auth.mjs';

function parseArgs(argv) {
	let url = resolveBaseUrl(argv);
	const rest = [];
	for (let i = 2; i < argv.length; i++) {
		if (argv[i] === '--url' && argv[i + 1]) {
			url = argv[++i].replace(/\/$/, '');
			continue;
		}
		rest.push(argv[i]);
	}
	const toolName = rest[0];
	const argsJson = rest[1] ?? '{}';
	return { url, toolName, argsJson };
}

async function main() {
	const { url, toolName, argsJson } = parseArgs(process.argv);
	if (!toolName) {
		console.error(
			'Usage: node web/scripts/emdash-mcp-tools-call.mjs [--url <origin>] <toolName> [argumentsJson]',
		);
		process.exit(1);
	}
	let toolArgs;
	try {
		toolArgs = JSON.parse(argsJson);
	} catch (e) {
		console.error('Invalid JSON arguments:', e.message);
		process.exit(1);
	}
	const { token, source } = resolveEmDashBearer(url);
	if (process.env.EMDASH_MCP_AUTH_DEBUG === '1') {
		console.error(`Using token from ${source} for ${url}`);
	}
	const out = await emdashMcpToolsCall(url, token, toolName, toolArgs);
	console.log(JSON.stringify(out, null, 2));
}

await main();
