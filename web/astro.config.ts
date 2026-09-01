import { defineConfig } from 'astro/config';
import type { Plugin } from 'vite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import cloudflare from '@astrojs/cloudflare';
import react from '@astrojs/react';
import emdash from 'emdash/astro';
import type { PluginDescriptor } from 'emdash';
import { r2 } from '@emdash-cms/cloudflare';
import { cloudflareEmail } from '@emdash-cms/cloudflare/plugins';
import { embedsPlugin } from '@emdash-cms/plugin-embeds';
import {
  OAUTH_WELL_KNOWN_ALIAS_ENDPOINT,
  OAUTH_WELL_KNOWN_ALIAS_PATTERNS,
  OAUTH_WELL_KNOWN_ROUTE_MANIFEST,
  oauthWellKnownRouteRows,
} from './src/lib/oauth-well-known-paths';
import { SITE_DISPLAY_NAME } from './src/lib/site-brand';
import { magicLinkAndroidSchemePlugin } from './src/vite/magic-link-android-scheme-plugin';

const libsqlShimPath = fileURLToPath(new URL('./src/shims/kysely-libsql.ts', import.meta.url));
const libsqlShimEntryUrl = new URL('./src/shims/kysely-libsql.ts', import.meta.url).href;

// Build-time Turso is required for `.emdash/migrations.json` + `emdash migrate`.
// The libsql shim still prefers Cloudflare Worker secrets at runtime.
const tursoDatabaseUrl =
  process.env.TURSO_DATABASE_URL?.trim() || 'libsql://unused-at-build.invalid';

const emdashDatabase = {
  entrypoint: libsqlShimEntryUrl,
  config: {
    url: tursoDatabaseUrl,
    authToken: process.env.TURSO_AUTH_TOKEN?.trim() || '',
  },
  type: 'sqlite',
  // Keep the Worker shim for runtime secrets; official libSQL executor writes
  // .emdash/migrations.json so `npx emdash migrate` can apply against Turso.
  migrations: {
    entrypoint: 'emdash/db/libsql-migrations',
    manifestConfig: {
      url: tursoDatabaseUrl,
      authTokenEnv: 'TURSO_AUTH_TOKEN',
    },
  },
} as const;

const emdashStorage = r2({ binding: 'MEDIA' });
const libsqlClientWebPath = fileURLToPath(
  new URL('./node_modules/@libsql/client/lib-esm/web.js', import.meta.url),
);
const sqliteShimPath = fileURLToPath(new URL('./src/shims/better-sqlite3.ts', import.meta.url));
const bindingsShimPath = fileURLToPath(new URL('./src/shims/bindings.ts', import.meta.url));

