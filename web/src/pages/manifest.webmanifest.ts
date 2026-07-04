import type { APIRoute } from 'astro';

import { SITE_DISPLAY_NAME } from '../lib/site-brand';
import { authorizeReaderApiRequest } from '../lib/editorial-session';

export const GET: APIRoute = async ({ cookies, request, url }) => {
  const auth = await authorizeReaderApiRequest({ cookies, request, url });
  if (auth instanceof Response) {
    return auth;
  }

  const manifest = {
    name: SITE_DISPLAY_NAME,
    short_name: SITE_DISPLAY_NAME,
    description: `${SITE_DISPLAY_NAME} progressive web app for secure news delivery and editorial access.`,
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#ece6d9',
    theme_color: '#1d4b3e',
    icons: [
      {
        src: '/favicon.svg',
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'any',
      },
      {
        src: '/favicon.svg',
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'maskable',
      },
    ],
  };

  return new Response(JSON.stringify(manifest, null, 2), {
    headers: {
      'Content-Type': 'application/manifest+json; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    },
  });
};