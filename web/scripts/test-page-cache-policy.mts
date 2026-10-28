import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
	CACHEABLE_STATIC_ROUTES,
	DENY_TOP_LEVEL,
	PAGE_CACHE_DEFAULT_TTL_SECONDS,
	decidePageCacheRequest,
	hasOnlyNonSessionCookies,
	isCacheablePath,
	HTML_END_TAIL_BYTES,
	isCompleteStorableBody,
	isPageCacheEnabled,
	isStorableResponse,
	pageCacheKeyUrl,
	pageCacheTtlSeconds,
} from '../src/lib/page-cache-policy.ts';
import { secureAccessWallResponse } from '../src/lib/secure-access-wall.ts';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const PROD = { PAGE_CACHE: 'on', PAGE_CACHE_TTL_SECONDS: '120', SITE_ACCESS_MODE: 'public' };
const req = (over: Partial<Parameters<typeof decidePageCacheRequest>[1]> = {}) => ({
	method: 'GET',
	pathname: '/',
	search: '',
	cookie: null,
	authorization: null,
	...over,
});

describe('page cache: enablement (staging safety)', () => {
	it('is on only with PAGE_CACHE=on AND public site access', () => {
		assert.equal(isPageCacheEnabled(PROD), true);
		assert.equal(isPageCacheEnabled({ ...PROD, PAGE_CACHE: 'off' }), false);
		assert.equal(isPageCacheEnabled({ ...PROD, PAGE_CACHE: undefined }), false);
		assert.equal(isPageCacheEnabled({ ...PROD, SITE_ACCESS_MODE: 'locked' }), false);
		assert.equal(isPageCacheEnabled({ ...PROD, SITE_ACCESS_MODE: undefined }), false);
	});

	it('locked staging never caches even if the flag were flipped on', () => {
		const d = decidePageCacheRequest({ PAGE_CACHE: 'on', SITE_ACCESS_MODE: 'locked' }, req());
		assert.deepEqual(d, { cacheable: false, reason: 'disabled' });
	});

	it('wrangler.jsonc: production on, staging off and locked', () => {
		const wrangler = read('../wrangler.jsonc');
		const staging = wrangler.slice(wrangler.indexOf('"staging"'));
		const production = wrangler.slice(wrangler.indexOf('"production"'), wrangler.indexOf('"staging"'));
		assert.match(production, /"PAGE_CACHE":\s*"on"/);
		assert.match(staging, /"PAGE_CACHE":\s*"off"/);
		assert.match(staging, /"SITE_ACCESS_MODE":\s*"locked"/);
		assert.match(production, /"placement":\s*\{\s*"region":\s*"aws:eu-west-1"\s*\}/);
		assert.match(staging, /"placement":\s*\{\s*"region":\s*"aws:eu-west-1"\s*\}/);
	});

	it('TTL defaults to 120 s and is capped', () => {
		assert.equal(pageCacheTtlSeconds({}), PAGE_CACHE_DEFAULT_TTL_SECONDS);
		assert.equal(pageCacheTtlSeconds({ PAGE_CACHE_TTL_SECONDS: '60' }), 60);
		assert.equal(pageCacheTtlSeconds({ PAGE_CACHE_TTL_SECONDS: 'abc' }), 120);
		assert.equal(pageCacheTtlSeconds({ PAGE_CACHE_TTL_SECONDS: '99999' }), 600);
	});
});

