#!/usr/bin/env node
/**
 * Turn an /admin/content-export download (.sql or .sql.gz) into a SQLite .db file (PR #198).
 *
 *   node web/scripts/sqlite-from-content-export.mjs <export.sql[.gz]> <out.db>
 *
 * Refuses a truncated download (no "-- end of export" trailer), refuses to overwrite <out.db>,
 * runs PRAGMA integrity_check and prints row counts per table. No sqlite3 CLI needed (node:sqlite).
 * The output is a private backup: keep it under .release/backups/ (gitignored), never commit it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gunzipSync } from 'node:zlib';

export const EXPORT_TRAILER = '-- end of export';

export function readContentExport(file) {
	const raw = fs.readFileSync(file);
	const isGzip = raw.length > 2 && raw[0] === 0x1f && raw[1] === 0x8b;
	const text = (isGzip ? gunzipSync(raw) : raw).toString('utf8');
	if (!text.trimEnd().endsWith(EXPORT_TRAILER)) {
		throw new Error(`${file} is incomplete (no "${EXPORT_TRAILER}" trailer). The download was cut off; export again.`);
	}
	return text;
}

export function restoreContentExport(text, outFile) {
	const db = new DatabaseSync(outFile);
	try {
		// Format 2 exports carry no BEGIN/COMMIT (Cloudflare D1 rejects them); restore atomically here.
		// Format 1 files (before the D1 interop fix) open their own transaction.
		const ownTransaction = /^BEGIN TRANSACTION;$/m.test(text);
		if (ownTransaction) db.exec(text);
		else {
			db.exec('BEGIN');
			try {
				db.exec(text);
				db.exec('COMMIT');
			} catch (error) {
				db.exec('ROLLBACK');
				throw error;
			}
		}
		const fkViolations = db.prepare('PRAGMA foreign_key_check').all();
		// Reported, not fatal: the source database may already hold them (D1 and SQLite allow it).
		if (fkViolations.length > 0) console.warn(`WARNING: foreign_key_check reports ${fkViolations.length} violation(s)`);
		const integrity = Object.values(db.prepare('PRAGMA integrity_check').get())[0];
		if (integrity !== 'ok') throw new Error(`integrity_check failed: ${integrity}`);
		const tables = db
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
			.all()
			.map((r) => String(r.name));
		const counts = {};
		for (const name of tables) {
			counts[name] = Number(db.prepare(`SELECT COUNT(*) AS n FROM "${name.replaceAll('"', '""')}"`).get().n);
		}
		return counts;
	} finally {
		db.close();
	}
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
if (isMain) {
	const [input, output] = process.argv.slice(2);
	if (!input || !output) {
		console.error('Usage: node web/scripts/sqlite-from-content-export.mjs <export.sql[.gz]> <out.db>');
		process.exit(2);
	}
	if (fs.existsSync(output)) {
		console.error(`Refusing to overwrite ${output}.`);
		process.exit(2);
	}
	try {
		const counts = restoreContentExport(readContentExport(input), output);
		for (const [name, n] of Object.entries(counts)) console.log(`${name}: ${n}`);
		console.log(`OK: ${output} (integrity_check ok, ${Object.keys(counts).length} tables)`);
	} catch (error) {
		fs.rmSync(output, { force: true });
		console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
}