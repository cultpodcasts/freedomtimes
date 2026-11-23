/**
 * Immediate alert when a Freedom Times Worker serves a 5xx error page (PR #198).
 *
 * Pure policy and message building; src/lib/outage-alert-server.ts does the I/O (KV dedupe, the
 * Cloudflare `send_email` binding EMAIL, best-effort app push to admin devices). Nothing here, or in
 * the email path, touches Turso or the content database (that is usually what just failed).
 *
 * Policy:
 * - fires for any 5xx HTML response to a GET/HEAD (the "Temporarily unavailable" page from
 *   src/pages/500.astro, its 503 content-store variant, EmDash's own 503, a middleware throw);
 * - production only by default (`OUTAGE_ALERTS=on` enables staging/local, `off` disables);
 * - deduped: at most one alert per environment per {@link OUTAGE_ALERT_WINDOW_SECONDS}, so an outage
 *   storm sends one email/push, then a reminder every window while it lasts.
 */

export const OUTAGE_ALERT_WINDOW_SECONDS = 600;
export const OUTAGE_ALERT_FROM = { email: 'noreply@freedomtimes.news', name: 'freedom times alerts' } as const;

export type OutageAlertEnvironment = 'production' | 'staging' | 'local';

export type OutageAlertEvent = {
	environment: OutageAlertEnvironment;
	status: number;
	method: string;
	url: string;
	cfRay: string;
	at: Date;
	contentStoreUnavailable: boolean;
	contentBackend: string;
	/** Short error message when the middleware itself threw (never a stack or request data). */
	error?: string;
};

/** Shared request rule for both the response and the throw path: reader page loads only. */
function isAlertableRequest(input: { method: string; pathname: string }): boolean {
	if (input.method !== 'GET' && input.method !== 'HEAD') return false;
	// EmDash CMS/API JSON errors are not reader pages (and are noisy during editing).
	return !input.pathname.startsWith('/_emdash/api/') && !input.pathname.startsWith('/api/');
}

export function shouldAlertOnResponse(input: {
	status: number;
	method: string;
	pathname: string;
	contentType: string | null;
}): boolean {
	if (input.status < 500 || input.status > 599) return false;
	if (!isAlertableRequest(input)) return false;
	return (input.contentType ?? '').toLowerCase().includes('text/html');
}

/** A middleware throw becomes a 500 page; alert under the same method/path rules as a response. */
export function shouldAlertOnThrow(input: { method: string; pathname: string }): boolean {
	return isAlertableRequest(input);
}

export function outageAlertsEnabled(environment: OutageAlertEnvironment, setting: string): boolean {
	const value = setting.trim().toLowerCase();
	if (value === 'off' || value === '0' || value === 'false') return false;
	if (value === 'on' || value === '1' || value === 'true') return true;
	return environment === 'production';
}

export function outageAlertDedupeKey(environment: OutageAlertEnvironment): string {
	return `ft-outage-alert:v1:${environment}`;
}

const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

/** Comma / semicolon / whitespace separated list → valid unique addresses (or ids). */
export function parseList(raw: string, validate?: (item: string) => boolean): string[] {
	const items = raw
		.split(/[\s,;]+/)
		.map((s) => s.trim())
		.filter(Boolean);
	return [...new Set(items)].filter((item) => (validate ? validate(item) : true));
}

export function parseEmailRecipients(raw: string): string[] {
	return parseList(raw, (s) => EMAIL_RE.test(s));
}

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

function londonTime(at: Date): string {
	return `${new Intl.DateTimeFormat('en-GB', {
		timeZone: 'Europe/London',
		dateStyle: 'medium',
		timeStyle: 'long',
	}).format(at)}`;
}

