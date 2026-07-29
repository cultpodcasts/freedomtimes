/**
 * Shared EmDash MCP bearer resolution for operator shell scripts.
 * Prefer importing from `./lib/emdash-mcp-auth.mjs` going forward.
 */
export {
	PROD_DEFAULT,
	resolveBaseUrl,
	resolveEmDashBearer,
	resolveEmDashToken,
	STAGING_DEFAULT,
} from '../emdash-mcp-auth.mjs';
