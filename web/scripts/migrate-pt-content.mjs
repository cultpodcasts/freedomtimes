/**
 * Operator CLI: migrate Portable Text on one EmDash content item (or scan a collection).
 *
 * **Operators** run this from a terminal. **AI agents** should use Cursor EmDash MCP for
 * content writes when payloads fit; this script exists so large PT arrays and iterative
 * migration can be dry-run / applied without hand-editing JSON.
 *
 * Usage (from web/):
 *   node scripts/migrate-pt-content.mjs --list-transforms
 *   node scripts/migrate-pt-content.mjs posts --scan
 *   node scripts/migrate-pt-content.mjs posts <slug>                 # dry-run (default)
 *   node scripts/migrate-pt-content.mjs posts <slug> --transforms video
 *   node scripts/migrate-pt-content.mjs posts <slug> --apply --publish
 *   node scripts/migrate-pt-content.mjs posts <slug> --apply --publish --url https://staging.freedomtimes.news
 *
 * Reports land under data/pt-migrate/<slug>-<timestamp>.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emdashMcpToolsCall } from './emdash-mcp-client.mjs';
import {
	PROD_DEFAULT,
	resolveBaseUrl,
	resolveEmDashBearer,
	STAGING_DEFAULT,
} from './lib/emdash-mcp-auth.mjs';
import {
	applyTransforms,
	listTransforms,
	resolveTransforms,
} from './lib/pt-migrate/transforms/index.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const reportDir = path.join(__dirname, '../data/pt-migrate');

function usage() {
	console.log(`Usage:
  node scripts/migrate-pt-content.mjs --list-transforms
  node scripts/migrate-pt-content.mjs <collection> --scan [--transforms video]
  node scripts/migrate-pt-content.mjs <collection> <slug> [--transforms video] [--apply] [--publish]
  node scripts/migrate-pt-content.mjs … --url ${STAGING_DEFAULT}

Default is dry-run: fetch live content, print a change table, write a report JSON.
--apply writes via MCP content_update. --publish then content_publish (staging/live revision).
Production URL requires EMDASH_ALLOW_PRODUCTION=1.`);
}

function parseArgs(argv) {
	const flags = {
		listTransforms: false,
		scan: false,
		apply: false,
		publish: false,
		transforms: [],
		url: resolveBaseUrl(argv),
		collection: null,
		slug: null,
	};
	const positional = [];
	for (let i = 2; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--list-transforms') flags.listTransforms = true;
		else if (a === '--scan') flags.scan = true;
		else if (a === '--apply') flags.apply = true;
		else if (a === '--publish') flags.publish = true;
		else if (a === '--help' || a === '-h') flags.help = true;
		else if (a === '--url' && argv[i + 1]) {
			flags.url = argv[++i].replace(/\/$/, '');
			continue;
		} else if (a === '--transforms' && argv[i + 1]) {
			flags.transforms = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
			continue;
		} else if (a.startsWith('-')) {
			throw new Error(`Unknown flag: ${a}`);
		} else {
			positional.push(a);
		}
	}
	flags.collection = positional[0] ?? null;
	flags.slug = positional[1] ?? null;
	return flags;
}

function printChangeTable(changes) {
	if (changes.length === 0) {
		console.log('No matching blocks to migrate.');
		return;
	}
	console.log(`\n${changes.length} change(s):\n`);
	for (const c of changes) {
		const before = summarize(c.before);
		const after = summarize(c.after);
		console.log(`  [${c.index}] ${c.transform}/${c.kind}`);
		console.log(`      before: ${before}`);
		console.log(`      after:  ${after}`);
		if (c.note) console.log(`      note:   ${c.note}`);
	}
	console.log('');
}

function summarize(obj) {
	if (!obj || typeof obj !== 'object') return String(obj);
	const bits = [`_type=${obj._type}`];
	for (const k of ['src', 'url', 'id', 'provider', 'title', 'caption', 'alt']) {
		if (obj[k] != null && obj[k] !== '') {
			const v = String(obj[k]);
			bits.push(`${k}=${v.length > 72 ? `${v.slice(0, 69)}…` : v}`);
		}
	}
	return bits.join(' ');
}

function writeReport(slug, report) {
	fs.mkdirSync(reportDir, { recursive: true });
	const ts = new Date().toISOString().replace(/[:.]/g, '-');
	const file = path.join(reportDir, `${slug}-${ts}.json`);
	fs.writeFileSync(file, JSON.stringify(report, null, 2));
	return file;
}

async function mcp(url, token, tool, args) {
	return emdashMcpToolsCall(url, token, tool, args);
}

async function contentGet(url, token, collection, id) {
	const out = await mcp(url, token, 'content_get', { collection, id });
	const item = out.item ?? out;
	const _rev = out._rev;
	if (!item || typeof item !== 'object') {
		throw new Error(`content_get returned unexpected shape for ${collection}/${id}`);
	}
	return { item, _rev };
}

async function scanCollection(url, token, collection, transforms) {
	/** @type {object[]} */
	const hits = [];
	let cursor;
	do {
		/** @type {Record<string, unknown>} */
		const args = { collection, limit: 100 };
		if (cursor) args.cursor = cursor;
		const page = await mcp(url, token, 'content_list', args);
		const items = page.items ?? [];
		for (const item of items) {
			const content = item.data?.content;
			if (!Array.isArray(content)) continue;
			const { changes, stats } = applyTransforms(content, transforms);
			if (changes.length === 0) continue;
			hits.push({
				slug: item.slug,
				status: item.status,
				changed: stats.changed,
				byKind: stats.byKind,
			});
		}
		cursor = page.nextCursor ?? null;
	} while (cursor);

	console.log(`Scan ${collection} @ ${url}: ${hits.length} item(s) need migration\n`);
	for (const h of hits) {
		console.log(`  ${h.status.padEnd(10)} ${h.slug}  (${h.changed} change(s) ${JSON.stringify(h.byKind)})`);
	}
	return hits;
}

