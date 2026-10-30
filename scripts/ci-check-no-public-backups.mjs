#!/usr/bin/env node
/**
 * P0 guard: database backups are never public (web/docs/DEPLOY.md § Backups are never public).
 *
 * This repository and its Actions logs/artifacts are public. The guard fails CI when:
 *   1. a workflow uploads or caches a path that looks like a database, dump or backup
 *      (actions/upload-artifact, actions/cache[/save], upload-pages-artifact), or a broad
 *      path (".", "**", ".release") that would sweep one up;
 *   2. a workflow command exports or dumps a database (turso db export, .dump, pg_dump, ...)
 *      or writes a backup/.db file into a job summary;
 *   3. git tracks a database/dump file, anything under .release/backups/ other than scripts
 *      and docs, or a .sql file outside infra/*-database/{migrations,seeds}/.
 *
 * Needs no secrets and no npm install: `node scripts/ci-check-no-public-backups.mjs`.
 * Line-based on purpose (no YAML dependency); tests: scripts/ci-check-no-public-backups.test.mjs.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const UPLOAD_OR_CACHE_ACTION =
	/^(actions\/(upload-artifact|cache|cache\/save|upload-pages-artifact)|[\w.-]+\/[\w.-]*(artifact|cache)[\w./-]*)@/i;

/** A path value an artifact/cache step must never include. */
export function isForbiddenStoredPath(rawPath) {
	const value = String(rawPath ?? "")
		.trim()
		.replace(/^['"]|['"]$/g, "")
		.replace(/^!/, "");
	if (value === "") return false;
	if (/^\$\{\{.*\}\}$/.test(value)) return false; // step output: checked where it is produced
	const normal = value.replace(/\\/g, "/").replace(/^\.\//, "");
	if (/\.(db|db-wal|db-shm|sqlite3?|sql|dump|bak)(\*|$)/i.test(normal)) return true;
	if (/(^|[/_.-])(backups?|dumps?)([/_.*-]|$)/i.test(normal)) return true;
	// Broad paths would sweep up .release/backups/ or a stray .db.
	if (/^(\.|\*|\*\*|\*\*\/\*|\.release|\.release\/\*\*?|\.release\/)$/.test(normal)) return true;
	return false;
}

/** Lines of a workflow command that export or print database content. */
const FORBIDDEN_RUN_PATTERNS = [
	{ re: /\bturso\s+db\s+export\b/i, why: "turso db export (CI uses Turso branches, never files)" },
	{ re: /(^|[\s"'])\.dump\b/i, why: "SQL .dump" },
	{ re: /\b(pg_dump|mysqldump|sqlite3\s+\S+\s+\.dump)\b/i, why: "database dump tool" },
	{
		re: /\b(cat|type|Get-Content|gc)\b[^\n]*\.(db|sqlite3?|dump)\b/i,
		why: "printing a database file",
	},
	{
		re: /\.release\/backups\/[^\s"'|]*[^\n]*GITHUB_STEP_SUMMARY|GITHUB_STEP_SUMMARY[^\n]*\.release\/backups\//i,
		why: "backup files in the job summary",
	},
];

/**
 * Find violations in one workflow file's text.
 * @returns {{line:number, why:string, text:string}[]}
 */
export function findWorkflowViolations(text) {
	const lines = String(text).split(/\r?\n/);
	const violations = [];

	// 1. upload/cache step paths. A step starts at "- " list items; scan its "uses" and "path".
	const stepStarts = [];
	lines.forEach((line, index) => {
		if (/^\s*-\s+(name|uses|run|id|if|with|env|shell|working-directory|continue-on-error|timeout-minutes)\s*:/.test(line)) {
			stepStarts.push(index);
		}
	});
	stepStarts.push(lines.length);
	for (let s = 0; s < stepStarts.length - 1; s++) {
		const start = stepStarts[s];
		const end = stepStarts[s + 1];
		const chunk = lines.slice(start, end);
		const usesLine = chunk.find((l) => /^\s*(-\s+)?uses\s*:/.test(l));
		if (!usesLine) continue;
		const uses = usesLine.replace(/^\s*(-\s+)?uses\s*:\s*/, "").replace(/\s+#.*$/, "").trim().replace(/^['"]|['"]$/g, "");
		if (!UPLOAD_OR_CACHE_ACTION.test(uses)) continue;
		for (let i = 0; i < chunk.length; i++) {
			const m = chunk[i].match(/^(\s*)path\s*:\s*(.*)$/);
			if (!m) continue;
			const indent = m[1].length;
			const inline = m[2].replace(/\s+#.*$/, "").trim();
			const values = [];
			if (/^[|>][-+]?$/.test(inline)) {
				for (let j = i + 1; j < chunk.length; j++) {
					const next = chunk[j];
					if (next.trim() === "") continue;
					if (next.match(/^(\s*)/)[1].length <= indent) break;
					values.push({ value: next.trim(), line: start + j + 1 });
				}
			} else {
				values.push({ value: inline, line: start + i + 1 });
			}
			for (const v of values) {
				if (isForbiddenStoredPath(v.value)) {
					violations.push({ line: v.line, why: `${uses} stores a backup/database-like path`, text: v.value });
				}
			}
		}
	}

	// 2. commands that export/print database content (comments ignored).
	lines.forEach((line, index) => {
		if (/^\s*#/.test(line)) return;
		for (const p of FORBIDDEN_RUN_PATTERNS) {
			if (p.re.test(line)) violations.push({ line: index + 1, why: p.why, text: line.trim() });
		}
	});
	return violations;
}

/** Tracked files that must never be in git. */
export function findTrackedFileViolations(trackedPaths) {
	const bad = [];
	for (const raw of trackedPaths) {
		const p = raw.replace(/\\/g, "/");
		if (/\.(db|db-wal|db-shm|sqlite3?|dump|bak)$/i.test(p)) {
			bad.push({ path: p, why: "database/dump file" });
		} else if (p.startsWith(".release/backups/") && !/\.(sh|ps1|md)$/i.test(p)) {
			bad.push({ path: p, why: "only scripts/docs may live in .release/backups/" });
		} else if (/\.sql$/i.test(p) && !/^infra\/[\w-]+-database\/(migrations|seeds)\/[^/]+\.sql$/.test(p)) {
			bad.push({ path: p, why: ".sql outside infra/*-database/{migrations,seeds}/ (possible dump)" });
		}
	}
	return bad;
}

function main() {
	const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
	const workflowDir = path.join(repoRoot, ".github", "workflows");
	let failures = 0;
	const files = readdirSync(workflowDir).filter((f) => /\.ya?ml$/i.test(f)).sort();
	for (const file of files) {
		const found = findWorkflowViolations(readFileSync(path.join(workflowDir, file), "utf8"));
		for (const v of found) {
			failures++;
			console.error(`::error file=.github/workflows/${file},line=${v.line}::Backups are never public: ${v.why}: ${v.text}`);
		}
	}
	const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf8" })
		.split("\0")
		.filter(Boolean);
	for (const v of findTrackedFileViolations(tracked)) {
		failures++;
		console.error(`::error file=${v.path}::Backups are never public: tracked ${v.why}`);
	}
	if (failures > 0) {
		console.error(`FAIL: ${failures} backup-exposure violation(s). See web/docs/DEPLOY.md § Backups are never public.`);
		process.exit(1);
	}
	console.log(`ok: ${files.length} workflow(s) and ${tracked.length} tracked file(s); no backup/database exposure.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main();
}
