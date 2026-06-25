/**
 * Shared push payload builder for article notifications (scheduler + operator send-test).
 * Keep in sync with scheduler-worker/src/articleNotificationPayload.ts types.
 */

function normalizeSiteOrigin(raw) {
  return raw.trim().replace(/\/$/, '');
}

/** @param {string} siteOrigin @param {{ id: string; slug: string; title: string; excerpt: string | null; image?: string | null }} post */
export function buildArticlePushPayload(siteOrigin, post) {
  const origin = normalizeSiteOrigin(siteOrigin);
  const imageRaw = typeof post.image === 'string' ? post.image.trim() : '';
  let image;
  if (imageRaw.length > 0) {
    image =
      imageRaw.startsWith('https://') || imageRaw.startsWith('http://')
        ? imageRaw
        : `${origin}${imageRaw.startsWith('/') ? imageRaw : `/${imageRaw}`}`;
    if (!image.startsWith('https://')) {
      image = undefined;
    }
  }

  const payload = {
    title: post.title,
    body: post.excerpt?.trim() || 'Read the latest story on freedom times.',
    url: `${origin}/posts/${post.slug}`,
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
