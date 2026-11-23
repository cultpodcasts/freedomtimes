/**
 * Restore an /admin/content-export dump (.sql or .sql.gz) into a FRESH LOCAL database of each
 * production target and check it, without any cloud account (PR #198 interop gate):
 *
 *   - Turso/libSQL: `turso dev` (a local sqld on 127.0.0.1) + `turso db shell <url> < dump`.
 *     Never Turso Cloud: no login, an empty throwaway --config-path, a 127.0.0.1 URL only.
 *   - Cloudflare D1: `wrangler d1 execute <DB> --local --persist-to <tmp> --file dump` (miniflare's
 *     D1, the same statement splitter, transaction trimmer and 100 KB limit as --remote). Never --remote.
 *
 * Used by scripts/test-content-export-restore.mts (CI merge gate, small fixture) and
 * scripts/verify-content-export-restore.mjs (a real downloaded export, locally).
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createGunzip } from 'node:zlib';

const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const EXPORT_TRAILER = '-- end of export';
const FTS_SHADOW = /_(data|idx|content|docsize|config)$/;

export function isGzipFile(file) {
	const fd = fs.openSync(file, 'r');
	try {
		const b = Buffer.alloc(2);
		fs.readSync(fd, b, 0, 2, 0);
		return b[0] === 0x1f && b[1] === 0x8b;
	} finally {
		fs.closeSync(fd);
	}
}

export async function readDumpText(file) {
	const chunks = [];
	const source = fs.createReadStream(file);
	const stream = isGzipFile(file) ? source.pipe(createGunzip()) : source;
	for await (const c of stream) chunks.push(c);
	return Buffer.concat(chunks).toString('utf8');
}

/** What a dump promises: CREATEd tables, INSERT counts and trailer counts per table. */
export function parseDumpExpectations(text) {
	const tables = new Set();
	const virtualTables = new Set();
	const inserts = new Map();
	const trailer = new Map();
	const name = (raw) => (raw.startsWith('"') ? raw.slice(1, -1).replaceAll('""', '"') : raw);
	for (const m of text.matchAll(/^CREATE TABLE (?:IF NOT EXISTS )?("(?:[^"]|"")+"|[^\s(]+)/gm)) tables.add(name(m[1]));
	for (const m of text.matchAll(/^CREATE VIRTUAL TABLE (?:IF NOT EXISTS )?("(?:[^"]|"")+"|[^\s(]+)/gm)) virtualTables.add(name(m[1]));
	for (const m of text.matchAll(/^INSERT INTO ("(?:[^"]|"")+"|[^\s(]+)/gm)) {
		const t = name(m[1]);
		inserts.set(t, (inserts.get(t) ?? 0) + 1);
	}
	const tail = text.slice(text.lastIndexOf('-- rows exported per table:'));
	for (const m of tail.matchAll(/^--   (.+): (\d+)$/gm)) trailer.set(m[1], Number(m[2]));
	const indexes = new Set([...text.matchAll(/^CREATE (?:UNIQUE )?INDEX (?:IF NOT EXISTS )?("(?:[^"]|"")+"|[^\s(]+)/gm)].map((m) => name(m[1])));
	const triggers = new Set([...text.matchAll(/^CREATE (?:TEMP |TEMPORARY )?TRIGGER (?:IF NOT EXISTS )?("(?:[^"]|"")+"|[^\s(]+)/gm)].map((m) => name(m[1])));
	const views = new Set([...text.matchAll(/^CREATE (?:TEMP |TEMPORARY )?VIEW (?:IF NOT EXISTS )?("(?:[^"]|"")+"|[^\s(]+)/gm)].map((m) => name(m[1])));
	let maxStatementBytes = 0;
	for (const line of text.split('\n')) maxStatementBytes = Math.max(maxStatementBytes, Buffer.byteLength(line));
	return {
		tables,
		virtualTables,
		indexes,
		triggers,
		views,
		inserts,
		trailer,
		complete: text.trimEnd().endsWith(EXPORT_TRAILER),
		hasTransaction: /^BEGIN TRANSACTION;$/m.test(text),
		maxLineBytes: maxStatementBytes,
		format: Number(/^-- format: (\d+)/m.exec(text)?.[1] ?? 1),
	};
}

// ---------------------------------------------------------------------------------------------
// Tools

function onPath(bin) {
	const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { encoding: 'utf8' });
	return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : null;
}

/** The turso CLI and the sqld it starts for `turso dev` (PATH, then ~/.turso). */
export function findTursoTools() {
	const home = path.join(os.homedir(), '.turso');
	const turso = process.env.TURSO_CLI || onPath('turso') || (fs.existsSync(path.join(home, 'turso')) ? path.join(home, 'turso') : null);
	const sqld = onPath('sqld') || (fs.existsSync(path.join(home, 'sqld')) ? path.join(home, 'sqld') : null);
	return { turso, sqld, missing: [!turso && 'turso', !sqld && 'sqld'].filter(Boolean) };
}

export function findWrangler() {
	const local = path.join(WEB_DIR, 'node_modules', '.bin', process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler');
	return fs.existsSync(local) ? local : null;
}

export async function freePort() {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.unref();
		srv.on('error', reject);
		srv.listen(0, '127.0.0.1', () => {
			const { port } = srv.address();
			srv.close(() => resolve(port));
		});
	});
}

/** No credentials or account config ever reach the local tools. */
function scrubbedEnv(extra = {}) {
	const env = { ...process.env };
	for (const key of Object.keys(env)) {
		if (/^(TURSO_|LIBSQL_|CLOUDFLARE_|CF_)/i.test(key) && key !== 'TURSO_CLI') delete env[key];
	}
	return { ...env, WRANGLER_SEND_METRICS: 'false', ...extra };
}

function run(cmd, args, { input, env, cwd } = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (d) => (stdout += d));
		child.stderr.on('data', (d) => (stderr += d));
		child.on('error', reject);
		child.on('close', (code) => resolve({ code, stdout, stderr }));
		if (input) {
			pipeline(input, child.stdin).catch((error) => {
				if (error?.code !== 'EPIPE') reject(error);
			});
		} else child.stdin.end();
	});
}

const dumpStream = (file) => (isGzipFile(file) ? fs.createReadStream(file).pipe(createGunzip()) : fs.createReadStream(file));

// ---------------------------------------------------------------------------------------------
// Turso (local sqld via `turso dev`)

export async function startTursoDev({ workDir, tools = findTursoTools() }) {
	if (tools.missing.length) throw new Error(`turso dev needs ${tools.missing.join(' + ')}`);
	const port = await freePort();
	const configDir = path.join(workDir, 'turso-config'); // empty: no login, no cloud token
	fs.mkdirSync(configDir, { recursive: true });
	const dbFile = path.join(workDir, 'turso-dev.db');
	const env = scrubbedEnv({ PATH: [path.dirname(tools.sqld), path.dirname(tools.turso), process.env.PATH].join(path.delimiter) });
	const child = spawn(tools.turso, ['dev', '--config-path', configDir, '--db-file', dbFile, '--port', String(port)], {
		env,
		stdio: ['ignore', 'pipe', 'pipe'],
		detached: process.platform !== 'win32', // own process group: stop() must also end its sqld child
	});
	const killAll = (signal) => {
		try {
			if (process.platform !== 'win32') process.kill(-child.pid, signal);
			else child.kill(signal);
		} catch {}
	};
	let log = '';
	child.stdout.on('data', (d) => (log += d));
	child.stderr.on('data', (d) => (log += d));
	const url = `http://127.0.0.1:${port}`;
	const deadline = Date.now() + 30_000;
	for (;;) {
		if (child.exitCode !== null) throw new Error(`turso dev exited (${child.exitCode}): ${log}`);
		try {
			const res = await fetch(`${url}/health`);
			if (res.ok) break;
		} catch {}
		if (Date.now() > deadline) {
			killAll('SIGKILL');
			throw new Error(`turso dev did not become healthy on ${url}: ${log}`);
		}
		await new Promise((r) => setTimeout(r, 200));
	}
	return {
		url,
		dbFile,
		configDir,
		env,
		turso: tools.turso,
		async stop() {
			if (child.exitCode === null) {
				const exited = new Promise((r) => child.once('exit', r));
				killAll('SIGTERM');
				await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))]);
			}
			killAll('SIGKILL'); // sqld outlives `turso dev` on SIGTERM
			child.stdout.destroy();
			child.stderr.destroy();
		},
	};
}

