import type { APIRoute } from 'astro';
import { getEmDashCollection, type ContentEntry } from 'emdash';

import { readArticleNotificationImagePath } from '../../lib/content/contentEntry';
import { readEmDashPublishedAt } from '../../lib/content/emdashTimestamps';

export const prerender = false;

function summarizeEntryForLog(entry: ContentEntry<Record<string, unknown>>): Record<string, unknown> {
  const data = entry.data;
  const entryRecord = entry as unknown as Record<string, unknown>;
  return {
    id: entry.id,
    topLevelKeys: Object.keys(entryRecord),
    dataKeys: data && typeof data === 'object' ? Object.keys(data) : [],
    publishedAt: {
      top: entryRecord.publishedAt,
      topType: typeof entryRecord.publishedAt,
      data: data?.publishedAt,
      dataType: typeof data?.publishedAt,
    },
    published_at: {
      top: entryRecord.published_at,
      topType: typeof entryRecord.published_at,
      data: data?.published_at,
      dataType: typeof data?.published_at,
    },
  };
}

export const GET: APIRoute = async ({ request }) => {
  const siteOrigin = new URL(request.url).origin;

  const { entries: postEntries, error: postsError } = await getEmDashCollection('posts', {
    status: 'published',
    limit: 25,
    orderBy: { published_at: 'desc', updated_at: 'desc' },
  });

  if (postsError) {
    return new Response(JSON.stringify({ error: 'Failed to fetch posts' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }

  const posts = postEntries.map((entry) => {
    const data = entry.data;

    const title = typeof data.title === 'string' && data.title.length > 0
      ? data.title
      : 'Untitled post';
      
    const slug = typeof data.slug === 'string' && data.slug.length > 0
      ? data.slug
      : entry.id;

    const excerpt = typeof data.excerpt === 'string' ? data.excerpt : null;

    const publishedAtStr = readEmDashPublishedAt({ data: entry.data });

    if (publishedAtStr == null) {
      console.warn(
        '[recent-published-posts] missing publishedAt after normalization',
        JSON.stringify(summarizeEntryForLog(entry)),
      );
    }

    const imagePath = readArticleNotificationImagePath(entry);
    const image =
      imagePath === null
        ? null
        : imagePath.startsWith('http://') || imagePath.startsWith('https://')
          ? imagePath
          : new URL(imagePath, siteOrigin).toString();

    return {
      id: entry.id,
      slug,
      title,
      excerpt,
      publishedAt: publishedAtStr,
      image,
    };
  });

  return new Response(JSON.stringify({ posts }), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
};
