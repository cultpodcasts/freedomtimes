import type { APIRoute } from 'astro';

export const GET: APIRoute = async () => {
  const manifest = {
    name: 'Freedom Times',
    short_name: 'Freedom Times',
    description: 'Freedom Times progressive web app for secure news delivery and editorial access.',
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