/** `turso db shell <local url> < dump` (gz streamed through gunzip). Throws on any shell error. */
export async function restoreIntoTurso(server, file) {
	if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(server.url)) throw new Error(`refusing non-local Turso URL ${server.url}`);
	const r = await run(server.turso, ['db', 'shell', '--config-path', server.configDir, server.url], {
		input: dumpStream(file),
		env: server.env,
	});
	const errors = `${r.stderr}\n${r.stdout}`.split('\n').filter((l) => /error/i.test(l));
	if (r.code !== 0 || errors.length) throw new Error(`turso db shell restore failed (exit ${r.code}): ${errors.join(' | ') || r.stderr}`);
	return r;
}

/** One statement over sqld's HTTP API (Hrana v2) -> array of row objects. */
export async function tursoQuery(server, sql) {
	const res = await fetch(`${server.url}/v2/pipeline`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ requests: [{ type: 'execute', stmt: { sql } }, { type: 'close' }] }),
	});
	const body = await res.json();
	const first = body.results?.[0];
	if (!res.ok || first?.type !== 'ok') throw new Error(`turso query failed: ${JSON.stringify(first?.error ?? body)}`);
	const { cols, rows } = first.response.result;
	return rows.map((row) =>
		Object.fromEntries(
			row.map((cell, i) => [
				cols[i].name,
				cell.type === 'null' ? null : cell.type === 'integer' ? Number(cell.value) : cell.type === 'blob' ? cell.base64 : cell.value,
			]),
		),
	);
}

