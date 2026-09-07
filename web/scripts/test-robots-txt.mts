import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
	ROBOTS_EMDASH_PREFIX,
	ROBOTS_PUBLIC_MEDIA_PATH,
	SOCIAL_PREVIEW_USER_AGENTS,
	buildRobotsTxt,
} from '../src/lib/robots-txt.ts';

const middlewareSource = readFileSync(
	fileURLToPath(new URL('../src/middleware.ts', import.meta.url)),
	'utf8',
);

const OG_IMAGE_PATH = `${ROBOTS_PUBLIC_MEDIA_PATH}01M1XH4BAJ480X5RB7VS3JGN6A.png`;
const EMDASH_ADMIN_PATH = `${ROBOTS_EMDASH_PREFIX}admin`;
const EMDASH_API_PATH = `${ROBOTS_EMDASH_PREFIX}api/mcp`;

type RobotsRule = { allow: boolean; path: string };
type RobotsGroup = { agents: string[]; rules: RobotsRule[] };

/** Google-style: ignore blanks/comments; consecutive User-agent lines start a group. */
function parseRobotsTxt(body: string): RobotsGroup[] {
	const groups: RobotsGroup[] = [];
	let current: RobotsGroup | null = null;
	let acceptingAgents = false;

	for (const raw of body.split('\n')) {
		const line = raw.replace(/#.*$/, '').trim();
		if (!line) continue;

		const userAgent = /^user-agent:\s*(.+)$/i.exec(line);
		if (userAgent) {
			const agent = userAgent[1].trim();
			if (!current || !acceptingAgents) {
				current = { agents: [], rules: [] };
				groups.push(current);
			}
			current.agents.push(agent);
			acceptingAgents = true;
			continue;
		}

		const allow = /^allow:\s*(.*)$/i.exec(line);
		const disallow = /^disallow:\s*(.*)$/i.exec(line);
		if ((allow || disallow) && current) {
			acceptingAgents = false;
			current.rules.push({
				allow: Boolean(allow),
				path: (allow?.[1] ?? disallow?.[1] ?? '').trim() || '/',
			});
		}
	}

	return groups;
}

/**
 * Most specific matching User-agent group (longest token). `*` is a match of
 * specificity 0; a named token contained in the UA wins when longer.
 */
function selectRobotsGroup(body: string, userAgent: string): RobotsGroup | null {
	const groups = parseRobotsTxt(body);
	const ua = userAgent.toLowerCase();
	let bestGroup: RobotsGroup | null = null;
	let bestAgentLen = -1;

	for (const group of groups) {
		for (const agent of group.agents) {
			const token = agent.toLowerCase();
			if (token === '*' || ua.includes(token)) {
				const specificity = token === '*' ? 0 : token.length;
				if (specificity > bestAgentLen) {
					bestAgentLen = specificity;
					bestGroup = group;
				}
			}
		}
	}

	return bestGroup;
}

/**
 * Google-style: longest matching path rule. Equal-length Allow wins.
 * No matching rule → allowed.
 */
function isRobotsPathAllowed(body: string, userAgent: string, path: string): boolean {
	const bestGroup = selectRobotsGroup(body, userAgent);
	if (!bestGroup) return true;

	let bestLen = -1;
	let allowed = true;
	for (const rule of bestGroup.rules) {
		if (!path.startsWith(rule.path)) continue;
		if (rule.path.length > bestLen) {
			bestLen = rule.path.length;
			allowed = rule.allow;
		} else if (rule.path.length === bestLen && rule.allow) {
			allowed = true;
		}
	}
	return allowed;
}

/**
 * First matching rule in the chosen group wins (document order).
 * No matching rule → allowed. Do not weaken this if the generator emits
 * `Allow: /` — `/` prefixes every path and would allow admin/MCP.
 */
function isRobotsPathAllowedFirstMatch(body: string, userAgent: string, path: string): boolean {
	const bestGroup = selectRobotsGroup(body, userAgent);
	if (!bestGroup) return true;

	for (const rule of bestGroup.rules) {
		if (path.startsWith(rule.path)) return rule.allow;
	}
	return true;
}

describe('buildRobotsTxt', () => {
	const body = buildRobotsTxt('https://example.com');

	it('keeps the social-preview comment and lists named preview agents', () => {
		assert.match(body, /# Social preview crawlers: allow public media \(og:image, etc\.\) under \/_emdash\/api\/media\/file\//);
		assert.match(body, /# while keeping the rest of \/_emdash\/ disallowed for these agents\./);
		for (const agent of SOCIAL_PREVIEW_USER_AGENTS) {
			assert.match(body, new RegExp(`^User-agent: ${agent}$`, 'm'), agent);
		}
	});

	it('Allows the public media path under User-agent: * before Disallow /_emdash/', () => {
		const wildcard = body.slice(body.indexOf('User-agent: *'));
		const allowIdx = wildcard.indexOf(`Allow: ${ROBOTS_PUBLIC_MEDIA_PATH}`);
		const disallowIdx = wildcard.indexOf(`Disallow: ${ROBOTS_EMDASH_PREFIX}`);
		assert.ok(allowIdx >= 0, 'missing * Allow for public media');
		assert.ok(disallowIdx >= 0, 'missing * Disallow for /_emdash/');
		assert.ok(allowIdx < disallowIdx, 'Allow media must precede Disallow /_emdash/ for first-match parsers');
		assert.doesNotMatch(wildcard, /^Allow: \/$/m, '* must not emit Allow: / (first-match would allow all /_emdash/)');
		assert.match(wildcard, /# Disallow admin and API routes/);
	});

	it('Allows the public media path in the named-agent group before Disallow /_emdash/', () => {
		const named = body.slice(0, body.indexOf('User-agent: *'));
		const allowIdx = named.indexOf(`Allow: ${ROBOTS_PUBLIC_MEDIA_PATH}`);
		const disallowIdx = named.indexOf(`Disallow: ${ROBOTS_EMDASH_PREFIX}`);
		assert.ok(allowIdx >= 0, 'missing named Allow for public media');
		assert.ok(disallowIdx >= 0, 'missing named Disallow for /_emdash/');
		assert.ok(allowIdx < disallowIdx, 'named Allow media must precede Disallow /_emdash/ for first-match parsers');
		assert.doesNotMatch(named, /^Allow: \/$/m, 'named group must not emit Allow: /');
	});

	it('still disallows the rest of /_emdash/ for * and named social agents', () => {
		assert.match(body, /Sitemap: https:\/\/example\.com\/sitemap\.xml/);
		for (const agent of [...SOCIAL_PREVIEW_USER_AGENTS, 'Googlebot', 'Redditbot/1.0', '*']) {
			assert.equal(isRobotsPathAllowed(body, agent, '/'), true, `${agent} /`);
			assert.equal(isRobotsPathAllowed(body, agent, OG_IMAGE_PATH), true, `${agent} og:image`);
			assert.equal(isRobotsPathAllowed(body, agent, EMDASH_ADMIN_PATH), false, `${agent} admin`);
			assert.equal(isRobotsPathAllowed(body, agent, EMDASH_API_PATH), false, `${agent} mcp`);
		}
	});

	it('lets unlisted preview crawlers fetch og:image via User-agent: *', () => {
		const unlisted = ['TelegramBot', 'WhatsApp', 'Iframely', 'Embedly'];
		for (const token of SOCIAL_PREVIEW_USER_AGENTS) {
			for (const agent of unlisted) {
				assert.equal(
					agent.toLowerCase().includes(token.toLowerCase()),
					false,
					`${agent} must not contain named token ${token}`,
				);
			}
		}
		for (const agent of unlisted) {
			const group = selectRobotsGroup(body, agent);
			assert.ok(group, `${agent} should match a group`);
			assert.deepEqual(group.agents, ['*'], `${agent} must use the * group`);
			assert.equal(isRobotsPathAllowed(body, agent, OG_IMAGE_PATH), true, agent);
			assert.equal(isRobotsPathAllowed(body, agent, EMDASH_ADMIN_PATH), false, `${agent} admin`);
		}
	});

	it('first-match allows og:image and / but disallows admin and MCP for * and a named agent', () => {
		for (const agent of ['*', 'Googlebot', 'Redditbot']) {
			assert.equal(isRobotsPathAllowedFirstMatch(body, agent, OG_IMAGE_PATH), true, `${agent} first-match og:image`);
			assert.equal(isRobotsPathAllowedFirstMatch(body, agent, '/'), true, `${agent} first-match /`);
			assert.equal(isRobotsPathAllowedFirstMatch(body, agent, EMDASH_ADMIN_PATH), false, `${agent} first-match admin`);
			assert.equal(isRobotsPathAllowedFirstMatch(body, agent, EMDASH_API_PATH), false, `${agent} first-match mcp`);
		}
	});
});

describe('robots.txt middleware wiring', () => {
	it('serves GET /robots.txt from buildRobotsTxt (no inline copy)', () => {
		assert.match(middlewareSource, /import \{ buildRobotsTxt \} from '\.\/lib\/robots-txt'/);
		assert.match(middlewareSource, /normalizedPath === '\/robots\.txt'/);
		assert.match(middlewareSource, /const body = buildRobotsTxt\(context\.url\.origin\)/);
		assert.doesNotMatch(middlewareSource, /function buildRobotsTxt/);
		assert.doesNotMatch(middlewareSource, /User-agent: Twitterbot/);
	});
});
