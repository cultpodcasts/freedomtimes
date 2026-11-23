/**
 * GET /api/notifications-status → `{ enabled }` (PR #198). The web callout and the native app bridge
 * ask this before prompting for permission or registering a device. Reasons are admin-only
 * (/admin/feature-switches); readers just get on/off.
 */
import type { APIRoute } from 'astro';

import { publicNotificationsStatus } from '../../lib/notifications-availability';
import { notificationsEnabled } from '../../lib/notifications-availability-server';

export const prerender = false;

export const GET: APIRoute = async () => {
	const enabled = await notificationsEnabled({ healthCheck: true });
	return new Response(JSON.stringify(publicNotificationsStatus(enabled)), {
		headers: {
			'content-type': 'application/json; charset=utf-8',
			// Short: an admin flip reaches readers within a minute (plus the 30 s KV cache).
			'cache-control': 'private, max-age=30',
			'x-robots-tag': 'noindex',
		},
	});
};