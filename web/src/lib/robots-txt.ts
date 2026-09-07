/** Public og:image / social-card files served by EmDash. */
export const ROBOTS_PUBLIC_MEDIA_PATH = '/_emdash/api/media/file/';

/** Rest of the CMS (admin, MCP, APIs) stays off-limits to crawlers. */
export const ROBOTS_EMDASH_PREFIX = '/_emdash/';

/**
 * Named link-preview agents. These get their own group so crawlers that only
 * honor a matching User-agent (and ignore `*`) can still fetch og:image URLs.
 * `User-agent: *` also Allows the public media path for everyone else.
 */
export const SOCIAL_PREVIEW_USER_AGENTS = [
	'Twitterbot',
	'facebookexternalhit',
	'Facebot',
	'LinkedInBot',
	'Redditbot',
	'Slackbot',
	'Discordbot',
] as const;

/**
 * Override EmDash default robots.txt so link-preview crawlers can fetch
 * og:image URLs under /_emdash/api/media/file/.
 *
 * Named social agents keep an explicit group. `User-agent: *` also Allows the
 * public media path (longest-match wins over Disallow /_emdash/) so Reddit,
 * Slack, Discord, Google, and any other site can read the image without being
 * listed. The rest of /_emdash/ stays disallowed.
 */
export function buildRobotsTxt(origin: string): string {
	const sitemapUrl = `${origin}/sitemap.xml`;
	return [
		'# Social preview crawlers: allow public media (og:image, etc.) under /_emdash/api/media/file/',
		'# while keeping the rest of /_emdash/ disallowed for these agents.',
		...SOCIAL_PREVIEW_USER_AGENTS.map((agent) => `User-agent: ${agent}`),
		`Allow: ${ROBOTS_PUBLIC_MEDIA_PATH}`,
		`Disallow: ${ROBOTS_EMDASH_PREFIX}`,
		'',
		'User-agent: *',
		'Allow: /',
		`Allow: ${ROBOTS_PUBLIC_MEDIA_PATH}`,
		'',
		'# Disallow admin and API routes',
		`Disallow: ${ROBOTS_EMDASH_PREFIX}`,
		'',
		`Sitemap: ${sitemapUrl}`,
		'',
	].join('\n');
}