export function buildOutageAlertEmail(event: OutageAlertEvent): { subject: string; text: string; html: string } {
	const kind = event.contentStoreUnavailable ? 'content database unavailable' : 'server error';
	const host = (() => {
		try {
			return new URL(event.url).host;
		} catch {
			return event.environment;
		}
	})();
	const subject = `[ALERT] ${host} is serving HTTP ${event.status} (${kind})`;
	const lines = [
		`${host} (${event.environment}) just served the "Temporarily unavailable" error page.`,
		'',
		`Status:          HTTP ${event.status} (${kind})`,
		`URL:             ${event.url}`,
		`When:            ${londonTime(event.at)} (${event.at.toISOString()})`,
		`Content backend: ${event.contentBackend}`,
		`Cloudflare ray:  ${event.cfRay || 'n/a'}`,
		...(event.error ? [`Error:           ${event.error}`] : []),
		'',
		`Further errors in the next ${OUTAGE_ALERT_WINDOW_SECONDS / 60} minutes are folded into this alert; you will get another if it is still happening after that.`,
		'',
		'Check: Cloudflare dashboard > Workers > Logs for this ray id; the site itself; web/docs/CONTENT_BACKEND.md for the D1/Turso switch.',
	];
	const text = lines.join('\n');
	const html = `<!doctype html><html><body style="font-family:Georgia,serif;color:#111;max-width:640px">`
		+ `<p style="font-family:'Playfair Display',Georgia,serif;font-size:28px;font-weight:900;margin:0 0 4px">freedom times</p>`
		+ `<p style="font-family:Arial,sans-serif;font-size:12px;letter-spacing:.05em;color:#7a1a1a;font-weight:700;margin:0 0 16px">OUTAGE ALERT</p>`
		+ `<pre style="font-family:Menlo,Consolas,monospace;font-size:13px;white-space:pre-wrap;background:#fce8e8;padding:12px;border-left:4px solid #7a1a1a">${escapeHtml(text)}</pre>`
		+ `</body></html>`;
	return { subject, text, html };
}

export function buildOutageAlertPush(event: OutageAlertEvent, siteOrigin: string) {
	const origin = siteOrigin.replace(/\/$/, '');
	return {
		title: `Freedom Times ${event.environment}: HTTP ${event.status}`,
		body: event.contentStoreUnavailable
			? 'The site is serving "Temporarily unavailable" (content database unreachable).'
			: 'The site is serving "Temporarily unavailable" (server error).',
		url: `${origin}/admin`,
		icon: `${origin}/favicon.svg`,
		badge: `${origin}/favicon.svg`,
		tag: `freedomtimes-outage-${event.environment}`,
		ttl: OUTAGE_ALERT_WINDOW_SECONDS,
		urgency: 'high' as const,
	};
}

/** Rate limit for the admin test send: one test email per environment per minute. */
export const OUTAGE_ALERT_TEST_WINDOW_SECONDS = 60;

export function outageAlertTestKey(environment: string): string {
	return `ft-outage-alert-test:v1:${environment}`;
}

export type OutageAlertTestRequest = {
	environment: string;
	host: string;
	at: Date;
	requestedBy: string;
	alertsEnabled: boolean;
	contentBackend: string;
};

/**
 * The admin "send test alert" email. Same sender and channel as a real alert, but the subject
 * starts with [TEST] and names the environment, so nobody mistakes it for an outage.
 */
export function buildOutageAlertTestEmail(req: OutageAlertTestRequest): { subject: string; text: string; html: string } {
	const subject = `[TEST] Freedom Times ${req.environment} outage alert email (${req.host})`;
	const lines = [
		`TEST ONLY - ${req.host} (${req.environment}) is not down.`,
		'',
		'This is a test of the outage alert email. A real alert uses this sender and these recipients when',
		'the site serves the "Temporarily unavailable" (HTTP 5xx) page.',
		'',
		`Environment:      ${req.environment}`,
		`Real alerts:      ${req.alertsEnabled ? 'ON' : 'OFF (set OUTAGE_ALERTS=on to enable)'}`,
		`Content backend:  ${req.contentBackend}`,
		`Requested by:     ${req.requestedBy}`,
		`When:             ${londonTime(req.at)} (${req.at.toISOString()})`,
	];
	const text = lines.join('\n');
	const html = `<!doctype html><html><body style="font-family:Georgia,serif;color:#111;max-width:640px">`
		+ `<p style="font-family:'Playfair Display',Georgia,serif;font-size:28px;font-weight:900;margin:0 0 4px">freedom times</p>`
		+ `<p style="font-family:Arial,sans-serif;font-size:12px;letter-spacing:.05em;color:#0044bb;font-weight:700;margin:0 0 16px">OUTAGE ALERT · TEST</p>`
		+ `<pre style="font-family:Menlo,Consolas,monospace;font-size:13px;white-space:pre-wrap;background:#e8eefc;padding:12px;border-left:4px solid #0044bb">${escapeHtml(text)}</pre>`
		+ `</body></html>`;
	return { subject, text, html };
}

/** Constant-time string compare for the optional operator test token. */
export function timingSafeEqualString(a: string, b: string): boolean {
	const enc = new TextEncoder();
	const x = enc.encode(a);
	const y = enc.encode(b);
	let diff = x.length ^ y.length;
	for (let i = 0; i < Math.max(x.length, y.length); i += 1) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
	return diff === 0;
}

/** Minimum length for OUTAGE_ALERT_TEST_TOKEN; a shorter (or unset) token disables the bearer path. */
export const OUTAGE_ALERT_TEST_TOKEN_MIN_LENGTH = 32;
