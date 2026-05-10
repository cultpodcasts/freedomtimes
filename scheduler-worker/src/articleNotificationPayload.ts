/**
 * Builds web / FCM / queue payloads for “new article” pushes. Central place to tweak copy, URLs, and imagery.
 */

export type PushNotificationPayload = {
	title: string;
	body: string;
	/** In-app path (e.g. /posts/slug). */
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

function normalizeSiteOrigin(raw: string): string {
	return raw.trim().replace(/\/$/, '');
}

/**
 * Turn a recent-post row into the JSON body sent through web-push and mobile pipelines.
 * Icons use absolute URLs so FCM/APNs clients resolve them reliably.
 */
export function buildArticlePushPayload(siteOrigin: string, post: RecentPostForPush): PushNotificationPayload {
	const origin = normalizeSiteOrigin(siteOrigin);
	const imageRaw = typeof post.image === 'string' ? post.image.trim() : '';
	let image: string | undefined;
	if (imageRaw.length > 0) {
		image =
			imageRaw.startsWith('https://') || imageRaw.startsWith('http://')
				? imageRaw
				: `${origin}${imageRaw.startsWith('/') ? imageRaw : `/${imageRaw}`}`;
		if (!image.startsWith('https://')) {
			image = undefined;
		}
	}

	const payload: PushNotificationPayload = {
		title: post.title,
		body: post.excerpt?.trim() || 'Read the latest story on freedom times.',
		url: `/posts/${post.slug}`,
		icon: `${origin}/favicon.svg`,
		badge: `${origin}/favicon.svg`,
		tag: `article-${post.id}`,
		ttl: 86_400,
		urgency: 'high',
	};
	if (image) {
		payload.image = image;
	}
	return payload;
}
