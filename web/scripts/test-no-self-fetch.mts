/**
 * #195 / #192 / #193: the web Worker is served on a route in the freedomtimes.news zone, and
 * Cloudflare cannot route a same-zone subrequest back to it: a `fetch` to the site's own hostname
 * waits ~20 s and fails with a 522. This source guard fails on any `fetch(` in `src/` whose URL
 * argument is built from the site origin, so the next self-fetch is caught in `npm test` instead
 * of in production logs. Read R2 (`env.MEDIA`) or Turso instead.
 *
 * Heuristic by design: it inspects the first argument of each `fetch(` call textually. A URL built
 * in a variable elsewhere is not caught; name the rule in review. `scheduler-worker` (on
 * `workers.dev`, outside the zone) may call the site over HTTP and is not scanned.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const SOURCE_EXTENSIONS = /\.(?:ts|mts|js|mjs|astro)$/;
/**
 * Site-origin markers in a fetch URL: an origin identifier (`BLUESKY_SERVICE_ORIGIN` etc. do not
 * match, whole identifiers only), `Astro.url`, the production hostname, or an interpolated base
 * in front of one of the site's own API paths (`${base}/_emdash/…`, `${base}/api/…`: the
 * exact #195 shape, where `base` was the request origin). Relative `'/api/…'` browser fetches
 * have no interpolated base and do not match.
 */
const SELF_ORIGIN =
	/\b(?:origin|siteOrigin|SITE_ORIGIN|PRODUCTION_SITE_ORIGIN)\b|Astro\.url|freedomtimes\.news|\$\{[^}]+\}\/(?:_emdash|api)\//;
const FETCH_CALL = /\bfetch\s*\(/g;

function sourceFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return sourceFiles(path);
		return SOURCE_EXTENSIONS.test(name) ? [path] : [];
	});
}

/** Text of the first argument of the call whose `(` is at `open` (up to the first top-level `,` or `)`). */
function firstArgument(source: string, open: number): string {
	let depth = 0;
	for (let i = open + 1; i < source.length; i += 1) {
		const ch = source[i];
		if (ch === '(' || ch === '[' || ch === '{') depth += 1;
		else if (ch === ')' || ch === ']' || ch === '}') {
			if (depth === 0) return source.slice(open + 1, i);
			depth -= 1;
		} else if (ch === ',' && depth === 0) return source.slice(open + 1, i);
	}
	return source.slice(open + 1);
}

export function findSelfFetches(source: string): string[] {
	const hits: string[] = [];
	for (const match of source.matchAll(FETCH_CALL)) {
		const open = (match.index ?? 0) + match[0].length - 1;
		const arg = firstArgument(source, open).trim();
		if (SELF_ORIGIN.test(arg)) hits.push(`fetch(${arg.replace(/\s+/g, ' ').slice(0, 120)})`);
	}
	return hits;
}

describe('no Worker → own-hostname fetch in web/src (#195)', () => {
	it('the guard catches the #195 / #193 shapes and ignores external or relative fetches', () => {
		assert.equal(findSelfFetches('await fetch(`${origin}/_emdash/api/media/${id}`, { headers });').length, 1);
		// The exact #195 code: the origin was first copied into `base`.
		assert.equal(
			findSelfFetches('const r = await fetch(`${base}/_emdash/api/media/${encodeURIComponent(mediaId)}`, {').length,
			1,
		);
		assert.equal(findSelfFetches('await fetch(`${root}/api/recent-published-posts.json`)').length, 1);
		assert.equal(findSelfFetches('await fetch(new URL(`/_emdash/api/media/file/${key}`, siteOrigin));').length, 1);
		assert.equal(findSelfFetches('const r = await fetch(new URL("/x", Astro.url));').length, 1);
		assert.equal(findSelfFetches('globalThis.fetch(`${url.origin}/api/x`)').length, 1);
		assert.equal(findSelfFetches('fetch("https://freedomtimes.news/api/version.json")').length, 1);
		assert.equal(findSelfFetches("await fetch('/api/story-tips', { method: 'POST' });").length, 0);
		assert.equal(findSelfFetches('deps.fetch(`${BLUESKY_SERVICE_ORIGIN}/xrpc/x`, init)').length, 0);
		assert.equal(findSelfFetches('globalThis.fetch(request.url, { signal: request.signal })').length, 0);
	});

	it('no src/ module fetches the site origin', () => {
		const offenders = sourceFiles(SRC).flatMap((file) =>
			findSelfFetches(readFileSync(file, 'utf8')).map((hit) => `${relative(SRC, file)}: ${hit}`),
		);
		assert.deepEqual(offenders, [], 'read R2 (env.MEDIA) or Turso instead; see web/docs/EMDASH_MIDDLEWARE_AND_ROUTING.md');
	});
});