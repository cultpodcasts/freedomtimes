// @ts-check
import { defineConfig } from 'astro/config';
import { fileURLToPath } from 'node:url';
import cloudflare from '@astrojs/cloudflare';
import react from '@astrojs/react';
import emdash from 'emdash/astro';
import { r2 } from '@emdash-cms/cloudflare';

if (!process.env.TURSO_DATABASE_URL) {
	throw new Error('TURSO_DATABASE_URL is required for build');
}

const libsqlShimPath = fileURLToPath(new URL('./src/shims/kysely-libsql.js', import.meta.url));
const libsqlShimEntryUrl = new URL('./src/shims/kysely-libsql.js', import.meta.url).href;

const emdashDatabase = {
	entrypoint: libsqlShimEntryUrl,
	config: {
		url: process.env.TURSO_DATABASE_URL,
		authToken: process.env.TURSO_AUTH_TOKEN,
	},
	type: 'sqlite',
};

const emdashStorage = r2({ binding: 'MEDIA' });
const libsqlClientWebPath = fileURLToPath(
	new URL('./node_modules/@libsql/client/lib-esm/web.js', import.meta.url),
);
const sqliteShimPath = fileURLToPath(new URL('./src/shims/better-sqlite3.js', import.meta.url));
const bindingsShimPath = fileURLToPath(new URL('./src/shims/bindings.js', import.meta.url));

// https://astro.build/config
export default defineConfig({
	output: 'server',
	vite: {
		resolve: {
			alias: {
				'@libsql/kysely-libsql': libsqlShimPath,
				'@libsql/client/web': libsqlClientWebPath,
				'better-sqlite3': sqliteShimPath,
				bindings: bindingsShimPath,
			},
		},
		ssr: {
			noExternal: ['@libsql/kysely-libsql', '@libsql/client', '@libsql/client/web'],
		},
		optimizeDeps: {
			include: ['@libsql/kysely-libsql', '@libsql/client', '@libsql/client/web'],
		},
	},
	integrations: [
		react(),
		emdash({
			mcp: true,
			database: emdashDatabase,
			storage: emdashStorage,
		}),
	],
	adapter: cloudflare({ configPath: './wrangler.build.jsonc' }),
});