describe('page cache: request bypass rules', () => {
	it('caches reader pages', () => {
		for (const p of [
			'/',
			'/posts/weekly-summary-11-october-2026',
			'/contact-us',
			'/robots.txt',
			'/archives',
			'/archives/2026',
		]) {
			assert.equal(isCacheablePath(p), true, p);
		}
	});

	it('never caches admin, EmDash, API, auth, preview or utility routes', () => {
		for (const p of [
			'/_emdash',
			'/_emdash/admin',
			'/_emdash/api/mcp',
			'/admin/analytics',
			'/api/version.json',
			'/auth/login',
			'/authorize',
			'/.well-known/assetlinks.json',
			'/homepage',
			'/login-wall',
			'/signed-in',
			'/submit-a-tip',
			'/tip-source',
			'/manifest.webmanifest',
			'/sitemap.xml',
			'/sitemap-posts.xml',
			'/preview',
			'/cdn-cgi/trace',
			'/posts/draft-electoral-matters-hearing-transcript-2026-10-16)',
			'/posts/x/y',
			'/posts/Upper',
			'/posts/a%20b',
		]) {
			assert.equal(isCacheablePath(p), false, p);
		}
	});

	it('bypasses on ANY session/auth/unknown cookie; tolerates CF/GA cookies', () => {
		assert.equal(hasOnlyNonSessionCookies(null), true);
		assert.equal(hasOnlyNonSessionCookies('__cf_bm=x; _ga=1; _ga_ABC123=2; cf_clearance=y'), true);
		for (const c of ['astro-session=abc', 'ft_session=x', 'appSession=x', 'auth0.is.authenticated=true', 'theme=dark', '__cf_bm=x; emdash_session=y']) {
			assert.equal(hasOnlyNonSessionCookies(c), false, c);
		}
		assert.deepEqual(decidePageCacheRequest(PROD, req({ cookie: 'astro-session=abc' })), {
			cacheable: false,
			reason: 'cookie',
		});
	});

	it('bypasses Authorization and non-GET/HEAD', () => {
		assert.equal(decidePageCacheRequest(PROD, req({ authorization: 'Bearer x' })).cacheable, false);
		assert.equal(decidePageCacheRequest(PROD, req({ method: 'POST' })).cacheable, false);
		assert.equal(decidePageCacheRequest(PROD, req({ method: 'HEAD' })).cacheable, true);
	});

	it('fails closed on ANY query string, including tracking params (no poisoning via utm_*)', () => {
		// Layout.astro canonical/og:url fallback and Header.astro `next=` render the query.
		for (const s of ['?preview=1', '?_preview=tok', '?edit=1', '?page=2', '?token=x', '?utm_source=x', '?fbclid=y', '?gclid=z&utm_medium=a', '?ref=x']) {
			assert.deepEqual(decidePageCacheRequest(PROD, req({ pathname: '/archives', search: s })), { cacheable: false, reason: 'query' }, s);
		}
		assert.deepEqual(decidePageCacheRequest(PROD, req({ pathname: '/archives', search: '' })), { cacheable: true, keyPath: '/archives' });
	});
});

describe('page cache: route classification (catch-all fails closed)', () => {
	it('every top-level src/pages entry is explicitly denied or allow-listed', () => {
		const pagesDir = fileURLToPath(new URL('../src/pages/', import.meta.url));
		const names = readdirSync(pagesDir)
			.filter((n) => n !== '[slug].astro')
			.map((n) => n.replace(/\.(astro|ts|js|mts|md|mdx)$/, ''));
		assert.ok(names.length > 5, 'expected to enumerate src/pages');
		for (const name of names) {
			if (name.startsWith('.') || name.startsWith('_')) {
				// Rejected by isCacheablePath's `/.` and `/_` prefix check.
				assert.equal(isCacheablePath(`/${name}/x`), false, name);
				continue;
			}
			assert.ok(
				DENY_TOP_LEVEL.has(name) || CACHEABLE_STATIC_ROUTES.has(name),
				`New top-level route src/pages/${name}: add it to DENY_TOP_LEVEL (not a cacheable reader page) or CACHEABLE_STATIC_ROUTES in src/lib/page-cache-policy.ts`,
			);
			assert.ok(!(DENY_TOP_LEVEL.has(name) && CACHEABLE_STATIC_ROUTES.has(name)), `${name} is in both lists`);
		}
	});

	it('denied top-level segments are never cacheable, even as a single-segment slug', () => {
		for (const name of DENY_TOP_LEVEL) {
			assert.equal(isCacheablePath(`/${name}`), false, name);
		}
		assert.equal(isCacheablePath('/pages/about'), false);
	});
});

