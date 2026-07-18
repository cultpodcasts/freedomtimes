import { defineConfig } from 'astro/config';
import type { Plugin } from 'vite';
import { fileURLToPath } from 'node:url';
import cloudflare from '@astrojs/cloudflare';
import react from '@astrojs/react';
import emdash from 'emdash/astro';
import { r2 } from '@emdash-cms/cloudflare';
import { cloudflareEmail } from '@emdash-cms/cloudflare/plugins';
import { SITE_DISPLAY_NAME } from './src/lib/site-brand';

if (!process.env.TURSO_DATABASE_URL) {
  throw new Error('TURSO_DATABASE_URL is required for build');
}

const libsqlShimPath = fileURLToPath(new URL('./src/shims/kysely-libsql.ts', import.meta.url));
const libsqlShimEntryUrl = new URL('./src/shims/kysely-libsql.ts', import.meta.url).href;

const emdashDatabase = {
  entrypoint: libsqlShimEntryUrl,
  config: {
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  },
  type: 'sqlite',
} as const;

const emdashStorage = r2({ binding: 'MEDIA' });
const libsqlClientWebPath = fileURLToPath(
  new URL('./node_modules/@libsql/client/lib-esm/web.js', import.meta.url),
);
const sqliteShimPath = fileURLToPath(new URL('./src/shims/better-sqlite3.ts', import.meta.url));
const bindingsShimPath = fileURLToPath(new URL('./src/shims/bindings.ts', import.meta.url));

const isAstroBuild = process.argv.includes('build');

/**
 * @astrojs/cloudflare 14 prebundles astro/assets/fonts/runtime.js during SSR optimizeDeps.
 * On Astro 7 (Vite 8) that pulls in virtual:astro:* modules esbuild cannot resolve at build time.
 * Restrict SSR dep discovery during `astro build` only; dev keeps the adapter defaults.
 */
function cloudflareOptimizeDepsBuildFix(): Plugin {
  const serverEnvs = ['astro', 'ssr', 'prerender'];
  return {
    name: 'freedomtimes:cloudflare-optimize-deps-build-fix',
    enforce: 'post',
    configEnvironment(environmentName) {
      if (!isAstroBuild || !serverEnvs.includes(environmentName)) return;
      return {
        optimizeDeps: {
          noDiscovery: true,
          include: ['@libsql/client', '@libsql/client/web'],
          exclude: ['astro:*', 'virtual:astro:*', 'virtual:astro-cloudflare:*'],
        },
      };
    },
  };
}

// https://astro.build/config
export default defineConfig({
  output: 'server',
  vite: {
    envPrefix: ['PUBLIC_', 'FT_', 'GITHUB_'],
    resolve: {
      alias: {
        '@libsql/kysely-libsql': libsqlShimPath,
        '@libsql/client/web': libsqlClientWebPath,
        'better-sqlite3': sqliteShimPath,
        bindings: bindingsShimPath,
      },
    },
    ssr: {
      external: ['cloudflare:workers'],
      noExternal: ['@libsql/kysely-libsql', '@libsql/client', '@libsql/client/web'],
    },
    plugins: [cloudflareOptimizeDepsBuildFix()],
    build: {
      // EmDash admin PluginRegistry client bundle is ~7.5 MB (all CMS field plugins); splitting needs emdash lazy routes.
      chunkSizeWarningLimit: 8192,
    },
  },
  integrations: [
    react(),
    emdash({
      mcp: true,
      database: emdashDatabase,
      storage: emdashStorage,
      // Official Cloudflare Email Sending provider for EmDash magic links / invites.
      // Activate under Admin → Extensions, then Settings → Email after deploy.
      // Requires Worker send_email binding EMAIL (wrangler.jsonc) + domain onboard.
      plugins: [
        cloudflareEmail({
          from: { email: 'noreply@freedomtimes.news', name: SITE_DISPLAY_NAME },
          replyTo: 'privacy@freedomtimes.news',
          binding: 'EMAIL',
        }),
      ],
    }),
  ],
  adapter: cloudflare({ configPath: './wrangler.build.jsonc' }),
});
