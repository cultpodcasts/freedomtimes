/**
 * GET /api/admin/content-export: admin-only download of this environment's EmDash content database
 * as a gzip'd SQLite SQL dump (PR #198). `?format=sql` for an uncompressed dump.
 *
 * Auth: Auth0 session + `admin` role (authorizeAdminApiRequest + hasAdminRole), same gate as every
 * /api/admin route; 401/403 JSON otherwise. Never cached. Each env exports its own DB (staging's
 * Worker can only see staging's D1 binding). Audit-logged without row data.
 * See web/docs/CONTENT_BACKEND.md § Admin SQLite export.
 */
import type { APIRoute } from 'astro';

import { authorizeAdminApiRequest } from '../../../lib/admin-session';
import { hasAdminRole } from '../../../lib/auth';
import {
	contentDumpToStream,
	contentExportFileName,
	generateContentDump,
	resolveDeployEnvironmentName,
	type ContentExportMeta,
	type ContentExportQuery,
} from '../../../lib/content-export';
import { createContentExportQuery, currentContentBackend } from '../../../lib/content-export-db';

export const prerender = false;

export const GET: APIRoute = async ({ cookies, request, url }) => {
	const session = await authorizeAdminApiRequest({
		cookies,
		request,
		url,
		roleCheck: hasAdminRole,
		logPrefix: 'admin-content-export',
	});
	if (session instanceof Response) {
		return session;
	}
	const admin = session;

	const gzip = url.searchParams.get('format') !== 'sql';
	const meta: ContentExportMeta = {
		environment: resolveDeployEnvironmentName(url.hostname),
		backend: currentContentBackend(),
		generatedAt: new Date(),
	};

	let query: ContentExportQuery;
	try {
		query = await createContentExportQuery();
	} catch (error) {
		console.error('[admin-content-export] database unavailable', {
			requestId: admin.requestId,
			message: error instanceof Error ? error.message : String(error),
		});
		return new Response(JSON.stringify({ error: 'Content database unavailable.', requestId: admin.requestId }), {
			status: 503,
			headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
		});
	}

	const fileName = contentExportFileName(meta, gzip);
	const counts = new Map<string, number>();
	console.info('[admin-content-export] started', {
		requestId: admin.requestId,
		admin: session.displayName,
		environment: meta.environment,
		backend: meta.backend,
		fileName,
	});

	async function* audited() {
		try {
			yield* generateContentDump(query, meta, { counts });
			console.info('[admin-content-export] completed', {
				requestId: admin.requestId,
				tables: counts.size,
				rows: [...counts.values()].reduce((a, b) => a + b, 0),
			});
		} catch (error) {
			// Headers are already sent: the file is truncated and has no "-- end of export" trailer,
			// which sqlite-from-content-export.mjs refuses to restore.
			console.error('[admin-content-export] failed mid-stream', {
				requestId: admin.requestId,
				message: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	}

	return new Response(contentDumpToStream(audited(), gzip), {
		status: 200,
		headers: {
			'content-type': gzip ? 'application/gzip' : 'application/sql; charset=utf-8',
			'content-disposition': `attachment; filename="${fileName}"`,
			'cache-control': 'no-store, private',
			'x-content-type-options': 'nosniff',
			'x-robots-tag': 'noindex',
		},
	});
};