describe('page cache: response storability', () => {
	const ok = (h: Record<string, string>, status = 200) => ({ status, headers: new Headers(h) });
	const html = { 'content-type': 'text/html; charset=utf-8' };

	it('stores plain 200 HTML and text', () => {
		assert.equal(isStorableResponse(ok(html)), true);
		assert.equal(isStorableResponse(ok({ 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=86400' })), true);
	});

	it('never stores non-200, Set-Cookie, private/no-store, Vary: Cookie, or non-HTML', () => {
		for (const status of [301, 302, 304, 404, 410, 500, 503]) {
			assert.equal(isStorableResponse(ok(html, status)), false, String(status));
		}
		assert.equal(isStorableResponse(ok({ ...html, 'set-cookie': 'a=b' })), false);
		assert.equal(isStorableResponse(ok({ ...html, 'cache-control': 'private' })), false);
		assert.equal(isStorableResponse(ok({ ...html, 'cache-control': 'no-store' })), false);
		assert.equal(isStorableResponse(ok({ ...html, 'cache-control': 'no-cache' })), false);
		assert.equal(isStorableResponse(ok({ ...html, vary: 'Cookie' })), false);
		assert.equal(isStorableResponse(ok({ 'content-type': 'application/json' })), false);
		assert.equal(isStorableResponse(ok({})), false);
	});

	it('cache key carries the purge epoch and is not a routable path', () => {
		const key = pageCacheKeyUrl('https://freedomtimes.news', 'mabc', '/posts/x');
		assert.equal(key, 'https://freedomtimes.news/__ft_page_cache/mabc/posts/x');
		assert.equal(isCacheablePath(new URL(key).pathname), false);
	});
});

describe('page cache: body completeness before store (#123)', () => {
	const enc = (text: string) => new TextEncoder().encode(text);
	const html = 'text/html; charset=utf-8';

	it('a full HTML document is complete (trailing whitespace allowed, any case)', () => {
		assert.equal(isCompleteStorableBody(html, enc('<!DOCTYPE html><html><body>x</body></html>')), true);
		assert.equal(isCompleteStorableBody(html, enc('<!DOCTYPE html><html><body>x</body></HTML>\n\n')), true);
		assert.equal(isCompleteStorableBody(html, enc(`<html><body>${'x'.repeat(200_000)}</body></html>`)), true);
	});

	it('empty or cut-off HTML is never complete', () => {
		assert.equal(isCompleteStorableBody(html, new Uint8Array(0)), false);
		assert.equal(isCompleteStorableBody(html, enc('<!DOCTYPE html><html><head><title>x</title></head><body>')), false);
		assert.equal(isCompleteStorableBody(null, new Uint8Array(0)), false);
	});

	it('junk after </html> is rejected; only whitespace and complete <script> blocks may follow it', () => {
		const doc = '<!DOCTYPE html><html><body>x</body></html>';
		for (const junk of [
			'<p>trailing junk</p>',
			'trailing text',
			'<!-- comment -->',
			'<div></div>',
			'<style>p{}</style>',
			'<script>ok()</script><p>junk</p>',
			'<script>ok()</script>junk',
			'<scripts>x</scripts>',
		]) {
			assert.equal(isCompleteStorableBody(html, enc(doc + junk)), false, `junk: ${junk}`);
		}
		assert.equal(isCompleteStorableBody(html, enc('<html><body></html><p>trailing junk</p>')), false);
	});

	it('a <script> after </html> that was cut off is rejected (the stream ended mid-script)', () => {
		const doc = '<!DOCTYPE html><html><body>x</body></html>';
		for (const cut of ['<script', '<script type="module"', '<script type="module">', '<script type="module">function e(){', '<script>a()</script><script>b(', '<script>a()</scr']) {
			assert.equal(isCompleteStorableBody(html, enc(doc + cut)), false, `cut: ${cut}`);
		}
	});

	it('complete <script> blocks (and whitespace) after </html> are allowed', () => {
		const doc = '<!DOCTYPE html><html><body>x</body></html>';
		for (const ok of [
			'<script type="module">init();</script>',
			'\n<script type="module">init();</script>\n',
			'<script>a()</script>\n  <SCRIPT type="module">b()</SCRIPT >\n',
			'<script type="application/ld+json">{"a":1}</script>',
		]) {
			assert.equal(isCompleteStorableBody(html, enc(doc + ok)), true, `ok: ${JSON.stringify(ok)}`);
		}
	});

	it("a real article page's ending (production, 28 Oct 2026: module script after </html>) is complete", () => {
		const ending = read('./fixtures/page-cache-post-ending.html');
		assert.match(ending, /<\/html><script type="module">/, 'fixture keeps the script-after-</html> shape');
		const page = `<!DOCTYPE html><html lang="en"><head><title>Weekly summary</title></head><body><main class="shell">${'<p>body</p>'.repeat(8_000)}</main>${ending}`;
		assert.equal(isCompleteStorableBody(html, enc(page)), true);
		// ...and every cut of that ending is not complete.
		for (const cutAt of [ending.indexOf('</html>'), ending.indexOf('</html>') + 7 + 10, ending.length - 10, ending.length - 1]) {
			const cut = page.slice(0, page.length - ending.length + cutAt);
			assert.equal(isCompleteStorableBody(html, enc(cut)), false, `cut at ${cutAt}`);
		}
	});

	it('known limit: a stream cut exactly at the end of </html>, before a trailing <script>, is accepted', () => {
		// Pins current behaviour (see isCompleteStorableBody JSDoc): the stream-error check, not this
		// tail check, is the primary guard against cut-off renders.
		const ending = read('./fixtures/page-cache-post-ending.html');
		const page = `<!DOCTYPE html><html lang="en"><head><title>x</title></head><body><main>${'<p>body</p>'.repeat(100)}</main>${ending}`;
		const cut = page.slice(0, page.length - ending.length + ending.indexOf('</html>') + '</html>'.length);
		assert.ok(cut.endsWith('</html>'));
		assert.equal(isCompleteStorableBody(html, enc(cut)), true);
	});

	it('known limit: a literal </html> string inside a trailing <script> fails closed (not stored)', () => {
		const doc = '<!DOCTYPE html><html><body>x</body></html>';
		assert.equal(isCompleteStorableBody(html, enc(`${doc}<script type="module">var s="</html>";init();</script>`)), false);
		assert.equal(isCompleteStorableBody(html, enc(`${doc}<script type="module">var s="</script>";init();</script>`)), false);
	});

	it('fails closed when </html> is not in the inspected tail (huge trailing scripts)', () => {
		const doc = '<!DOCTYPE html><html><body>x</body></html>';
		const inside = `<script>${'x'.repeat(HTML_END_TAIL_BYTES - 200)}</script>`;
		assert.equal(isCompleteStorableBody(html, enc(doc + inside)), true);
		const outside = `<script>${'x'.repeat(HTML_END_TAIL_BYTES)}</script>`;
		assert.equal(isCompleteStorableBody(html, enc(doc + outside)), false);
	});

	it('plain text only has to be non-empty', () => {
		assert.equal(isCompleteStorableBody('text/plain', enc('User-agent: *\n')), true);
		assert.equal(isCompleteStorableBody('text/plain', new Uint8Array(0)), false);
	});
});

describe('page cache: the `</html>` contract of cacheable documents (#123)', () => {
	const lastNonBlankLine = (text: string) => text.trimEnd().split('\n').pop()!.trim();
	const VIEWS = ['HomepageView', 'EmDashContentView', 'NotFoundView'];
	/** Every page that answers a cacheable reader path (isCacheablePath), plus the error pages. */
	const READER_ROUTES = ['index.astro', 'homepage.astro', '[slug].astro', '404.astro', '500.astro', 'posts/[slug].astro', 'archives/index.astro', 'archives/[slug].astro'];

	it('src/layouts/Layout.astro ends with </html> as its last non-blank line', () => {
		// The rendered document must end at Layout's </html>: anything Astro emits after it has to
		// pass isCompleteStorableBody's tail check, and only complete <script> blocks do.
		assert.equal(lastNonBlankLine(read('../src/layouts/Layout.astro')), '</html>');
	});

	it('every reader view renders through Layout (so every cacheable page ends with </html>)', () => {
		for (const view of VIEWS) {
			const source = read(`../src/components/${view}.astro`);
			assert.match(source, /^import Layout from ['"]\.\.\/layouts\/Layout\.astro['"];?$/m, view);
			assert.match(source, /<Layout[\s>]/, view);
			assert.doesNotMatch(source, /<html[\s>]/i, `${view}: no document shell of its own`);
		}
	});

	it('reader routes render a view or Layout, never their own <html> document', () => {
		for (const page of READER_ROUTES) {
			const source = read(`../src/pages/${page}`);
			assert.doesNotMatch(source, /<html[\s>]/i, `${page}: no document shell of its own`);
			const usesShell = /import Layout from /.test(source) || VIEWS.some((v) => new RegExp(`import ${v} from `).test(source));
			assert.ok(usesShell, `${page}: renders through Layout or a reader view`);
		}
	});

	/**
	 * Every component or page that renders Layout, found on disk (fails closed: a new view or route
	 * is covered without editing a list), minus pages whose top-level segment the cache never serves
	 * (DENY_TOP_LEVEL; e.g. submit-a-tip and admin do have scripts after </Layout>).
	 */
	const layoutUsers = (): string[] => {
		const out: string[] = [];
		for (const dir of ['components', 'pages'] as const) {
			const root = fileURLToPath(new URL(`../src/${dir}/`, import.meta.url));
			for (const rel of readdirSync(root, { recursive: true }) as string[]) {
				const path = rel.split('\\').join('/');
				if (!path.endsWith('.astro')) continue;
				const file = `../src/${dir}/${path}`;
				if (!/^import Layout from /m.test(read(file))) continue;
				if (dir === 'pages' && DENY_TOP_LEVEL.has(path.split('/')[0].replace(/\.astro$/, ''))) continue;
				out.push(file);
			}
		}
		return out.sort();
	};

	it('the Layout-user scan finds the reader views and Layout-rendering reader routes', () => {
		const files = layoutUsers();
		for (const v of VIEWS) assert.ok(files.includes(`../src/components/${v}.astro`), `${v} found`);
		assert.ok(files.includes('../src/pages/archives/index.astro'), 'archives/index.astro found');
		// Denied top-level segments are skipped (the 500 page is a 500 response, never stored).
		for (const f of files) assert.doesNotMatch(f, /\/pages\/(admin|submit-a-tip|signed-in|tip-source|500)\b/, `${f} is denied`);
	});

	it('every cacheable Layout user puts nothing but <style> after </Layout> (a <script> there lands after </html>)', () => {
		// Astro emits a component's markup in template order: a <script> written after </Layout> is
		// rendered after Layout's </html>. Article pages and /contact-us did this via
		// EmDashContentView until this change. Styles are extracted to CSS, so they are fine.
		for (const file of layoutUsers()) {
			const source = read(file);
			const close = source.lastIndexOf('</Layout>');
			if (close < 0) continue; // renders a view instead
			const after = source.slice(close + '</Layout>'.length).replace(/<style[\s>][\s\S]*?<\/style>/g, '').trim();
			assert.equal(after, '', `${file}: only <style> may follow </Layout>, found: ${after.slice(0, 80)}`);
		}
	});

	it('the secure-access wall is never storable (no-store), and it ends with </html> anyway', async () => {
		const wall = secureAccessWallResponse();
		assert.equal(isStorableResponse(wall), false);
		const body = await wall.text();
		assert.equal(isCompleteStorableBody(wall.headers.get('content-type'), new TextEncoder().encode(body)), true);
	});
});

describe('page cache: wiring', () => {
	const outer = read('../src/emdash-outer-middleware.ts');
	const astroConfig = read('../astro.config.ts');
	const plugin = read('../src/plugins/page-cache-purge.ts');
	const handler = read('../src/lib/page-cache-handler.ts');

	it('outer middleware wires the cache handler before EmDash runtime, no db access', () => {
		assert.match(outer, /handlePageCache\(pageCacheDeps\(\)/);
		assert.match(outer, /hasPendingCookies: \(\) => !context\.cookies\.headers\(\)\.next\(\)\.done/);
		assert.match(outer, /recordPageView,/);
		for (const src of [outer, handler]) {
			assert.doesNotMatch(src, /getDb\(/);
			assert.doesNotMatch(src, /from 'emdash\/runtime'/);
		}
		assert.doesNotMatch(handler, /from 'cloudflare:workers'/);
	});

	it('purge plugin is registered and hooks content changes', () => {
		assert.match(astroConfig, /id: 'ft-page-cache-purge'/);
		assert.match(astroConfig, /page-cache-purge\.ts/);
		for (const hook of ['afterSave', 'afterPublish', 'afterUnpublish', 'afterDelete', 'afterRestore']) {
			assert.match(plugin, new RegExp(`'content:${hook}'`), hook);
		}
		assert.match(plugin, /capabilities: \['content:read'\]/);
		assert.match(plugin, /createPurgeHooks\(/);
		assert.match(plugin, /isPageCacheEnabled/);
	});

	it('does not touch robots or add noindex', () => {
		assert.doesNotMatch(outer, /noindex|robots/i);
		assert.doesNotMatch(plugin, /noindex|robots/i);
	});
});
