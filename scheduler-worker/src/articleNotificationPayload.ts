/**
 * Builds web / FCM / queue payloads for “new article” pushes. Central place to tweak copy, URLs, and imagery.
 */

export type PushNotificationPayload = {
	title: string;
	body: string;
	/** Absolute article URL (e.g. https://freedomtimes.news/posts/slug). */
	url: string;
	icon: string;
	badge: string;
	tag: string;
	ttl: number;
	urgency: 'very-low' | 'low' | 'normal' | 'high';
	/**
	 * Absolute HTTPS URL for rich notifications (OG / hero). Omit when unknown.
	 * Web: NotificationOptions.image; FCM: notification.image; passed in APNS custom payload for native apps.
	 */
	image?: string;
};

/** Shape returned by `/api/recent-published-posts.json` (subset used for pushes). */
export type RecentPostForPush = {
	id: string;
	slug: string;
	title: string;
	excerpt: string | null;
	publishedAt: string | null;
	/** Absolute image URL from the site API, or null. */
	image?: string | null;
};

export { buildArticlePushPayload } from '../../shared/push/articleNotificationPayload.mjs';
