import type { APIRoute } from 'astro';
import { getEmDashCollection } from 'emdash';

export const prerender = false;

export const GET: APIRoute = async () => {
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
    const data = entry.data as Record<string, unknown>;
    const entryRecord = entry as Record<string, unknown>;
    
    const title = typeof data.title === 'string' && data.title.length > 0
      ? data.title
      : 'Untitled post';
      
    const slug = typeof data.slug === 'string' && data.slug.length > 0
      ? data.slug
      : entry.id;

    const excerpt = typeof data.excerpt === 'string' ? data.excerpt : null;

    const publishedAt =
      (typeof entryRecord.publishedAt === 'string' ? entryRecord.publishedAt : null)
      ?? (typeof entryRecord.published_at === 'string' ? entryRecord.published_at : null)
      ?? (typeof data.publishedAt === 'string' ? data.publishedAt : null)
      ?? (typeof data.published_at === 'string' ? data.published_at : null)
      ?? null;

    return {
      id: entry.id,
      slug,
      title,
      excerpt,
      publishedAt,
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
