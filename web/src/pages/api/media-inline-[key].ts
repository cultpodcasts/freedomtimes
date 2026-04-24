import type { APIRoute } from 'astro';
import { requireEditorialSession } from '../../lib/editorial-session';

export const prerender = false;

function readHeader(headers: Headers, name: string): string | null {
	const value = headers.get(name);
	return value && value.trim().length > 0 ? value : null;
}

function parseRangeHeader(rangeHeader: string | null): { offset: number; length?: number } | null {
	if (!rangeHeader) return null;

	const match = /^bytes=(\d+)-(\d+)?$/i.exec(rangeHeader.trim());
	if (!match) return null;

	const start = Number(match[1]);
	if (!Number.isFinite(start) || start < 0) return null;

	if (match[2] && match[2].length > 0) {
		const end = Number(match[2]);
		if (!Number.isFinite(end) || end < start) return null;
		return { offset: start, length: end - start + 1 };
	}

	return { offset: start };
}

export const GET: APIRoute = async ({ request, url, cookies, redirect, locals, params }) => {
	const session = await requireEditorialSession({
		cookies,
		url,
		request,
		redirect: (target) => {
			if (target.includes('denied=1')) {
				return new Response('Forbidden', { status: 403 });
			}
			return new Response('Unauthorized', { status: 401 });
		},
	});

	if (session instanceof Response) {
		return session;
	}

	const storageKey = decodeURIComponent(params.key?.trim() ?? '');
	if (!storageKey) {
		return new Response('Missing media key', { status: 400 });
	}

	const runtimeEnv = (locals as { runtime?: { env?: Record<string, unknown> } }).runtime?.env;
	const mediaBucket = runtimeEnv?.MEDIA as
		| {
				get: (key: string, options?: { range?: { offset: number; length?: number } }) => Promise<{
					body: ReadableStream<Uint8Array> | null;
					size: number;
					httpEtag?: string;
					writeHttpMetadata?: (headers: Headers) => void;
				}>;
		  }
		| undefined;

	if (!mediaBucket) {
		return new Response('MEDIA binding unavailable', { status: 500 });
	}

	const range = parseRangeHeader(request.headers.get('range'));
	const object = await mediaBucket.get(storageKey, range ? { range } : undefined);
	if (!object || !object.body) {
		return new Response('File not found', { status: 404 });
	}

	const headers = new Headers();
	if (object.writeHttpMetadata) {
		object.writeHttpMetadata(headers);
	}
	headers.set('content-type', readHeader(headers, 'content-type') ?? 'application/pdf');
	headers.set('content-disposition', 'inline');
	headers.set('cache-control', readHeader(headers, 'cache-control') ?? 'private, max-age=300');
	headers.set('accept-ranges', 'bytes');

	if (range) {
		const length = typeof range.length === 'number' ? range.length : Math.max(object.size - range.offset, 0);
		const end = range.offset + Math.max(length - 1, 0);
		headers.set('content-range', `bytes ${range.offset}-${end}/${object.size}`);
		headers.set('content-length', String(Math.max(length, 0)));
	} else {
		headers.set('content-length', String(object.size));
	}

	if (object.httpEtag) {
		headers.set('etag', object.httpEtag);
	}

	return new Response(object.body, {
		status: range ? 206 : 200,
		headers,
	});
};
