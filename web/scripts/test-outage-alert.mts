/**
 * PR #198: immediate outage alert on 5xx pages + branded, DB-free error page.
 * Pure policy from src/lib/outage-alert.ts, plus source checks on the middleware hook and
 * src/pages/500.astro.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
	buildOutageAlertEmail,
	buildOutageAlertPush,
	OUTAGE_ALERT_WINDOW_SECONDS,
	outageAlertDedupeKey,
	outageAlertsEnabled,
	parseEmailRecipients,
	shouldAlertOnResponse,
	type OutageAlertEvent,
} from '../src/lib/outage-alert.ts';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const event: OutageAlertEvent = {
	environment: 'production',
	status: 503,
	method: 'GET',
	url: 'https://freedomtimes.news/posts/x',
	cfRay: 'abc123-LHR',
	at: new Date('2026-11-23T12:00:00Z'),
	contentStoreUnavailable: true,
	contentBackend: 'd1',
};

describe('shouldAlertOnResponse', () => {
	const html = 'text/html; charset=utf-8';
	it('fires for 5xx HTML pages on GET/HEAD', () => {
		for (const status of [500, 502, 503]) {
			assert.equal(shouldAlertOnResponse({ status, method: 'GET', pathname: '/', contentType: html }), true, String(status));
		}
		assert.equal(shouldAlertOnResponse({ status: 503, method: 'HEAD', pathname: '/posts/a', contentType: html }), true);
	});
	it('ignores non-5xx, non-HTML, writes and API routes', () => {
		assert.equal(shouldAlertOnResponse({ status: 404, method: 'GET', pathname: '/', contentType: html }), false);
		assert.equal(shouldAlertOnResponse({ status: 503, method: 'GET', pathname: '/sitemap.xml', contentType: 'application/xml' }), false);
		assert.equal(shouldAlertOnResponse({ status: 500, method: 'POST', pathname: '/', contentType: html }), false);
		assert.equal(shouldAlertOnResponse({ status: 500, method: 'GET', pathname: '/_emdash/api/content', contentType: html }), false);
		assert.equal(shouldAlertOnResponse({ status: 500, method: 'GET', pathname: '/api/admin/content-export', contentType: html }), false);
	});
});

describe('outageAlertsEnabled', () => {
	it('defaults to production only; OUTAGE_ALERTS overrides', () => {
		assert.equal(outageAlertsEnabled('production', ''), true);
		assert.equal(outageAlertsEnabled('staging', ''), false);
		assert.equal(outageAlertsEnabled('staging', 'on'), true);
		assert.equal(outageAlertsEnabled('production', 'off'), false);
	});
});

describe('dedupe and recipients', () => {
	it('one KV key per environment, ten-minute window', () => {
		assert.equal(outageAlertDedupeKey('production'), 'ft-outage-alert:v1:production');
		assert.equal(OUTAGE_ALERT_WINDOW_SECONDS, 600);
	});
	it('parses and validates recipient lists', () => {
		assert.deepEqual(parseEmailRecipients(' a@x.news, b@y.com;a@x.news  not-an-email '), ['a@x.news', 'b@y.com']);
		assert.deepEqual(parseEmailRecipients(''), []);
	});
});

describe('messages', () => {
	it('email names host, status, cause, London time and the ray id', () => {
		const m = buildOutageAlertEmail(event);
		assert.equal(m.subject, '[ALERT] freedomtimes.news is serving HTTP 503 (content database unavailable)');
		assert.match(m.text, /Content backend: d1/);
		assert.match(m.text, /abc123-LHR/);
		assert.match(m.text, /23 Nov 2026, 12:00:00 GMT/);
		assert.match(m.html, /freedom times/);
	});
	it('email HTML escapes the URL', () => {
		const m = buildOutageAlertEmail({ ...event, url: 'https://freedomtimes.news/<script>' });
		assert.doesNotMatch(m.html, /<script>/);
	});
	it('push opens /admin and collapses by tag', () => {
		const p = buildOutageAlertPush(event, 'https://freedomtimes.news/');
		assert.equal(p.url, 'https://freedomtimes.news/admin');
		assert.equal(p.tag, 'freedomtimes-outage-production');
		assert.equal(p.urgency, 'high');
	});
});

describe('wiring (source checks)', () => {
	it('middleware alerts on 5xx responses and on a middleware throw, via waitUntil', () => {
		const mw = read('../src/middleware.ts');
		assert.match(mw, /shouldAlertOnResponse\(\{/);
		assert.match(mw, /catch \(error\) \{\s*scheduleOutageAlert\(context, 500, error\);\s*throw error;/);
		assert.match(mw, /waitUntil\(task\)/);
	});
	it('the email path never imports Turso / the content DB at module load', () => {
		const server = read('../src/lib/outage-alert-server.ts');
		assert.doesNotMatch(server, /^import .*(subscriptions-db|emdash\/runtime|@libsql)/m);
		assert.match(server, /await import\('\.\/subscriptions-db'\)/, 'subscriptions DB only loads for push');
	});
	it('500.astro is branded (Header + Layout) and reads no database', () => {
		const page = read('../src/pages/500.astro');
		assert.match(page, /import Header from '\.\.\/components\/Header\.astro'/);
		assert.match(page, /<Header \/>/);
		assert.doesNotMatch(page, /emdash\/runtime|getDb|getEmDash|subscriptions-db|requireEditorialSession/);
		const header = read('../src/components/Header.astro');
		assert.doesNotMatch(header, /emdash\/runtime|getDb|getEmDash/);
	});
});