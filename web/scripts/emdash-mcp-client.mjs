/**
 * Minimal HTTP client for EmDash MCP `tools/call` → `content_get`.
 * Used by promote script and canary; keeps `Accept: application/json, text/event-stream`.
 */

/** Pull inner JSON from MCP `tools/call` JSON-RPC `result.content[].text` */
function parseInnerFromJsonRpcMessage(msg) {
	if (msg?.error) {
		const e = msg.error;
		throw new Error(typeof e.message === "string" ? e.message : JSON.stringify(e));
	}
	const parts = msg?.result?.content;
	if (!Array.isArray(parts)) return null;
	for (const part of parts) {
		if (part?.type === "text" && typeof part.text === "string") {
			try {
				return JSON.parse(part.text);
			} catch {
				/* continue */
			}
		}
	}
	return null;
}

/** Parse MCP HTTP body: SSE `data:` lines or a single JSON object */
function parseMcpToolsCallTransportBody(text) {
	const trimmed = text.trim();
	if (trimmed.startsWith("{")) {
		try {
			const msg = JSON.parse(trimmed);
			const inner = parseInnerFromJsonRpcMessage(msg);
			if (inner !== null) return inner;
			if (msg?.item && typeof msg.item === "object") return msg;
		} catch (e) {
			if (e instanceof SyntaxError) {
				/* fall through to SSE */
			} else {
				throw e;
			}
		}
	}
	for (const line of text.split(/\r?\n/)) {
		if (!line.startsWith("data: ")) continue;
		const payload = line.slice(6).trim();
		if (payload === "[DONE]") continue;
		let msg;
		try {
			msg = JSON.parse(payload);
		} catch {
			continue;
		}
		const inner = parseInnerFromJsonRpcMessage(msg);
		if (inner !== null) return inner;
	}
	return null;
}

/**
 * @param {string} baseUrl
 * @param {string} bearerToken
 * @param {{ collection: string, id: string, locale?: string }} toolArgs
 * @returns {Promise<{ item: object, _rev?: string }>}
 */
export async function emdashMcpContentGet(baseUrl, bearerToken, toolArgs) {
	const url = `${baseUrl.replace(/\/$/, "")}/_emdash/api/mcp`;
	const body = JSON.stringify({
		jsonrpc: "2.0",
		id: 1,
		method: "tools/call",
		params: { name: "content_get", arguments: toolArgs },
	});
	const r = await fetch(url, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${bearerToken}`,
			Accept: "application/json, text/event-stream",
			"Content-Type": "application/json",
		},
		body,
	});
	const text = await r.text();
	if (!r.ok) {
		throw new Error(`MCP HTTP ${r.status}: ${text.slice(0, 400)}`);
	}
	const inner = parseMcpToolsCallTransportBody(text);
	if (inner === null || typeof inner !== "object") {
		throw new Error("MCP: could not parse tools/call result body");
	}
	const item = inner.item;
	if (!item || typeof item !== "object") {
		throw new Error("MCP: result missing item");
	}
	return { item, _rev: inner._rev };
}
