#!/usr/bin/env node
/**
 * Restore real /admin/content-export downloads into FRESH LOCAL Turso (`turso dev`) and LOCAL D1
 * (`wrangler d1 execute --local`) databases and check them (PR #198). Local only: no Turso Cloud,
 * no Cloudflare account, no --remote. The dumps are private: keep them and the temp dir off Git.
 *
 *   node scripts/verify-content-export-restore.mjs <export.sql[.gz]> [...more] [--targets turso,d1] [--keep]
 *
 * For each file and target: restore into a new empty database, then compare the tables and per-table
 * row counts with the dump's CREATE statements, INSERT counts and trailer, run integrity_check,
 * foreign_key_check, an FTS MATCH, and a full row-by-row digest against a node:sqlite reference
 * restore. Exit 1 if anything does not match. Prints counts only, never row data.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
	compareWithDump,
	createLocalD1,
	digestSqliteFile,
	integrityCheckFile,
	inspectRestored,
	parseDumpExpectations,
	readDumpText,
	restoreIntoTurso,
	startTursoDev,
	tursoQuery,
} from './lib/content-export-restore.mjs';
import { restoreContentExport } from './sqlite-from-content-export.mjs';

const D1_STATEMENT_LIMIT = 100_000;

async function ftsProbe(query, ftsTables) {
	const out = {};
	for (const t of ftsTables) {
		const rows = await query(`SELECT COUNT(*) AS n FROM "${t}" WHERE "${t}" MATCH 'cult OR the OR a'`);
		out[t] = Number(rows[0].n);
	}
	return out;
}

export async function verifyFile(file, { targets = ['turso', 'd1'], keep = false } = {}) {
	const text = await readDumpText(file);
	const expect = parseDumpExpectations(text);
	const report = {
		file: path.basename(file),
		format: expect.format,
		complete: expect.complete,
		tables: expect.tables.size + expect.virtualTables.size,
		rows: Object.fromEntries(expect.trailer),
		preflight: {
			hasBeginCommit: expect.hasTransaction,
			longestLineBytes: expect.maxLineBytes,
			linesOverD1Limit: text.split('\n').filter((l) => Buffer.byteLength(l) > D1_STATEMENT_LIMIT).length,
		},
		targets: {},
	};
	const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-restore-verify-'));
	try {
		const refFile = path.join(work, 'reference.db');
		restoreContentExport(text, refFile);
		const tablesForDigest = [...expect.tables, ...expect.virtualTables];
		const reference = digestSqliteFile(refFile, tablesForDigest);

		for (const target of targets) {
			const dir = path.join(work, target);
			fs.mkdirSync(dir);
			const result = { ok: false, problems: [] };
			report.targets[target] = result;
			let server;
			try {
				let query;
				let sqliteFile;
				const started = Date.now();
				if (target === 'turso') {
					server = await startTursoDev({ workDir: dir });
					await restoreIntoTurso(server, file);
					query = (sql) => tursoQuery(server, sql);
				} else if (target === 'd1') {
					const d1 = createLocalD1(dir);
					await d1.restore(file);
					query = (sql) => d1.query(sql);
					sqliteFile = () => d1.sqliteFile();
				} else throw new Error(`unknown target ${target}`);
				result.restoreMs = Date.now() - started;
				const restored = await inspectRestored(query);
				result.counts = restored.counts;
				result.integrity = `${restored.integrityPragma}: ${restored.integrity}`;
				result.foreignKeyViolations = restored.foreignKeyViolations;
				result.indexes = restored.indexes.length;
				result.triggers = restored.triggers.length;
				result.views = restored.views.length;
				result.fts = await ftsProbe(query, restored.ftsTables);
				result.problems.push(...compareWithDump(expect, restored));
				for (const [t, n] of Object.entries(result.fts)) if (n === 0 && expect.trailer.get(t) > 0) result.problems.push(`${t}: FTS MATCH found nothing`);
				if (server) {
					await server.stop();
					sqliteFile = () => server.dbFile;
				}
				result.fileIntegrityCheck = integrityCheckFile(sqliteFile());
				if (result.fileIntegrityCheck !== 'ok') result.problems.push(`file integrity_check: ${result.fileIntegrityCheck}`);
				const digest = digestSqliteFile(sqliteFile(), tablesForDigest);
				const differ = Object.keys(reference).filter((t) => reference[t] !== digest[t]);
				result.rowDigestMatchesReference = differ.length === 0;
				if (differ.length) result.problems.push(`row content differs from reference in: ${differ.join(', ')}`);
				result.ok = result.problems.length === 0;
			} catch (error) {
				result.problems.push(error instanceof Error ? error.message : String(error));
			} finally {
				await server?.stop();
			}
		}
		return report;
	} finally {
		if (keep) console.error(`kept ${work}`);
		else fs.rmSync(work, { recursive: true, force: true });
	}
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
	const args = process.argv.slice(2);
	const files = args.filter((a) => !a.startsWith('--') && !/^(turso|d1)(,(turso|d1))*$/.test(a));
	const ti = args.indexOf('--targets');
	const targets = ti >= 0 ? args[ti + 1].split(',') : ['turso', 'd1'];
	if (!files.length) {
		console.error('Usage: node scripts/verify-content-export-restore.mjs <export.sql[.gz]> [...] [--targets turso,d1] [--keep]');
		process.exit(2);
	}
	let failed = false;
	for (const file of files) {
		const report = await verifyFile(file, { targets, keep: args.includes('--keep') });
		console.log(JSON.stringify(report, null, 2));
		for (const [target, r] of Object.entries(report.targets)) {
			console.error(`${r.ok ? 'PASS' : 'FAIL'} ${report.file} -> ${target}${r.ok ? '' : `: ${r.problems.join('; ')}`}`);
			failed ||= !r.ok;
		}
	}
	process.exit(failed ? 1 : 0);
}