// ---------------------------------------------------------------------------------------------
// Cloudflare D1 (local only: wrangler d1 execute --local --persist-to)

const D1_LOCAL_ID = '00000000-0000-4000-8000-00000000d1d1';

export function createLocalD1(workDir) {
	const wrangler = findWrangler();
	if (!wrangler) throw new Error('wrangler is not installed (npm ci in web/)');
	const dir = path.join(workDir, 'd1');
	fs.mkdirSync(dir, { recursive: true });
	const config = path.join(dir, 'wrangler.jsonc');
	fs.writeFileSync(
		config,
		JSON.stringify({
			name: 'ft-content-export-restore-test',
			compatibility_date: '2026-11-01',
			d1_databases: [{ binding: 'DB', database_name: 'ft-content-export-restore-test', database_id: D1_LOCAL_ID }],
		}),
	);
	const persist = path.join(dir, 'state');
	const env = scrubbedEnv({ XDG_CONFIG_HOME: path.join(dir, 'xdg') }); // no wrangler login either
	const base = ['d1', 'execute', 'DB', '--local', '--persist-to', persist, '--config', config, '--yes'];
	const exec = async (args, input) => {
		const r = await run(wrangler, [...base, ...args], { env, cwd: dir, input });
		if (r.code !== 0) {
			const msg = `${r.stderr}\n${r.stdout}`.split('\n').filter((l) => /ERROR|error|"text"/.test(l)).join(' | ');
			throw new Error(`wrangler d1 execute --local failed (exit ${r.code}): ${msg || r.stderr.slice(-2000)}`);
		}
		return r;
	};
	return {
		dir,
		persist,
		/** wrangler needs a plain file: a .gz is gunzipped to a temp .sql first. */
		async restore(file) {
			let sqlFile = file;
			if (isGzipFile(file)) {
				sqlFile = path.join(dir, `gunzipped-${path.basename(file).replace(/\.gz$/, '')}`);
				await pipeline(fs.createReadStream(file), createGunzip(), fs.createWriteStream(sqlFile));
			}
			try {
				return await exec(['--file', sqlFile]);
			} finally {
				if (sqlFile !== file) fs.rmSync(sqlFile, { force: true });
			}
		},
		async query(sql) {
			const r = await exec(['--command', sql, '--json']);
			const parsed = JSON.parse(r.stdout.slice(r.stdout.indexOf('[')));
			return parsed.at(-1).results;
		},
		/** The miniflare SQLite file behind the local D1 (for a read-only full-content digest). */
		sqliteFile() {
			const found = [];
			const walk = (d) => {
				for (const e of fs.readdirSync(d, { withFileTypes: true })) {
					const p = path.join(d, e.name);
					if (e.isDirectory()) walk(p);
					else if (e.name.endsWith('.sqlite') && !e.name.startsWith('metadata')) found.push(p);
				}
			};
			walk(persist);
			if (found.length !== 1) throw new Error(`expected one local D1 sqlite file, found ${found.length}`);
			return found[0];
		},
	};
}

// ---------------------------------------------------------------------------------------------
// Checks (same for every target; `query(sql)` -> rows)

const q = (name) => `"${String(name).replaceAll('"', '""')}"`;