const isAstroBuild = process.argv.includes('build');
const isAstroDev = process.argv.includes('dev') && !isAstroBuild;
if (isAstroDev && /emdash-production/i.test(tursoDatabaseUrl)) {
  throw new Error(
    'astro dev refuses TURSO_DATABASE_URL that looks like production EmDash (migrations.dev is auto). Use a local or staging URL.',
  );
}

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
  // EmDash auth uses Astro sessions (cookie `astro-session` → KV `SESSION`).
  // Default cookie has no Max-Age (browser session only); Capacitor WebViews can
  // drop those when the process is reclaimed. Persist for 14 days like Auth0 refresh.
  session: {
    cookie: {
      name: 'astro-session',
      sameSite: 'lax',
      // Adapter sets Secure in production; keep Path=/ (Astro session default).
      maxAge: 60 * 60 * 24 * 14,
    },
  },
  vite: {
    envPrefix: ['PUBLIC_', 'FT_', 'GITHUB_'],
    resolve: {
      alias: {
        '@libsql/kysely-libsql': libsqlShimPath,
        '@libsql/client/web': libsqlClientWebPath,
        'better-sqlite3': sqliteShimPath,
        bindings: bindingsShimPath,
        // shared/push lives outside web/; Rolldown resolves bare imports from
        // that file, not web/node_modules. Alias the package names to the same
        // entry files Node/Vite would pick from web/ (jose has no root index).
        jose: fileURLToPath(new URL('./node_modules/jose/dist/webapi/index.js', import.meta.url)),
        'webpush-webcrypto': fileURLToPath(
          new URL('./node_modules/webpush-webcrypto/lib/webpush.js', import.meta.url),
        ),
      },
    },
    ssr: {
      external: ['cloudflare:workers'],
      noExternal: ['@libsql/kysely-libsql', '@libsql/client', '@libsql/client/web'],
    },
    plugins: [
      cloudflareOptimizeDepsBuildFix(),
      // EmDash has no magic-link URL builder — rewrite email href for Capacitor Android.
      magicLinkAndroidSchemePlugin(),
    ],
    build: {
      // EmDash admin PluginRegistry client bundle is ~7.5 MB (all CMS field plugins); splitting needs emdash lazy routes.
      chunkSizeWarningLimit: 8192,
    },
  },
  integrations: [
    react(),
    {
      name: 'freedomtimes-oauth-well-known-aliases',
      hooks: {
        'astro:config:setup'({ injectRoute }) {
          for (const pattern of OAUTH_WELL_KNOWN_ALIAS_PATTERNS) {
            injectRoute({ pattern, entrypoint: OAUTH_WELL_KNOWN_ALIAS_ENDPOINT });
          }
        },
        'astro:routes:resolved'({ routes }) {
          const dest = fileURLToPath(new URL(`./${OAUTH_WELL_KNOWN_ROUTE_MANIFEST}`, import.meta.url));
          mkdirSync(dirname(dest), { recursive: true });
          writeFileSync(
            dest,
            `${JSON.stringify(
              oauthWellKnownRouteRows(
                routes.map((route) => ({ pattern: route.pattern, entrypoint: route.entrypoint })),
              ),
              null,
              2,
            )}\n`,
          );
        },
      },
    },
    emdash({
      mcp: true,
      // Reorders EmDash's own `emdash/middleware/redirect` ahead of getRuntime.
      // Do not replace editorial 302s with an app slug map — see emdash-outer-middleware.ts.
      middleware: {
        outer: './src/emdash-outer-middleware.ts',
      },
      database: emdashDatabase,
      // Staging/production must not auto-migrate on first request. Deploy
      // scripts apply `npx emdash migrate` after Turso backup, then `--check`.
      // `dev: "auto"` is local-only: astro.config refuses production-looking
      // TURSO_DATABASE_URL so a mixed .env.dev cannot auto-migrate prod.
      migrations: {
        runtime: 'check',
        dev: 'auto',
      },
      storage: emdashStorage,
      // Official Cloudflare Email Sending provider for EmDash magic links / invites.
      // Activate under Admin → Extensions, then Settings → Email after deploy.
      // Requires Worker send_email binding EMAIL (wrangler.jsonc) + domain onboard.
      // Capacitor Android: magic-link Sign-in button uses HTTPS lander
      // /auth/native-magic-link (see magicLinkAndroidSchemePlugin + native-android-magic-link.ts).
      // EmDash 0.34 factories return PluginDescriptor<SpecificOptions>; emdash()
      // still types plugins as PluginDescriptor<Record<string, unknown>>[].
      plugins: [
        cloudflareEmail({
          from: { email: 'noreply@freedomtimes.news', name: SITE_DISPLAY_NAME },
          replyTo: 'privacy@freedomtimes.news',
          binding: 'EMAIL',
        }),
        // Official embed blocks (youtube, vimeo, tweet, bluesky, mastodon, linkPreview, gist).
        // Reader: EmDash PortableText merges plugin components; FT keeps audio override only.
        embedsPlugin(),
      ] as PluginDescriptor[],
    }),
  ],
  adapter: cloudflare({ configPath: './wrangler.build.jsonc' }),
});
