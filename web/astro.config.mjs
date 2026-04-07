// @ts-check
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import emdash, { local } from 'emdash/astro';
import { postgres, sqlite } from 'emdash/db';

const emdashDatabase = process.env.EMDASH_DATABASE_URL
	? postgres({ connectionString: process.env.EMDASH_DATABASE_URL })
	: sqlite({ url: 'file:./.data/emdash.db' });

// https://astro.build/config
export default defineConfig({
	output: 'server',
	integrations: [
		emdash({
			database: emdashDatabase,
			storage: local({
				directory: './.uploads',
				baseUrl: '/_emdash/api/media/file',
			}),
		}),
	],
	adapter: cloudflare({ configPath: './wrangler.build.jsonc' }),
});
