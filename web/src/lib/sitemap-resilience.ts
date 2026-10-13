/**
 * Sitemap resilience around EmDash's built-in `/sitemap.xml` and
 * `/sitemap-<collection>.xml` routes.
 *
 * Problem (13 Oct 2026 17:04:11 BST): verified Googlebot got a 404 for
 * `/sitemap-posts.xml`. EmDash returns 404 ("Collection not found or empty")
 * and 500 when a DB read hiccups, which Google treats as "sitemap gone".
 *
 * Policy:
 * - Known sitemap paths are served from an edge cache (fresh for
 *   SITEMAP_FRESH_SECONDS) so most crawler fetches never touch the DB.
 * - A successful generation refreshes the fresh copy and a long-lived
 *   last-known-good copy.
 * - A failed generation (any non-200 or a throw) serves last-known-good,
 *   else 503 + Retry-After. Known sitemap paths never return 404.
 * - `/sitemap-posts.xml` also lists the `/weekly-summaries` hub.
 *
 * Access control: when the site is locked (staging), the wrapper does NOT
 * read or write the cache and passes the downstream response through
 * untouched (`Cache-Control: private, no-store`), so EmDash / reader auth
 * decides exactly as before. A cached body can never bypass that.
 *
 * noindex: EmDash's sitemap query already excludes `seo_no_index = 1` rows
 * (guarded by a test against the installed emdash), so noindexed posts are
 * never listed.
 *
 * HEAD is handled like GET with the body dropped.
 */

export const SITEMAP_FRESH_SECONDS = 900;
export const SITEMAP_STALE_SECONDS = 7 * 24 * 60 * 60;
export const SITEMAP_RETRY_AFTER_SECONDS = 300;

const KNOWN_SITEMAP_RE = /^\/sitemap(?:-posts(?:-\d+)?)?\.xml$/;

export function isKnownSitemapPath(pathname: string): boolean {
	return KNOWN_SITEMAP_RE.test(pathname);
}

export interface SitemapCache {
	match(key: string): Promise<Response | undefined>;
	put(key: string, response: Response): Promise<void>;
}

/** Cloudflare `caches.default` when available (Workers); otherwise null (dev / tests). */
export function defaultSitemapCache(): SitemapCache | null {
	const g = globalThis as unknown as { caches?: { default?: Cache } };
	const cache = g.caches?.default;
	if (!cache) return null;
	return {
		match: async (key) => (await cache.match(new Request(key))) ?? undefined,
		put: (key, response) => cache.put(new Request(key), response),
	};
}

function cacheKey(origin: string, pathname: string, kind: 'fresh' | 'stale'): string {
	return `${origin}/__ft-sitemap-cache/${kind}${pathname}`;
}

export function injectHubUrl(xml: string, origin: string, hubPath: string): string {
	const loc = `${origin.replace(/\/$/, '')}${hubPath}`;
	if (xml.includes(`<loc>${loc}</loc>`) || !xml.includes('</urlset>')) return xml;
	const entry = `  <url>\n    <loc>${loc}</loc>\n  </url>\n`;
	return xml.replace('</urlset>', `${entry}</urlset>`);
}

function xmlResponse(body: string, extra: Record<string, string>): Response {
	return new Response(body, {
		status: 200,
		headers: {
			'Content-Type': 'application/xml; charset=utf-8',
			'Cache-Control': `public, max-age=${SITEMAP_FRESH_SECONDS}`,
			...extra,
		},
	});
}

function headOnly(res: Response): Response {
	return new Response(null, { status: res.status, statusText: res.statusText, headers: res.headers });
}

export async function serveSitemapResiliently(options: Parameters<typeof serveSitemapInner>[0]): Promise<Response> {
	const res = await serveSitemapInner(options);
	return options.head ? headOnly(res) : res;
}

async function serveSitemapInner(options: {
	origin: string;
	pathname: string;
	generate: () => Promise<Response>;
	cache: SitemapCache | null;
	hubPath?: string;
	/** Locked site (staging): bypass cache entirely; downstream access control decides. */
	locked?: boolean;
	/** HEAD request: same status/headers, no body. */
	head?: boolean;
	waitUntil?: (p: Promise<unknown>) => void;
	log?: (event: string, extra: Record<string, unknown>) => void;
}): Promise<Response> {
	const { origin, pathname, cache } = options;
	const log = options.log ?? (() => {});
	const defer = (p: Promise<unknown>) => {
		const safe = p.catch((err) => log('sitemap-cache-put-failed', { pathname, error: String(err) }));
		if (options.waitUntil) options.waitUntil(safe);
	};

	if (options.locked) {
		const downstream = await options.generate();
		const headers = new Headers(downstream.headers);
		headers.set('Cache-Control', 'private, no-store');
		return new Response(downstream.body, { status: downstream.status, statusText: downstream.statusText, headers });
	}

	if (cache) {
		try {
			const fresh = await cache.match(cacheKey(origin, pathname, 'fresh'));
			if (fresh) return xmlResponse(await fresh.text(), { 'X-FT-Sitemap': 'cache' });
		} catch (err) {
			log('sitemap-cache-match-failed', { pathname, error: String(err) });
		}
	}

	let generated: Response | null = null;
	let failure = '';
	try {
		generated = await options.generate();
		if (generated.status !== 200) failure = `status ${generated.status}`;
	} catch (err) {
		failure = `threw ${String(err)}`;
	}

	if (generated && !failure) {
		let body = await generated.text();
		if (options.hubPath && pathname === '/sitemap-posts.xml') {
			body = injectHubUrl(body, origin, options.hubPath);
		}
		if (cache) {
			defer(cache.put(cacheKey(origin, pathname, 'fresh'), new Response(body, {
				headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': `public, max-age=${SITEMAP_FRESH_SECONDS}` },
			})));
			defer(cache.put(cacheKey(origin, pathname, 'stale'), new Response(body, {
				headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': `public, max-age=${SITEMAP_STALE_SECONDS}` },
			})));
		}
		return xmlResponse(body, { 'X-FT-Sitemap': 'generated' });
	}

	log('sitemap-generate-failed', { pathname, failure });
	if (cache) {
		try {
			const stale = await cache.match(cacheKey(origin, pathname, 'stale'));
			if (stale) return xmlResponse(await stale.text(), { 'X-FT-Sitemap': 'stale' });
		} catch (err) {
			log('sitemap-cache-match-failed', { pathname, error: String(err) });
		}
	}
	return new Response('<!-- Sitemap temporarily unavailable -->', {
		status: 503,
		headers: {
			'Content-Type': 'application/xml; charset=utf-8',
			'Retry-After': String(SITEMAP_RETRY_AFTER_SECONDS),
			'Cache-Control': 'no-store',
		},
	});
}