export async function inspectRestored(query) {
	const master = await query("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name");
	const all = master.filter((m) => m.type === 'table');
	const fts = all.filter((m) => /CREATE\s+VIRTUAL\s+TABLE/i.test(m.sql ?? '') && /USING\s+fts5/i.test(m.sql ?? '')).map((m) => m.name);
	const isShadow = (n) => fts.some((f) => n.startsWith(`${f}_`) && FTS_SHADOW.test(n.slice(f.length)));
	const tables = all.map((m) => m.name).filter((n) => !isShadow(n) && !/^_cf_/i.test(n));
	/** @type {Record<string, number>} */
	const counts = {};
	// Few round trips (each local D1 query is a wrangler process). One row of scalar subqueries:
	// D1 caps compound SELECTs (UNION ALL) far lower than SQLite does.
	for (let i = 0; i < tables.length; i += 50) {
		const part = tables.slice(i, i + 50);
		const sql = `SELECT ${part.map((t, j) => `(SELECT COUNT(*) FROM ${q(t)}) AS c${j}`).join(', ')}`;
		const [row] = await query(sql);
		part.forEach((t, j) => (counts[t] = Number(row[`c${j}`])));
	}
	// D1 forbids PRAGMA integrity_check (SQLITE_AUTH) but allows quick_check.
	let integrityPragma = 'integrity_check';
	let integrity;
	try {
		integrity = (await query('PRAGMA integrity_check')).map((r) => Object.values(r)[0]);
	} catch (error) {
		if (!/SQLITE_AUTH|not authorized/i.test(String(error))) throw error;
		integrityPragma = 'quick_check';
		integrity = (await query('PRAGMA quick_check')).map((r) => Object.values(r)[0]);
	}
	const foreignKeyViolations = (await query('PRAGMA foreign_key_check')).length;
	return {
		tables,
		ftsTables: fts,
		indexes: master.filter((m) => m.type === 'index' && m.sql).map((m) => m.name),
		triggers: master.filter((m) => m.type === 'trigger').map((m) => m.name),
		views: master.filter((m) => m.type === 'view').map((m) => m.name),
		counts,
		integrity: integrity.join(', '),
		integrityPragma,
		foreignKeyViolations,
	};
}

/** Problems comparing a restored database with what its dump promised (empty = good). */
export function compareWithDump(expect, restored) {
	const problems = [];
	const want = new Set([...expect.tables, ...expect.virtualTables]);
	for (const t of want) if (!restored.tables.includes(t)) problems.push(`missing table ${t}`);
	for (const t of restored.tables) if (!want.has(t)) problems.push(`unexpected table ${t}`);
	for (const [t, n] of expect.trailer) {
		if (restored.counts[t] !== n) problems.push(`${t}: trailer says ${n} rows, restored ${restored.counts[t]}`);
		if ((expect.inserts.get(t) ?? 0) !== n) problems.push(`${t}: trailer says ${n} rows, dump has ${expect.inserts.get(t) ?? 0} INSERTs`);
	}
	for (const t of want) if (!expect.trailer.has(t)) problems.push(`${t}: no trailer count`);
	for (const kind of ['indexes', 'triggers', 'views']) {
		const got = new Set(restored[kind]);
		for (const n of expect[kind]) if (!got.has(n)) problems.push(`missing ${kind.slice(0, -1)} ${n}`);
		for (const n of got) if (!expect[kind].has(n)) problems.push(`unexpected ${kind.slice(0, -1)} ${n}`);
	}
	if (restored.integrity !== 'ok') problems.push(`integrity_check: ${restored.integrity}`);
	return problems;
}

/**
 * Digest of every row of every exported table, read straight from a SQLite file (read-only), so two
 * targets (or source vs restore) can be compared byte for byte, not just by counts.
 */
export function digestSqliteFile(file, tables) {
	const db = new DatabaseSync(file, { readOnly: true });
	try {
		/** @type {Record<string, string>} */
		const out = {};
		for (const t of [...tables].sort()) {
			const h = createHash('sha256');
			const cols = db.prepare(`SELECT name FROM pragma_table_info(${`'${t.replaceAll("'", "''")}'`})`).all().map((r) => r.name);
			const orderBy = cols.length ? cols.map((_, i) => String(i + 1)).join(',') : 'rowid';
			for (const row of db.prepare(`SELECT * FROM ${q(t)} ORDER BY ${orderBy}`).iterate()) {
				h.update(
					JSON.stringify(Object.values(row), (_, v) =>
						typeof v === 'bigint' ? `${v}n` : v instanceof Uint8Array ? `blob:${Buffer.from(v).toString('hex')}` : v,
					),
				);
				h.update('\n');
			}
			out[t] = h.digest('hex').slice(0, 16);
		}
		return out;
	} finally {
		db.close();
	}
}

/** PRAGMA integrity_check on a SQLite file (read-only): D1 itself only allows quick_check. */
export function integrityCheckFile(file) {
	const db = new DatabaseSync(file, { readOnly: true });
	try {
		return db.prepare('PRAGMA integrity_check').all().map((r) => Object.values(r)[0]).join(', ');
	} finally {
		db.close();
	}
}