async function migrateOne(url, token, flags, transforms) {
	const { collection, slug } = flags;
	const { item, _rev } = await contentGet(url, token, collection, slug);
	const content = item.data?.content;
	if (!Array.isArray(content)) {
		throw new Error(`No Portable Text content array on ${collection}/${slug}`);
	}

	const { content: nextContent, changes, stats } = applyTransforms(content, transforms);
	printChangeTable(changes);

	const report = {
		url,
		collection,
		slug,
		status: item.status,
		_rev,
		dryRun: !flags.apply,
		stats,
		changes,
		contentBeforeLength: content.length,
		contentAfterLength: nextContent.length,
		content: nextContent,
	};
	const reportPath = writeReport(slug, report);
	console.log(`Report: ${reportPath}`);
	console.log(`Stats: ${JSON.stringify(stats)}`);

	if (!flags.apply) {
		console.log('\nDry-run only. Re-run with --apply [--publish] to write.');
		return report;
	}

	if (changes.length === 0) {
		console.log('Nothing to apply.');
		return report;
	}

	console.log(`\ncontent_update ${collection}/${slug} …`);
	await mcp(url, token, 'content_update', {
		collection,
		id: slug,
		_rev,
		data: { content: nextContent },
	});

	if (flags.publish) {
		console.log(`content_publish ${collection}/${slug} …`);
		await mcp(url, token, 'content_publish', { collection, id: slug });
	} else {
		console.log('Updated draft/revision only (no --publish).');
	}

	console.log('Done.');
	return report;
}

async function main() {
	let flags;
	try {
		flags = parseArgs(process.argv);
	} catch (e) {
		console.error(e.message);
		usage();
		process.exit(1);
	}

	if (flags.help) {
		usage();
		process.exit(0);
	}

	if (flags.listTransforms) {
		for (const t of listTransforms()) {
			console.log(`${t.id}\n  ${t.description}`);
		}
		process.exit(0);
	}

	if (!flags.collection) {
		usage();
		process.exit(1);
	}

	const url = flags.url;
	if (url.replace(/\/$/, '') === PROD_DEFAULT.replace(/\/$/, '') && process.env.EMDASH_ALLOW_PRODUCTION !== '1') {
		console.error('Refusing production URL without EMDASH_ALLOW_PRODUCTION=1');
		process.exit(1);
	}

	const transforms = resolveTransforms(flags.transforms);
	const { token, source } = resolveEmDashBearer(url);
	if (process.env.EMDASH_MCP_AUTH_DEBUG === '1') {
		console.error(`Using token from ${source} for ${url}`);
	}

	if (flags.scan) {
		await scanCollection(url, token, flags.collection, transforms);
		return;
	}

	if (!flags.slug) {
		console.error('Slug required unless --scan / --list-transforms');
		usage();
		process.exit(1);
	}

	await migrateOne(url, token, flags, transforms);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
