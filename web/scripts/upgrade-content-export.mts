/**
 * Rewrite an /admin/content-export file from before the D1 interop fix (format 1: BEGIN/COMMIT,
 * statements up to ~300 KB, which `wrangler d1 execute --file` rejects) into the portable format 2
 * the export writes now. Same rows: it restores the old file into an in-memory SQLite and dumps it
 * again with generateContentDump. Turso/sqlite3 can restore format 1 as-is; D1 needs this.
 *
 *   npx tsx scripts/upgrade-content-export.mts <old.sql[.gz]> <new.sql | new.sql.gz>
 *
 * Refuses to overwrite. Private data: keep both files off Git and shared drives.
 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { gzipSync } from 'node:zlib';

import { generateContentDump, type ContentExportRow } from '../src/lib/content-export';
import { readContentExport } from './sqlite-from-content-export.mjs';

export async function upgradeContentExport(oldText: string): Promise<string> {
	const header = (key: string) => new RegExp(`^-- ${key}: (.+)$`, 'm').exec(oldText)?.[1]?.trim();
	const db = new DatabaseSync(':memory:');
	try {
		db.exec(/^BEGIN TRANSACTION;$/m.test(oldText) ? oldText : `BEGIN;\n${oldText}\nCOMMIT;`);
		const query = async (sql: string) => db.prepare(sql).all() as ContentExportRow[];
		const meta = {
			environment: header('environment') ?? 'unknown',
			backend: header('backend') ?? 'unknown',
			generatedAt: new Date(header('generated') ?? Date.now()),
		};
		let text = '';
		for await (const chunk of generateContentDump(query, meta)) text += chunk;
		return text.replace(/^(-- generated: .+)$/m, `$1\n-- upgraded to format 2 on ${new Date().toISOString()} by scripts/upgrade-content-export.mts`);
	} finally {
		db.close();
	}
}

const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname);
if (isMain) {
	const [input, output] = process.argv.slice(2);
	if (!input || !output) {
		console.error('Usage: npx tsx scripts/upgrade-content-export.mts <old.sql[.gz]> <new.sql | new.sql.gz>');
		process.exit(2);
	}
	if (fs.existsSync(output)) {
		console.error(`Refusing to overwrite ${output}.`);
		process.exit(2);
	}
	const text = await upgradeContentExport(readContentExport(input));
	fs.writeFileSync(output, output.endsWith('.gz') ? gzipSync(text) : text, { mode: 0o600 });
	console.log(`OK: ${output} (format 2)`);
}
