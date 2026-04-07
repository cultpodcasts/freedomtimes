// @ts-check
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import react from '@astrojs/react';
import emdash, { local } from 'emdash/astro';
import { libsql } from 'emdash/db';
import { r2 } from '@emdash-cms/cloudflare';

if (!process.env.TURSO_DATABASE_URL) {
	throw new Error('TURSO_DATABASE_URL is required for build');
}

const emdashDatabase = libsql({
	url: process.env.TURSO_DATABASE_URL,
	authToken: process.env.TURSO_AUTH_TOKEN,
});

const emdashStorage = process.env.NODE_ENV === 'production'
	? r2({ binding: 'MEDIA' })
	: local({
			directory: './.uploads',
			baseUrl: '/_emdash/api/media/file',
		});

// https://astro.build/config
export default defineConfig({
	output: 'server',
	integrations: [
		react(),
		emdash({
			database: emdashDatabase,
			storage: emdashStorage,
		}),
	],
	adapter: cloudflare({ configPath: './wrangler.build.jsonc' }),
});
